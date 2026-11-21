import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// attachments.ts reads DATA_DIR at import time.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-bot-attachment-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");
const { attachForTurn, contentUploadId, deliveredCopy, guestWorkspaceToHost, saveBotAttachment } = await import("./bot-attachment.ts");
const { ATTACHMENTS_DIR, FILE_MAX_BYTES, PREVIEW_MAX_BYTES } = await import("./attachments.ts");

const WORK = join(DATA_ROOT, "work");
const VM_HOME = join(DATA_ROOT, "vm-home");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);

beforeAll(() => {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(VM_HOME, "reports"), { recursive: true });
});
afterAll(() => rmSync(DATA_ROOT, { recursive: true, force: true }));

describe("guestWorkspaceToHost", () => {
  const guest = "/home/cua/workspace";
  const host = join("C:", "vm-home");

  it("maps a guest path and a file:// URL onto the bind-mounted host directory", () => {
    expect(guestWorkspaceToHost("/home/cua/workspace/reports/q3.pdf", guest, host)).toBe(join(host, "reports", "q3.pdf"));
    expect(guestWorkspaceToHost("file:///home/cua/workspace/a%20b.mp3", guest, host)).toBe(join(host, "a b.mp3"));
  });

  it("refuses anything that is not a file inside the guest workspace", () => {
    for (const bad of [
      "/home/cua/workspace",
      "/home/cua/workspace/",
      "/home/cua/workspace/../.ssh/id_rsa",
      "/home/cua/workspace/a/../../other",
      "/home/cua/other/file.pdf",
      "/etc/passwd",
      "relative/file.pdf",
      "file:///etc/passwd",
      "",
    ]) {
      expect(guestWorkspaceToHost(bad, guest, host), bad).toBeNull();
    }
  });
});

