// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { link, unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, link: vi.fn(fs.link), unlink: vi.fn(fs.unlink) };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync) };
});
const realUnlink = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).unlink;
const realLink = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).link;
const realUnlinkSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).unlinkSync;
afterEach(() => {
  vi.mocked(unlink).mockReset().mockImplementation(realUnlink);
  vi.mocked(link).mockReset().mockImplementation(realLink);
  vi.mocked(unlinkSync).mockReset().mockImplementation(realUnlinkSync);
});

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-attachments-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const {
  ATTACHMENTS_DIR,
  ATTACHMENTS_MAX_BYTES,
  ATTACHMENT_PARTIAL_MAX_AGE_MS,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  __resetAttachmentAccountingForTests,
  cleanupStaleAttachmentPartials,
  deleteAttachment,
  extensionForFileMime,
  extensionForMime,
  readAttachment,
  sanitizeSharedFileName,
  saveFile,
  saveImage,
  saveImageUpload,
  validateAttachmentUploadId,
} = await import("./attachments.ts");

// The cache tracks committed bytes in memory; anything that mutates
// ATTACHMENTS_DIR directly on disk (rmSync/truncateSync/writeFileSync, all
// used below to force quota states without a real 512MiB file) must reset it
// so the next quota check rescans instead of trusting stale counts.
function resetDir() {
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  __resetAttachmentAccountingForTests();
}

const UPLOAD_A = "11111111-1111-4111-8111-111111111111";
const UPLOAD_B = "22222222-2222-4222-8222-222222222222";

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
  });

  it("makes UUID-keyed image retries idempotent without changing legacy callers", () => {
    const first = saveImage(Buffer.from("same"), "image/png", UPLOAD_A);
    const retry = saveImage(Buffer.from("same"), "image/png", UPLOAD_A.toUpperCase());
    expect(retry).toEqual(first);
    expect(readdirSync(ATTACHMENTS_DIR).filter((name) => !name.startsWith("."))).toEqual([`${UPLOAD_A}.png`]);

    expect(() => saveImage(Buffer.from("different"), "image/png", UPLOAD_A)).toThrow(/different image bytes/);
    expect(() => saveImage(Buffer.from("same"), "image/jpeg", UPLOAD_A)).toThrow(/another content type/);

    const legacyOne = saveImage(Buffer.from("same"), "image/png");
    const legacyTwo = saveImage(Buffer.from("same"), "image/png");
    expect(legacyOne.path).not.toBe(legacyTwo.path);
  });

  it("validates upload IDs before they can become filenames", () => {
    expect(validateAttachmentUploadId(UPLOAD_A.toUpperCase())).toBe(UPLOAD_A);
    for (const value of ["", "short", "../../escape", `${UPLOAD_A}.png`, "00000000-0000-0000-0000-000000000000"]) {
      expect(() => validateAttachmentUploadId(value)).toThrow(/UUID/);
    }
  });
});

