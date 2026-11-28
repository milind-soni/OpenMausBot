import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync, rmSync, readdirSync } from "node:fs";
import { link, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { collectChatAttachments, fetchChatAttachment, listChatAttachments, type AttachmentFetchScope } from "./chat-attachment-fetch.ts";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "attachment-fetch-")); scratch.push(root);
  const store = join(root, "store"), workspace = join(root, "workspace"); mkdirSync(store); mkdirSync(workspace);
  const ref = "12345678-1234-4234-8234-123456789abc.png", path = join(store, ref);
  writeFileSync(path, "image bytes", { mode: 0o600 });
  const scope: AttachmentFetchScope = { attachmentStore: store, workspace, guestRoot: "/home/cua/workspace", botId: "bot-a", threadId: "thread-a", maxBytes: 1000, isActive: () => true, attachments: [{ path, mime: "image/png", name: "图片.png" }] };
  return { root, ref, scope, path };
}
it.skipIf(process.platform !== "linux")("copies into a readable default folder, reuses identical bytes, and preserves edited copies", async () => {
  const { scope, ref, path } = fixture();
  const a = await fetchChatAttachment(scope, ref);
  expect(a).toMatchObject({ name: "图片.png", reused: false, size: 11 });
  const local = join(scope.workspace, "attachments/inbox/bot-a/thread-a", ref);
  expect(a.local_path).toBe(`/home/cua/workspace/attachments/inbox/bot-a/thread-a/${ref}`);
  expect(statSync(local).mode & 0o777).toBe(0o644);
  expect(statSync(local).ino).not.toBe(statSync(path).ino);
  expect((await fetchChatAttachment(scope, ref)).reused).toBe(true);
  writeFileSync(local, "edited");
  const b = await fetchChatAttachment(scope, ref);
  expect(b.reused).toBe(false); expect(b.local_path).not.toBe(a.local_path);
  expect(readFileSync(local, "utf8")).toBe("edited"); expect(readFileSync(path, "utf8")).toBe("image bytes");
});
it.skipIf(process.platform !== "linux")("supports relative destination directories and denies traversal, symlinks and foreign attachments", async () => {
  const { scope, ref, root } = fixture();
  expect((await fetchChatAttachment(scope, ref, "wechat-communication/files")).local_path).toBe(`/home/cua/workspace/wechat-communication/files/${ref}`);
  for (const dir of ["/tmp", "../escape", "a/../../outside", "a\\..\\b", "C:/tmp", "", "a//b"]) await expect(fetchChatAttachment(scope, ref, dir)).rejects.toThrow();
  mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(scope.workspace, "link"));
  await expect(fetchChatAttachment(scope, ref, "link/new")).rejects.toThrow();
  await expect(fetchChatAttachment({ ...scope, attachments: [] }, ref)).rejects.toThrow("not available");
  await expect(fetchChatAttachment(scope, "../" + ref)).rejects.toThrow();
  symlinkSync(join(scope.attachmentStore, ref), join(scope.attachmentStore, "link.png"));
  expect(await listChatAttachments(scope.attachmentStore, [{ path: join(scope.attachmentStore, "link.png"), mime: "image/png" }])).toEqual([]);
});
it.skipIf(process.platform !== "linux")("checks size and produces isolated default destinations for different conversations", async () => {
  const { scope, ref } = fixture();
  await expect(fetchChatAttachment({ ...scope, maxBytes: 1 }, ref)).rejects.toThrow("size limit");
  expect((await fetchChatAttachment({ ...scope, threadId: "other" }, ref)).local_path).toContain("/bot-a/other/");
});

it.skipIf(process.platform !== "linux").each(["a".repeat(237) + ".png", "a." + "x".repeat(239)])("bounds collision filenames for %s", async (ref) => {
  const { scope } = fixture();
  const path = join(scope.attachmentStore, ref);
  writeFileSync(path, "original");
  scope.attachments = [{ path, mime: "image/png" }];
  const first = await fetchChatAttachment(scope, ref);
  expect(basename(first.local_path)).toBe(ref);
  expect((await fetchChatAttachment(scope, ref)).reused).toBe(true);
  const local = join(scope.workspace, "attachments/inbox/bot-a/thread-a", ref);
  writeFileSync(local, "edited");
  vi.mocked(link).mockImplementationOnce(async (_source, destination) => {
    writeFileSync(destination, "concurrent file");
    throw Object.assign(new Error("already exists"), { code: "EEXIST" });
  });
  const copy = await fetchChatAttachment(scope, ref);
  const name = basename(copy.local_path);
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
  expect(copy.reused).toBe(false);
  expect(readFileSync(join(scope.workspace, "attachments/inbox/bot-a/thread-a", name), "utf8")).toBe("original");
  expect(readFileSync(local, "utf8")).toBe("edited");
  expect(readFileSync(path, "utf8")).toBe("original");
});