describe("saveBotAttachment", () => {
  const cases: Array<[string, string, "image" | "file", string]> = [
    ["chart.png", "png", "image", "image/png"],
    ["photo.jpeg", "jpeg", "image", "image/jpeg"],
    ["anim.gif", "gif", "image", "image/gif"],
    ["report.pdf", "pdf", "file", "application/pdf"],
    ["clip.mp4", "mp4", "file", "video/mp4"],
    ["song.mp3", "mp3", "file", "audio/mpeg"],
    ["deck.pptx", "pptx", "file", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["book.xlsx", "xlsx", "file", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["table.csv", "csv", "file", "text/csv"],
  ];

  it.each(cases)("attaches %s as a %s", async (name, _label, kind, mime) => {
    const bytes = kind === "image" ? PNG : Buffer.from(`bytes of ${name}`);
    writeFileSync(join(WORK, name), bytes);
    const saved = await saveBotAttachment({ path: name, roots: [WORK] });
    expect(saved.attachment.kind).toBe(kind);
    expect(saved.attachment.mime).toBe(mime);
    expect(saved.bytes).toBe(bytes.byteLength);
    expect(saved.attachment.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(readFileSync(saved.attachment.path)).toEqual(bytes);
    if (saved.attachment.kind === "file") expect(saved.attachment.name.toLowerCase()).toBe(name.toLowerCase());
    // The desktop app shows the original in its folder, not the copy.
    expect(saved.attachment).toMatchObject({ source: realpathSync.native(join(WORK, name)) });
  });

  it.each(["report#1.csv", "growth 20%.csv", "report%20one.pdf"])("attaches the literal source path %s", async (name) => {
    const source = join(WORK, name);
    writeFileSync(source, `contents of ${name}`);
    for (const path of [name, source, pathToFileURL(source).href]) {
      const saved = await saveBotAttachment({ path, roots: [WORK] });
      expect(saved.attachment).toMatchObject({ name, source: realpathSync.native(source) });
      expect(readFileSync(saved.attachment.path, "utf8")).toBe(`contents of ${name}`);
    }
  });

  it("reads a file from the VM guest workspace through its host mount", async () => {
    writeFileSync(join(VM_HOME, "reports", "nekoneko.pdf"), "%PDF-1.4 fake");
    const saved = await saveBotAttachment({
      path: "/home/cua/workspace/reports/nekoneko.pdf",
      name: "決算書.pdf",
      roots: [WORK],
      guest: { root: "/home/cua/workspace", host: VM_HOME },
    });
    expect(saved.attachment).toMatchObject({ kind: "file", mime: "application/pdf", name: "決算書.pdf",
      source: realpathSync.native(join(VM_HOME, "reports", "nekoneko.pdf")) });
    expect(readFileSync(saved.attachment.path, "utf8")).toBe("%PDF-1.4 fake");
  });

  it("preserves filename characters after mapping a guest file URL to the host", async () => {
    const name = "forecast%20#1.csv";
    const source = join(VM_HOME, "reports", name);
    writeFileSync(source, "month,total\nJanuary,100\n");
    for (const path of [`/home/cua/workspace/reports/${name}`, `file:///home/cua/workspace/reports/${encodeURIComponent(name)}`]) {
      const saved = await saveBotAttachment({ path, roots: [WORK], guest: { root: "/home/cua/workspace", host: VM_HOME } });
      expect(saved.attachment).toMatchObject({ name, source: realpathSync.native(source) });
      expect(readFileSync(saved.attachment.path, "utf8")).toBe("month,total\nJanuary,100\n");
    }
  });

  it("attaches a VM video over the preview size, up to the same limit a person's upload has", async () => {
    // A bot on a VM has no link to fall back on: attaching is the only way its video reaches the chat.
    const guest = { root: "/home/cua/workspace", host: VM_HOME };
    const reel = join(VM_HOME, "reports", "reel.mp4");
    writeFileSync(reel, "x");
    truncateSync(reel, PREVIEW_MAX_BYTES + 1);
    const saved = await saveBotAttachment({ path: "/home/cua/workspace/reports/reel.mp4", roots: [WORK], guest });
    expect(saved).toMatchObject({ bytes: PREVIEW_MAX_BYTES + 1, attachment: { kind: "file", mime: "video/mp4", name: "reel.mp4" } });
    truncateSync(reel, FILE_MAX_BYTES + 1);
    await expect(saveBotAttachment({ path: "/home/cua/workspace/reports/reel.mp4", roots: [WORK], guest }))
      .rejects.toMatchObject({ status: 413, code: "file_too_large", errorParams: { limit: "100 MB", name: "reel.mp4" } });
    rmSync(reel);
  });

  it("does not let a guest path or a name reach outside its folder", async () => {
    writeFileSync(join(DATA_ROOT, "secret.pdf"), "secret");
    const guest = { root: "/home/cua/workspace", host: VM_HOME };
    await expect(saveBotAttachment({ path: "/home/cua/workspace/../../secret.pdf", roots: [WORK], guest })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotAttachment({ path: join(DATA_ROOT, "secret.pdf"), roots: [WORK] })).rejects.toMatchObject({ status: 403 });
    writeFileSync(join(WORK, "plain.txt"), "hello");
    const saved = await saveBotAttachment({ path: "plain.txt", name: "../../evil/notes.txt", roots: [WORK] });
    expect(saved.attachment).toMatchObject({ kind: "file", name: "notes.txt" });
  });

  it("names what is supported when the type is not", async () => {
    for (const name of ["page.html", "logo.svg", "run.exe", "bundle.cab", "data.tar.zst", "noextension"]) {
      writeFileSync(join(WORK, name), "x");
      await expect(saveBotAttachment({ path: name, roots: [WORK] }), name).rejects.toMatchObject({
        status: 415,
        message: expect.stringContaining("Supported:"),
      });
    }
  });

  it("rejects a missing path and an empty request", async () => {
    await expect(saveBotAttachment({ path: "nope.pdf", roots: [WORK] })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotAttachment({ path: "  ", roots: [WORK] })).rejects.toMatchObject({ status: 400 });
    expect(existsSync(ATTACHMENTS_DIR)).toBe(true);
  });
});

describe("saveBotAttachment by content", () => {
  it("keeps the same bytes once under a name made from them, whatever the file is called, and says when it was already there", async () => {
    writeFileSync(join(WORK, "passed.csv"), "a,b\n1,2\n");
    writeFileSync(join(WORK, "passed-again.csv"), "a,b\n1,2\n");
    writeFileSync(join(WORK, "other.csv"), "a,b\n3,4\n");
    writeFileSync(join(WORK, "passed.png"), PNG);
    const first = await saveBotAttachment({ path: "passed.csv", roots: [WORK], byContent: true });
    const again = await saveBotAttachment({ path: "passed-again.csv", roots: [WORK], byContent: true });
    const other = await saveBotAttachment({ path: "other.csv", roots: [WORK], byContent: true });
    expect(first.fresh).toBe(true);
    expect(again).toMatchObject({ fresh: false, sha256: first.sha256, attachment: { path: first.attachment.path, name: "passed-again.csv" } });
    expect(other.attachment.path).not.toBe(first.attachment.path);
    expect(readFileSync(first.attachment.path, "utf8")).toBe("a,b\n1,2\n");
    const picture = await saveBotAttachment({ path: "passed.png", roots: [WORK], byContent: true });
    expect(await saveBotAttachment({ path: "passed.png", roots: [WORK], byContent: true })).toMatchObject({ fresh: false, attachment: { kind: "image", path: picture.attachment.path } });
    const plain = await saveBotAttachment({ path: "passed.csv", roots: [WORK] });
    expect(plain.attachment.path).not.toBe(first.attachment.path);
    expect(plain).not.toHaveProperty("fresh");
  });

  it("keeps the same bytes under another file type as another stored file, instead of refusing them", async () => {
    writeFileSync(join(WORK, "notes.md"), "# the same words\n");
    writeFileSync(join(WORK, "notes.txt"), "# the same words\n");
    const markdown = await saveBotAttachment({ path: "notes.md", roots: [WORK], byContent: true });
    const text = await saveBotAttachment({ path: "notes.txt", roots: [WORK], byContent: true });
    expect(text.sha256).toBe(markdown.sha256);
    expect(text.fresh).toBe(true);
    expect(text.attachment.path).not.toBe(markdown.attachment.path);
    expect(markdown.attachment.path.endsWith(".md")).toBe(true);
    expect(text.attachment.path.endsWith(".txt")).toBe(true);
    expect((await saveBotAttachment({ path: "notes.md", roots: [WORK], byContent: true })).fresh).toBe(false);
  });

  it("names the stored file with this install's key, so the name cannot be worked out from the bytes", async () => {
    writeFileSync(join(WORK, "known.csv"), "bytes someone else also holds\n");
    const saved = await saveBotAttachment({ path: "known.csv", roots: [WORK], byContent: true });
    const stored = saved.attachment.path.split(/[\\/]/).at(-1)!;
    expect(stored).toBe(`${contentUploadId(saved.sha256!, ".csv")}.csv`);
    expect(stored).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.csv$/);
    expect(contentUploadId(saved.sha256!, ".csv", Buffer.alloc(32))).not.toBe(contentUploadId(saved.sha256!, ".csv"));
    expect(stored).not.toContain(saved.sha256!.slice(0, 8));
    expect(readFileSync(join(ATTACHMENTS_DIR, "..", "attachment-names.key")).byteLength).toBe(32);
  });

  it("lets exactly one of two saves of the same new bytes be the one that stored them", async () => {
    writeFileSync(join(WORK, "twice.csv"), "saved twice at once\n");
    const both = await Promise.all([1, 2, 3].map(() => saveBotAttachment({ path: "twice.csv", roots: [WORK], byContent: true })));
    expect(both.map((saved) => saved.fresh).sort()).toEqual([false, false, true]);
    expect(new Set(both.map((saved) => saved.attachment.path)).size).toBe(1);
  });
});

describe("saveBotAttachment for an archive", () => {
  // Typed by the name's last extension, like a person's upload: build.tar.gz is a .gz.
  const archives: Array<[string, string, string]> = [
    ["project.zip", "application/zip", ".zip"],
    ["photos.rar", "application/vnd.rar", ".rar"],
    ["dump.7z", "application/x-7z-compressed", ".7z"],
    ["site.tar", "application/x-tar", ".tar"],
    ["log.gz", "application/gzip", ".gz"],
    ["src.tgz", "application/x-compressed-tar", ".tgz"],
    ["data.bz2", "application/x-bzip2", ".bz2"],
    ["db.xz", "application/x-xz", ".xz"],
    ["build.tar.gz", "application/gzip", ".gz"],
    ["BUNDLE.ZIP", "application/zip", ".zip"],
    ["Release.TAR.GZ", "application/gzip", ".gz"],
  ];

  it.each(archives)("attaches %s as a plain file, stored as sent", async (name, mime, extension) => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`not unpacked: ${name}`)]);
    writeFileSync(join(WORK, name), bytes);
    const saved = await saveBotAttachment({ path: name, roots: [WORK] });
    expect(saved.attachment).toMatchObject({ kind: "file", mime });
    if (saved.attachment.kind === "file") expect(saved.attachment.name.toLowerCase()).toBe(name.toLowerCase());
    expect(saved.attachment.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.attachment.path.endsWith(extension)).toBe(true);
    expect(readFileSync(saved.attachment.path)).toEqual(bytes);
    expect(saved.bytes).toBe(bytes.byteLength);
  });

  it("keeps the file size limit and the folder rules", async () => {
    const big = join(WORK, "huge.zip");
    writeFileSync(big, "PK");
    truncateSync(big, FILE_MAX_BYTES + 1);
    await expect(saveBotAttachment({ path: "huge.zip", roots: [WORK] })).rejects.toMatchObject({ status: 413, code: "file_too_large" });
    rmSync(big);
    writeFileSync(join(DATA_ROOT, "outside.zip"), "PK");
    await expect(saveBotAttachment({ path: join(DATA_ROOT, "outside.zip"), roots: [WORK] })).rejects.toMatchObject({ status: 403 });
    await expect(saveBotAttachment({ path: "../outside.zip", roots: [WORK] })).rejects.toMatchObject({ status: 403 });
  });
});

