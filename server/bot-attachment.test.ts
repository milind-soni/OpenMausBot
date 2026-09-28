// bot-attachment.ts: what a bot may hand to the chat, from where, and as what.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// attachments.ts reads DATA_DIR at import time.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-bot-attachment-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");
const { attachForTurn, guestWorkspaceToHost, saveBotAttachment } = await import("./bot-attachment.ts");
const { ATTACHMENTS_DIR } = await import("./attachments.ts");

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
    // A private copy in the attachment store, not the bot's own file.
    expect(saved.attachment.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(readFileSync(saved.attachment.path)).toEqual(bytes);
    if (saved.attachment.kind === "file") expect(saved.attachment.name.toLowerCase()).toBe(name.toLowerCase());
  });

  it("reads a file from the VM guest workspace through its host mount", async () => {
    writeFileSync(join(VM_HOME, "reports", "nekoneko.pdf"), "%PDF-1.4 fake");
    const saved = await saveBotAttachment({
      path: "/home/cua/workspace/reports/nekoneko.pdf",
      name: "決算書.pdf",
      roots: [WORK],
      guest: { root: "/home/cua/workspace", host: VM_HOME },
    });
    expect(saved.attachment).toMatchObject({ kind: "file", mime: "application/pdf", name: "決算書.pdf" });
    expect(readFileSync(saved.attachment.path, "utf8")).toBe("%PDF-1.4 fake");
  });

  it("does not let a guest path or a name reach outside its folder", async () => {
    writeFileSync(join(DATA_ROOT, "secret.pdf"), "secret");
    const guest = { root: "/home/cua/workspace", host: VM_HOME };
    await expect(saveBotAttachment({ path: "/home/cua/workspace/../../secret.pdf", roots: [WORK], guest })).rejects.toMatchObject({ status: 404 });
    await expect(saveBotAttachment({ path: join(DATA_ROOT, "secret.pdf"), roots: [WORK] })).rejects.toMatchObject({ status: 403 });
    // A path in the display name is reduced to its last segment.
    writeFileSync(join(WORK, "plain.txt"), "hello");
    const saved = await saveBotAttachment({ path: "plain.txt", name: "../../evil/notes.txt", roots: [WORK] });
    expect(saved.attachment).toMatchObject({ kind: "file", name: "notes.txt" });
  });

  it("names what is supported when the type is not", async () => {
    for (const name of ["page.html", "logo.svg", "run.exe", "bundle.zip", "noextension"]) {
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
    // Nothing has finished, yet only three may even start copying; the rest are refused at once.
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