describe("aggregate attachment storage", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("rejects new data at the aggregate ceiling without pruning committed attachments", () => {
    const referenced = saveImage(Buffer.from("x"), "image/png");
    truncateSync(referenced.path, ATTACHMENTS_MAX_BYTES);
    __resetAttachmentAccountingForTests();

    try {
      saveImage(Buffer.from("y"), "image/png");
      throw new Error("expected quota rejection");
    } catch (error) {
      expect(error).toMatchObject({ status: 507 });
      expect(error).toHaveProperty("message", expect.stringMatching(/storage is full/));
    }
    expect(existsSync(referenced.path)).toBe(true);
    expect(statSync(referenced.path).size).toBe(ATTACHMENTS_MAX_BYTES);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([referenced.path.split(/[\\/]/).pop()!]);
  });

  it("counts concurrent reservations so uploads cannot race past the ceiling", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 5);
    __resetAttachmentAccountingForTests();

    const first = saveFile((async function* () {
      yield Buffer.from("four");
    })(), "first.txt", "text/plain", { expectedBytes: 4 });

    expect(() => saveImage(Buffer.from("xx"), "image/png")).toThrow(/storage is full/);
    await expect(first).resolves.toMatchObject({ bytes: 4 });
  });

  it("lets an unknown-length stream use the exact space left below a reservation increment", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 2);
    __resetAttachmentAccountingForTests();

    const saved = await saveFile((async function* () {
      yield Buffer.from("a");
    })(), "last-byte.txt", "text/plain");
    expect(saved.bytes).toBe(1);
    expect(() => saveImage(Buffer.from("b"), "image/png")).not.toThrow();
  });

  it("releases reservations and removes partials after failed uploads", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 3);
    __resetAttachmentAccountingForTests();

    await expect(saveFile((async function* () {})(), "empty.txt", "text/plain", { expectedBytes: 3 }))
      .rejects.toThrow(/empty file/);
    expect(() => saveImage(Buffer.from("123"), "image/png")).not.toThrow();
    expect(readdirSync(ATTACHMENTS_DIR).every((name) => !name.endsWith(".partial"))).toBe(true);
  });

  it("cleans only stale upload partials, never committed or active-looking files", () => {
    saveImage(Buffer.from("kept"), "image/png", UPLOAD_A);
    const stale = `${ATTACHMENTS_DIR}/.openmaus-upload-${UPLOAD_A}-${UPLOAD_B}.partial`;
    const fresh = `${ATTACHMENTS_DIR}/.openmaus-upload-${UPLOAD_B}-${UPLOAD_A}.partial`;
    const unrelated = `${ATTACHMENTS_DIR}/notes.partial`;
    writeFileSync(stale, "stale");
    writeFileSync(fresh, "fresh");
    writeFileSync(unrelated, "not ours");
    const now = Date.now();
    const old = new Date(now - ATTACHMENT_PARTIAL_MAX_AGE_MS - 1_000);
    utimesSync(stale, old, old);

    expect(cleanupStaleAttachmentPartials(now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(`${ATTACHMENTS_DIR}/${UPLOAD_A}.png`)).toBe(true);
  });

  it("counts fresh crash leftovers against quota, then reclaims them once a cleanup sweep runs", () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 2);
    __resetAttachmentAccountingForTests();
    const orphan = `${ATTACHMENTS_DIR}/.openmaus-upload-${UPLOAD_A}-${UPLOAD_B}.partial`;
    writeFileSync(orphan, "xx");

    expect(() => saveImage(Buffer.from("y"), "image/png")).toThrow(/storage is full/);
    const old = new Date(Date.now() - ATTACHMENT_PARTIAL_MAX_AGE_MS - 1_000);
    utimesSync(orphan, old, old);
    // Reservation checks no longer rescan the directory on every call (that
    // was the PERF-03 hot loop); a stale partial is reclaimed by an explicit
    // cleanup sweep, not automatically on the next quota check.
    expect(cleanupStaleAttachmentPartials()).toBe(1);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
    expect(existsSync(orphan)).toBe(false);
  });

  it("reclaims an inactive partial immediately when its upload ID retries", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 3);
    __resetAttachmentAccountingForTests();
    const orphan = `${ATTACHMENTS_DIR}/.openmaus-upload-${UPLOAD_A}-${UPLOAD_B}.partial`;
    writeFileSync(orphan, "old");

    const saved = await saveFile((async function* () {
      yield Buffer.from("new");
    })(), "retry.txt", "text/plain", { uploadId: UPLOAD_A, expectedBytes: 3 });
    expect(saved.path.endsWith(`${UPLOAD_A}.txt`)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it("frees quota after deleteAttachment, without a rescan, for a file the cache already knows about", () => {
    const first = saveImage(Buffer.from("x"), "image/png");
    truncateSync(first.path, ATTACHMENTS_MAX_BYTES - 2);
    __resetAttachmentAccountingForTests();
    expect(() => saveImage(Buffer.from("yyy"), "image/png")).toThrow(/storage is full/);

    deleteAttachment(first.path);
    expect(existsSync(first.path)).toBe(false);
    const second = saveImage(Buffer.from("yyy"), "image/png");
    expect(second.bytes).toBe(3);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([second.path.split(/[\\/]/).pop()!]);
  });

  it.each([1, 2])("counts a committed upload after %i partial-cleanup failures and an idempotent retry", async (failures) => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 3);
    __resetAttachmentAccountingForTests();
    const cleanupError = Object.assign(new Error("partial file is locked"), { code: "EPERM" });
    for (let attempt = 0; attempt < failures; attempt++) {
      vi.mocked(unlink).mockRejectedValueOnce(cleanupError);
    }
    const chunks = async function* () { yield Buffer.from("xx"); };

    await expect(saveFile(chunks(), "retry.txt", "text/plain", { uploadId: UPLOAD_A }))
      .rejects.toThrow("partial file is locked");
    expect(readFileSync(join(ATTACHMENTS_DIR, `${UPLOAD_A}.txt`), "utf8")).toBe("xx");
    expect(readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith(".partial"))).toHaveLength(failures - 1);

    await expect(saveFile(chunks(), "retry.txt", "text/plain", { uploadId: UPLOAD_A }))
      .resolves.toMatchObject({ bytes: 2 });
    expect(readdirSync(ATTACHMENTS_DIR).some((name) => name.endsWith(".partial"))).toBe(false);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
    expect(() => saveImage(Buffer.from("z"), "image/png")).toThrow(/storage is full/);
  });

  it.each([1, 2])("counts an image after %i partial-cleanup failures and an idempotent retry", async (failures) => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 3);
    __resetAttachmentAccountingForTests();
    for (let attempt = 0; attempt < failures; attempt++) {
      vi.mocked(unlinkSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("partial file is locked"), { code: "EPERM" });
      });
    }

    expect(() => saveImage(Buffer.from("xx"), "image/png", UPLOAD_A)).toThrow("partial file is locked");
    expect(readFileSync(join(ATTACHMENTS_DIR, `${UPLOAD_A}.png`), "utf8")).toBe("xx");
    expect(readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith(".partial"))).toHaveLength(failures - 1);
    await expect(saveImageUpload(Buffer.from("xx"), "image/png", UPLOAD_A)).resolves.toMatchObject({ bytes: 2 });
    expect(readdirSync(ATTACHMENTS_DIR).some((name) => name.endsWith(".partial"))).toBe(false);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
    expect(() => saveImage(Buffer.from("z"), "image/png")).toThrow(/storage is full/);
  });

  it("does not count an in-flight commit twice when cleanup failure causes a rescan", async () => {
    const existing = saveImage(Buffer.from("x"), "image/png");
    truncateSync(existing.path, ATTACHMENTS_MAX_BYTES - 5);
    __resetAttachmentAccountingForTests();
    let markLinked!: () => void;
    let finishCommit!: () => void;
    const linked = new Promise<void>((resolve) => { markLinked = resolve; });
    const finishing = new Promise<void>((resolve) => { finishCommit = resolve; });
    vi.mocked(link).mockImplementationOnce(async (...args) => {
      await realLink(...args);
      markLinked();
      await finishing;
    });
    const pending = saveFile((async function* () { yield Buffer.from("xx"); })(), "pending.txt", "text/plain", {
      uploadId: UPLOAD_A, expectedBytes: 2,
    });
    try {
      await linked;
      for (let attempt = 0; attempt < 2; attempt++) {
        vi.mocked(unlinkSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("partial file is locked"), { code: "EPERM" });
        });
      }
      expect(() => saveImage(Buffer.from("x"), "image/png", UPLOAD_B)).toThrow("partial file is locked");
      // This scan sees the linked file while its commit callback is pending.
      expect(() => saveImage(Buffer.from("y"), "image/png")).toThrow(/storage is full/);
    } finally {
      finishCommit();
      await pending;
    }
    await saveImageUpload(Buffer.from("x"), "image/png", UPLOAD_B);
    expect(() => saveImage(Buffer.from("yy"), "image/png")).not.toThrow();
    expect(() => saveImage(Buffer.from("z"), "image/png")).toThrow(/storage is full/);
  });

  it("initializes correctly on a fresh process against a directory that already has files", () => {
    // No saveImage/saveFile call has happened yet in this test, so the cache
    // is still cold (__resetAttachmentAccountingForTests in the previous
    // test's afterEach already guaranteed that) — this mirrors a process
    // restart that finds attachments already on disk from a prior run.
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const preexisting = join(ATTACHMENTS_DIR, "11111111-1111-4111-8111-111111111111.png");
    writeFileSync(preexisting, "x");
    truncateSync(preexisting, ATTACHMENTS_MAX_BYTES - 2);

    expect(() => saveImage(Buffer.from("yyy"), "image/png")).toThrow(/storage is full/);
    expect(() => saveImage(Buffer.from("y"), "image/png")).not.toThrow();
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});