describe("saveBotAttachment for a file a turn saved outside its folders", () => {
  // Where a person might ask for output: outside every root, not hidden.
  const DESIGNS = join(DATA_ROOT, "Desktop", "designs", "2026-10-08_News");
  const refuse = [process.env.OMB_DATA_DIR!];
  const hourAgo = () => new Date(Date.now() - 3_600_000);
  beforeAll(() => mkdirSync(DESIGNS, { recursive: true }));

  it("copies it into the attachment store and leaves the original where it is", async () => {
    const since = Date.now();
    const source = join(DESIGNS, "00_غلاف.jpg");
    writeFileSync(source, "jpeg-bytes");
    // Bots on macOS write the URL unencoded; Windows needs a real file URL.
    const href = process.platform === "win32" ? pathToFileURL(source).href : `file://${source}`;
    const saved = await saveBotAttachment({ path: href, roots: [WORK], savedThisTurn: { since, refuse } });
    expect(saved.attachment).toMatchObject({ kind: "image", mime: "image/jpeg", name: "00_غلاف.jpg", source: realpathSync.native(source) });
    expect(saved.attachment.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(readFileSync(saved.attachment.path, "utf8")).toBe("jpeg-bytes");
    expect(readFileSync(source, "utf8")).toBe("jpeg-bytes");
  });

  it("preserves literal filename characters in a file saved outside the workspace", async () => {
    const since = Date.now();
    const source = join(DESIGNS, "draft#1.pdf");
    writeFileSync(source, "pdf-bytes");
    const saved = await saveBotAttachment({ path: source, roots: [WORK], savedThisTurn: { since, refuse } });
    expect(saved.attachment).toMatchObject({ name: "draft#1.pdf", source: realpathSync.native(source) });
    expect(readFileSync(saved.attachment.path, "utf8")).toBe("pdf-bytes");
  });

  it("stays roots only without the grant, for a VM turn, and for a relative path", async () => {
    const since = Date.now();
    writeFileSync(join(DESIGNS, "fresh.pdf"), "%PDF-fresh");
    const refusal = { status: 403, code: "outside_workspace" };
    await expect(saveBotAttachment({ path: join(DESIGNS, "fresh.pdf"), roots: [WORK] })).rejects.toMatchObject(refusal);
    await expect(saveBotAttachment({
      path: join(DESIGNS, "fresh.pdf"),
      roots: [WORK],
      guest: { root: "/home/cua/workspace", host: VM_HOME },
      savedThisTurn: { since, refuse },
    })).rejects.toMatchObject(refusal);
    await expect(saveBotAttachment({ path: "../Desktop/designs/2026-10-08_News/fresh.pdf", roots: [WORK], savedThisTurn: { since, refuse } }))
      .rejects.toMatchObject(refusal);
  });

  it("refuses a file that was not written during this turn", async () => {
    const old = join(DESIGNS, "last-week.pdf");
    writeFileSync(old, "%PDF-old");
    utimesSync(old, hourAgo(), hourAgo());
    await expect(saveBotAttachment({ path: old, roots: [WORK], savedThisTurn: { since: Date.now(), refuse } }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining("not saved during this turn") });
  });

  it("refuses hidden folders and the app's data, however fresh", async () => {
    const since = Date.now();
    const hidden = join(DATA_ROOT, ".ssh");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "key.pdf"), "%PDF-key");
    mkdirSync(join(process.env.OMB_DATA_DIR!, "workspaces"), { recursive: true });
    writeFileSync(join(process.env.OMB_DATA_DIR!, "workspaces", "MEMORY.md"), "# private");
    for (const path of [join(hidden, "key.pdf"), join(process.env.OMB_DATA_DIR!, "workspaces", "MEMORY.md")]) {
      await expect(saveBotAttachment({ path, roots: [WORK], savedThisTurn: { since, refuse } }), path)
        .rejects.toMatchObject({ status: 403, code: "outside_workspace" });
    }
  });

  // creating a symlink needs extra rights on windows
  it.skipIf(process.platform === "win32")("refuses a fresh link into a hidden folder", async () => {
    const since = Date.now();
    const hidden = join(DATA_ROOT, ".ssh");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "linked-key.pdf"), "%PDF-key");
    symlinkSync(join(hidden, "linked-key.pdf"), join(DESIGNS, "innocent.pdf"));
    await expect(saveBotAttachment({ path: join(DESIGNS, "innocent.pdf"), roots: [WORK], savedThisTurn: { since, refuse } }))
      .rejects.toMatchObject({ status: 403, code: "outside_workspace" });
  });

  it("keeps every other check: folders, types, the size cap and a missing file in the roots", async () => {
    const since = Date.now();
    const turn = { roots: [WORK], savedThisTurn: { since, refuse } };
    await expect(saveBotAttachment({ path: DESIGNS, ...turn })).rejects.toMatchObject({ status: 400 });
    writeFileSync(join(DESIGNS, "bundle.cab"), "MSCF");
    await expect(saveBotAttachment({ path: join(DESIGNS, "bundle.cab"), ...turn })).rejects.toMatchObject({ status: 415 });
    const big = join(DESIGNS, "big.mp4");
    writeFileSync(big, "x");
    truncateSync(big, FILE_MAX_BYTES + 1);
    await expect(saveBotAttachment({ path: big, ...turn })).rejects.toMatchObject({ status: 413 });
    await expect(saveBotAttachment({ path: "nope.pdf", ...turn })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotAttachment({ path: join(DESIGNS, "nope.pdf"), ...turn })).rejects.toMatchObject({ status: 404 });
  });
});