it.skipIf(process.platform !== "linux")("lists and exports text-tag attachments while retaining audio and parked files", async () => {
  const { scope, root } = fixture();
  const pdf = join(scope.attachmentStore, "calendar.pdf"), image = join(scope.attachmentStore, "calendar.png");
  const audio = join(scope.attachmentStore, "voice.mp3"), parked = join(scope.attachmentStore, "generated.png");
  const outside = join(root, "outside.pdf"), hidden = join(scope.attachmentStore, "hidden.pdf");
  for (const path of [pdf, image, audio, parked, outside, hidden]) writeFileSync(path, "fixture bytes");
  scope.attachments = collectChatAttachments([
    { role: "user", text: `<attached-file path="${pdf}" name="agenda.pdf" />\n<attached-image path="${image}" name="photo.png" />\n<attached-file path="${outside}" name="outside.pdf" />` },
    { role: "bot", text: "", attachments: [{ kind: "audio", path: audio, mime: "audio/mpeg" }] },
    { role: "bot", text: `<attached-file path="${hidden}" name="hidden.pdf" />` },
  ], [{ path: parked, mime: "image/png" }]);
  const files = await listChatAttachments(scope.attachmentStore, scope.attachments);
  expect(files.map((file) => file.attachment_ref).sort()).toEqual(["calendar.pdf", "calendar.png", "generated.png", "voice.mp3"]);
  expect(files.find((file) => file.attachment_ref === "calendar.pdf")).toMatchObject({ name: "agenda.pdf", mime: "application/pdf" });
  expect(files.find((file) => file.attachment_ref === "calendar.png")?.mime).toBe("image/png");
  expect(files.find((file) => file.attachment_ref === "voice.mp3")?.mime).toBe("audio/mpeg");
  expect((await fetchChatAttachment(scope, "calendar.pdf")).local_path).toContain("calendar.pdf");
  await expect(fetchChatAttachment(scope, "outside.pdf")).rejects.toThrow("not available");
  await expect(fetchChatAttachment(scope, "hidden.pdf")).rejects.toThrow("not available");
});

it.skipIf(process.platform !== "linux")("yields to other requests during a large export and stops when ownership is revoked", async () => {
  const { scope, ref, path } = fixture();
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024, 7));
  scope.maxBytes = 16 * 1024 * 1024;
  let active = true, yielded = false;
  scope.isActive = () => active;
  const pending = fetchChatAttachment(scope, ref);
  setImmediate(() => { yielded = true; active = false; });
  await expect(pending).rejects.toThrow("no longer owns");
  expect(yielded).toBe(true);
  expect(readdirSync(scope.workspace)).toEqual([]);
  scope.isActive = () => true;
  let finished = false, tickedBeforeCompletion = false;
  const complete = fetchChatAttachment(scope, ref).then((result) => { finished = true; return result; });
  setImmediate(() => { tickedBeforeCompletion = !finished; });
  const result = await complete;
  expect(tickedBeforeCompletion).toBe(true);
  expect(result.size).toBe(8 * 1024 * 1024);
});

it.skipIf(process.platform !== "linux")("removes its copy if ownership is lost during asynchronous publication", async () => {
  const { scope, ref } = fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let active = true;
  scope.isActive = () => active;
  vi.mocked(link).mockImplementationOnce(async (source, destination) => {
    await actual.link(source, destination);
    active = false;
  });
  await expect(fetchChatAttachment(scope, ref)).rejects.toThrow("no longer owns");
  expect(readdirSync(join(scope.workspace, "attachments/inbox/bot-a/thread-a"))).toEqual([]);
});

it.skipIf(process.platform !== "linux")("bounds bulk reads and lets the event loop run between chunks", async () => {
  const { scope, ref, path } = fixture();
  writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 9));
  scope.maxBytes = 4 * 1024 * 1024;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let reads = 0, largest = 0, yieldedDuringReads = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (String(args[0]).endsWith(ref)) {
      const original = file.read.bind(file);
      file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        reads++;
        largest = Math.max(largest, length);
        if (reads === 1) setImmediate(() => { yieldedDuringReads = true; });
        return original(buffer, offset, length, position);
      }) as typeof file.read;
    }
    return file;
  });
  try {
    await fetchChatAttachment(scope, ref);
    expect(reads).toBeGreaterThan(1);
    expect(largest).toBeLessThanOrEqual(256 * 1024);
    expect(yieldedDuringReads).toBe(true);
  } finally { vi.mocked(open).mockImplementation(actual.open); }
});

it.skipIf(process.platform !== "linux")("cleans the partial file when ownership is revoked during a write", async () => {
  const { scope, ref } = fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let active = true;
  scope.isActive = () => active;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (String(args[0]).endsWith(".partial")) {
      const original = file.write.bind(file);
      file.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await original(buffer, offset, length, position);
        active = false;
        return result;
      }) as typeof file.write;
    }
    return file;
  });
  try {
    await expect(fetchChatAttachment(scope, ref)).rejects.toThrow("no longer owns");
    expect(readdirSync(join(scope.workspace, "attachments/inbox/bot-a/thread-a"))).toEqual([]);
  } finally { vi.mocked(open).mockImplementation(actual.open); }
});