describe("shared files", () => {
  beforeEach(() => {
    resetDir();
  });
  afterEach(() => {
    resetDir();
  });

  it("allows useful document mimes but not executables, archives, or active markup", () => {
    expect(extensionForFileMime("text/plain; charset=utf-8")).toBe(".txt");
    expect(extensionForFileMime("application/pdf")).toBe(".pdf");
    expect(extensionForFileMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(".docx");
    expect(extensionForFileMime("application/zip")).toBeNull();
    expect(extensionForFileMime("application/x-msdownload")).toBeNull();
    expect(extensionForFileMime("application/octet-stream")).toBeNull();
    expect(extensionForFileMime("text/html")).toBeNull();
    expect(extensionForFileMime("image/svg+xml")).toBeNull();
  });

  it("sanitizes the display name and derives its extension from the mime", () => {
    expect(sanitizeSharedFileName("  Quarterly: report.exe  ", "application/pdf")).toBe("Quarterly_ report.pdf");
    expect(sanitizeSharedFileName("notes", "text/markdown")).toBe("notes.md");
    expect(() => sanitizeSharedFileName("../../secret.txt", "text/plain")).toThrow(/filename, not a path/);
    expect(() => sanitizeSharedFileName("..\\..\\secret.txt", "text/plain")).toThrow(/filename, not a path/);
    expect(() => sanitizeSharedFileName("..%2F..%2Fsecret.txt", "text/plain")).toThrow(/filename, not a path/);
    expect(() => sanitizeSharedFileName("notes.txt", "application/zip")).toThrow(/supported document/);
  });

  it("streams a file under a generated name with private permissions", async () => {
    async function* chunks() {
      yield Buffer.from("first ");
      yield Buffer.from("second");
    }
    const saved = await saveFile(chunks(), "Meeting notes.md", "Text/Markdown; charset=utf-8");
    expect(saved.name).toBe("Meeting notes.md");
    expect(saved.mime).toBe("text/markdown");
    expect(saved.bytes).toBe(12);
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path).toMatch(/[0-9a-f-]+\.md$/);
    expect(readFileSync(saved.path, "utf8")).toBe("first second");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["audio/opus", ".opus"], ["audio/ogg; codecs=opus", ".ogg"],
    ["audio/mpeg", ".mp3"], ["audio/mp4", ".m4a"],
    ["audio/x-wav", ".wav"], ["audio/aac", ".aac"],
    ["audio/flac", ".flac"], ["audio/webm", ".webm"],
  ])("stores %s audio privately and retries without duplicating it", async (mime, extension) => {
    const bytes = Buffer.from([0, 255, 1, 128, 79, 103, 103, 83]);
    const chunks = async function* () { yield bytes.subarray(0, 3); yield bytes.subarray(3); };
    const first = await saveFile(chunks(), "Voice note.opus", mime, { uploadId: UPLOAD_A });
    const again = await saveFile(chunks(), "Voice note.opus", mime, { uploadId: UPLOAD_A });
    expect(again.path).toBe(first.path);
    expect(first.path).toBe(join(ATTACHMENTS_DIR, `${UPLOAD_A}${extension}`));
    expect(first.name).toBe(`Voice note${extension}`);
    expect(readFileSync(first.path)).toEqual(bytes);
    if (process.platform !== "win32") expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([`${UPLOAD_A}${extension}`]);
  });

  it("rejects empty and oversized streams without leaving partial files", async () => {
    await expect(saveFile((async function* () {})(), "empty.txt", "text/plain")).rejects.toThrow(/empty file/);
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);

    async function* tooLarge() {
      yield Buffer.from("partial");
      yield Buffer.alloc(FILE_MAX_BYTES);
    }
    await expect(saveFile(tooLarge(), "large.pdf", "application/pdf")).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([]);
  });

  it("deduplicates concurrent and later file retries by upload ID", async () => {
    const makeChunks = async function* () {
      yield Buffer.from("same ");
      await Promise.resolve();
      yield Buffer.from("document");
    };
    const [first, concurrentRetry] = await Promise.all([
      saveFile(makeChunks(), "Report.pdf", "application/pdf", { uploadId: UPLOAD_A, expectedBytes: 13 }),
      saveFile(makeChunks(), "Report.pdf", "application/pdf", { uploadId: UPLOAD_A, expectedBytes: 13 }),
    ]);
    expect(concurrentRetry.path).toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toBe("same document");
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([`${UPLOAD_A}.pdf`]);

    await expect(saveFile((async function* () {
      yield Buffer.from("other bytes");
    })(), "Report.pdf", "application/pdf", { uploadId: UPLOAD_A }))
      .rejects.toMatchObject({ status: 409 });
    expect(readFileSync(first.path, "utf8")).toBe("same document");
  });

  it("serializes the upload ID namespace across image and document routes", async () => {
    let started!: () => void;
    let finish!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayFinish = new Promise<void>((resolve) => { finish = resolve; });
    const document = saveFile((async function* () {
      yield Buffer.from("first");
      started();
      await mayFinish;
      yield Buffer.from("second");
    })(), "race.pdf", "application/pdf", { uploadId: UPLOAD_A, expectedBytes: 11 });

    await didStart;
    const image = saveImageUpload(Buffer.from("image"), "image/png", UPLOAD_A);
    finish();
    await expect(document).resolves.toMatchObject({ bytes: 11 });
    await expect(image).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(ATTACHMENTS_DIR)).toEqual([`${UPLOAD_A}.pdf`]);
  });
});