describe("attachForTurn", () => {
  /** A copy the test finishes by hand, so timing is never a guess. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const hooks = (over: Partial<Parameters<typeof attachForTurn<string>>[2]> = {}) => {
    const published: string[] = [];
    const discarded: string[] = [];
    return {
      published,
      discarded,
      hooks: {
        save: async () => "saved",
        stillLive: () => true,
        publish: (saved: string) => { published.push(saved); },
        discard: (saved: string) => { discarded.push(saved); },
        ...over,
      },
    };
  };

  it("holds the cap under parallel calls that are all still copying", async () => {
    const turn: { attachedFiles?: number } = {};
    const copies = Array.from({ length: 6 }, () => deferred<string>());
    let started = 0;
    const seen = hooks();
    const calls = copies.map((copy, index) => attachForTurn(turn, 3, {
      ...seen.hooks,
      save: () => { started += 1; return copy.promise.then(() => `file-${index}`); },
    }));
    expect(started).toBe(3);
    expect(await Promise.all(calls.slice(3))).toEqual([{ status: "limit" }, { status: "limit" }, { status: "limit" }]);
    copies.slice(0, 3).forEach((copy) => copy.resolve("done"));
    const settled = await Promise.all(calls.slice(0, 3));
    expect(settled.map((outcome) => outcome.status)).toEqual(["attached", "attached", "attached"]);
    expect(seen.published).toHaveLength(3);
    expect(turn.attachedFiles).toBe(3);
    expect(await attachForTurn(turn, 3, seen.hooks)).toEqual({ status: "limit" });
  });

  it("gives the slot back when a copy fails, so a bad path does not use up the turn's budget", async () => {
    const turn: { attachedFiles?: number } = {};
    const seen = hooks({ save: async () => { throw Object.assign(new Error("not found"), { status: 404 }); } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(attachForTurn(turn, 2, seen.hooks)).rejects.toMatchObject({ status: 404 });
    }
    expect(turn.attachedFiles).toBe(0);
    expect(seen.discarded).toEqual([]);
    expect((await attachForTurn(turn, 2, hooks().hooks)).status).toBe("attached");
  });

  it("posts nothing and removes the copy when the turn ends while the file is being copied", async () => {
    const turn: { attachedFiles?: number } = {};
    const copy = deferred<string>();
    let live = true;
    const seen = hooks({ save: () => copy.promise, stillLive: () => live });
    const call = attachForTurn(turn, 10, seen.hooks);
    live = false; // stopped, replaced, deleted or moved mid-copy
    copy.resolve("half-second-later.pdf");
    expect(await call).toEqual({ status: "ended" });
    expect(seen.published).toEqual([]);
    expect(seen.discarded).toEqual(["half-second-later.pdf"]);
    expect(turn.attachedFiles).toBe(0);
  });

  it("removes the copy when publishing itself fails", async () => {
    const turn: { attachedFiles?: number } = {};
    const seen = hooks({ publish: () => { throw new Error("thread is gone"); } });
    await expect(attachForTurn(turn, 10, seen.hooks)).rejects.toThrow("thread is gone");
    expect(seen.discarded).toEqual(["saved"]);
    expect(turn.attachedFiles).toBe(0);
  });

  it("does not discard a copy it published", async () => {
    const seen = hooks();
    expect(await attachForTurn({}, 10, seen.hooks)).toEqual({ status: "attached", saved: "saved" });
    expect(seen.discarded).toEqual([]);
  });
});

describe("deliveredCopy", () => {
  type Message = Parameters<typeof deliveredCopy>[1];
  const bot = (id: string, parentId: string | null, extra: Partial<Message> = {}): Message =>
    ({ id, at: 1, parentId, role: "bot", kind: "text", text: "", ...extra }) as Message;
  const photo = { kind: "image" as const, path: "/store/copy.png", mime: "image/png", name: "sideboard.png" };
  const renamed = { kind: "file" as const, path: "/store/copy.md", mime: "text/markdown; charset=utf-8", name: "团队技能包-README.md", source: "D:\\AI\\openmausbot-skills\\README.md" };
  const ask = { id: "ask", at: 1, parentId: null, role: "user", kind: "text", text: "find a sideboard" } as Message;

  it("finds the picture the reply's turn delivered under the name its inline image uses", () => {
    const attached = bot("attached", "ask", { attachments: [photo] });
    const tool = bot("tool", "attached", { kind: "activity" });
    const reply = bot("reply", "tool", { text: "![Sideboard](/tmp/sideboard.png)" });
    expect(deliveredCopy([ask, attached, tool, reply], reply, "sideboard.png")).toEqual(photo);
    expect(deliveredCopy([ask, attached, tool, reply], reply, "other.png")).toBeNull();
  });

  it("stops at the person's message, so an earlier turn's delivery is not this reply's", () => {
    const attached = bot("attached", null, { attachments: [photo] });
    const again = { ...ask, parentId: "attached" };
    const reply = bot("reply", "ask");
    expect(deliveredCopy([attached, again, reply], reply, "sideboard.png")).toBeNull();
  });

  it("counts only the reply's author, and two deliveries with one name match neither", () => {
    const by = (botId: string) => ({ from: { botId, name: botId, color: "blue" } }) as Partial<Message>;
    const peer = bot("peer", "ask", { ...by("other"), attachments: [photo] });
    const reply = bot("reply", "peer", by("me"));
    expect(deliveredCopy([ask, peer, reply], reply, "sideboard.png")).toBeNull();
    const first = bot("first", "ask", { ...by("me"), attachments: [photo] });
    const second = bot("second", "first", { ...by("me"), attachments: [{ ...photo, path: "/store/copy-2.png" }] });
    const twice = bot("twice", "second", by("me"));
    expect(deliveredCopy([ask, first, second, twice], twice, "sideboard.png")).toBeNull();
    expect(deliveredCopy([ask, first, twice], { ...twice, parentId: "first" }, "sideboard.png")).toEqual(photo);
  });

  it("finds a renamed delivery by its source path", () => {
    const attached = bot("attached", "ask", { attachments: [renamed] });
    const reply = bot("reply", "attached", { text: "[README](D:/AI/openmausbot-skills/README.md)" });
    expect(deliveredCopy([ask, attached, reply], reply, "README.md", "D:\\AI\\openmausbot-skills\\README.md")).toEqual(renamed);
  });

  it.each(["report#1.pdf", "report%20one.pdf"])("matches the literal stored source %s to its file URL", (name) => {
    const attachment = { ...renamed, source: `/reports/${name}` };
    const attached = bot("attached", "ask", { attachments: [attachment] });
    const href = `file:///reports/${encodeURIComponent(name)}`;
    const reply = bot("reply", "attached", { text: `[Report](${href})` });
    expect(deliveredCopy([ask, attached, reply], reply, name, href)).toEqual(attachment);
  });

  it("finds the same source spelled as a file:// URL or with an encoded space", () => {
    const spaced = { ...renamed, source: "D:\\AI\\openmausbot-skills\\my file.pdf", name: "团队技能包.pdf" };
    const attached = bot("attached", "ask", { attachments: [spaced] });
    const reply = bot("reply", "attached", { text: "[pdf](file:///D:/AI/openmausbot-skills/my%20file.pdf)" });
    expect(deliveredCopy([ask, attached, reply], reply, "my file.pdf", "file:///D:/AI/openmausbot-skills/my%20file.pdf")).toEqual(spaced);
  });

  it("still finds a delivery by display name when the record has no source", () => {
    const attached = bot("attached", "ask", { attachments: [photo] });
    const reply = bot("reply", "attached", { text: "![Sideboard](/tmp/sideboard.png)" });
    expect(deliveredCopy([ask, attached, reply], reply, "sideboard.png", "/tmp/sideboard.png")).toEqual(photo);
  });

  it("refuses when two deliveries share the clicked source", () => {
    const by = (botId: string) => ({ from: { botId, name: botId, color: "blue" } }) as Partial<Message>;
    const first = bot("first", "ask", { ...by("me"), attachments: [renamed] });
    const second = bot("second", "first", { ...by("me"), attachments: [{ ...renamed, path: "/store/copy-2.md" }] });
    const reply = bot("reply", "second", by("me"));
    expect(deliveredCopy([ask, first, second, reply], reply, "README.md", "D:\\AI\\openmausbot-skills\\README.md")).toBeNull();
  });

  it("ignores a different bot's delivery even when its source matches", () => {
    const by = (botId: string) => ({ from: { botId, name: botId, color: "blue" } }) as Partial<Message>;
    const peer = bot("peer", "ask", { ...by("other"), attachments: [renamed] });
    const reply = bot("reply", "peer", by("me"));
    expect(deliveredCopy([ask, peer, reply], reply, "README.md", "D:\\AI\\openmausbot-skills\\README.md")).toBeNull();
  });
});

describe("saveBotAttachment for a file attached to the conversation", () => {
  it("passes on a stored file by the name it was attached with", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const stored = join(ATTACHMENTS_DIR, "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b.md");
    writeFileSync(stored, "# Chapter 3");
    const saved = await saveBotAttachment({ path: stored, roots: [WORK], attached: () => [{ path: stored, name: "chapter-3.md" }] });
    expect(saved.attachment).toMatchObject({ kind: "file", name: "chapter-3.md" });
    expect(readFileSync(saved.attachment.path, "utf8")).toBe("# Chapter 3");
    const byLink = await saveBotAttachment({ path: pathToFileURL(stored).href, roots: [WORK], attached: () => [{ path: stored, name: "chapter-3.md" }] });
    expect(byLink.attachment).toMatchObject({ name: "chapter-3.md" });
  });

  it("opens nothing outside the attachment store, whatever a tag names, and nothing in it that was not attached", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    mkdirSync(process.env.OMB_DATA_DIR!, { recursive: true });
    const config = join(process.env.OMB_DATA_DIR!, "config.json");
    writeFileSync(config, "{\"secret\":true}");
    await expect(saveBotAttachment({ path: config, roots: [WORK], attached: () => [{ path: config, name: "config.json" }] }))
      .rejects.toMatchObject({ status: 403 });
    const other = join(ATTACHMENTS_DIR, "1c8e7b63-4d2e-4f9a-8b3c-6d7e8f9a0b1c.md");
    writeFileSync(other, "Someone else's");
    await expect(saveBotAttachment({ path: other, roots: [WORK], attached: () => [] })).rejects.toMatchObject({ status: 403 });
  });
});
