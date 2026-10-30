import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudSyncStore } from "./cloud-sync-store.ts";
import { copyAge, createLentCopies } from "./lent-copies.ts";
import { SharedComputers } from "./shared-computers.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const body = (result: any) => JSON.parse(result.content[0].text);
const OWNER = "cloud-home";

let dir: string;
let now: number;
let copies: ReturnType<typeof createLentCopies>;
let copy: string;
let syncId: string;
const desktop = randomUUID(), lending = randomUUID();
const notes = randomUUID(), big = randomUUID(), docs = randomUUID();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-lent-copies-"));
  now = Date.UTC(2026, 9, 27, 12);
  const store = new CloudSyncStore({ dataDir: join(dir, "data"), root: join(dir, "Synced") });
  const folder = store.register({ computerId: randomUUID(), computerName: "Ash-MBP", pcPath: "/Users/ash/Notes", name: "Notes" });
  store.close();
  syncId = folder.id;
  copy = folder.cloudPath;
  mkdirSync(join(copy, "drafts"), { recursive: true });
  writeFileSync(join(copy, "plan.md"), "the plan");
  writeFileSync(join(copy, "drafts", "intro.md"), "intro");
  copies = createLentCopies({ dataDir: join(dir, "data"), now: () => now });
  copies.report({ computerId: desktop, lendingId: lending, name: "Ash-MBP", platform: "darwin", folders: [
    { id: notes, name: "Notes", write: true, syncId },
    { id: big, name: "Photos", write: false, syncId: null, live: "too-big" },
    { id: docs, name: "Docs", write: false, syncId },
  ] });
  copies.synced(syncId);
  now += 2 * 60 * 60_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const op = (action: string, rest: Record<string, unknown> = {}) => copies.answer({ action, computer_id: lending, folder_id: notes, ...rest }, OWNER)!;

describe("how fresh a copy is", () => {
  it("says it the way a person would", () => {
    const at = Date.UTC(2026, 9, 27, 12);
    expect(copyAge(at, at + 30_000)).toBe("from just now");
    expect(copyAge(at, at + 25 * 60_000)).toBe("from 25 min ago");
    expect(copyAge(at, at + 2 * 60 * 60_000)).toBe("from 2 h ago");
    expect(copyAge(at, at + 3 * 24 * 60 * 60_000)).toBe("from 3 days ago");
    expect(copyAge(null, at)).toContain("still being copied");
  });
});

describe("a lent folder while its computer is away", () => {
  it("lists the away computer's folders for the owner only, with each copy's age, and nothing while it is online", () => {
    const away = copies.away(OWNER, []);
    expect(away.away_computers).toEqual([{ computer_id: lending, name: "Ash-MBP", device: "Mac", away: true, folders: [
      { folder_id: notes, name: "Notes", write: true, copy: "from 2 h ago" },
      { folder_id: big, name: "Photos", write: false, copy: null },
      { folder_id: docs, name: "Docs", write: false, copy: "from 2 h ago" },
    ] }]);
    expect(away.say).toContain("Their Mac Ash-MBP is away, but the folders it lends still work from the Cloud's copy");
    expect(copies.away(OWNER, [{ id: lending, name: "Ash-MBP" }])).toEqual({});
    // Lending saved again on the Mac has a new id: the same computer by name is still online.
    expect(copies.away(OWNER, [{ id: randomUUID(), name: "Ash-MBP" }])).toEqual({});
    expect(copies.away("someone-else", [])).toEqual({});
    expect(copies.answer({ action: "read_file", folder_id: notes, path: "plan.md" }, "someone-else")).toBeNull();
  });

  it("reads and lists from the copy and says how fresh it is", async () => {
    const read = body(await op("read_file", { path: "plan.md" }));
    expect(read).toMatchObject({ content: "the plan", bytes: 8, sha256: sha("the plan"), from: "the Cloud's copy, from 2 h ago" });
    expect(read.note).toContain("Their Mac is away, so this comes from the Cloud's copy (from 2 h ago)");
    expect(body(await op("read_file", { path: "./drafts/intro.md" })).content).toBe("intro");
    expect(body(await op("list_files")).entries).toEqual([{ name: "drafts", type: "directory" }, { name: "plan.md", type: "file" }]);
    expect(body(await op("list_files", { path: "drafts" })).entries).toEqual([{ name: "intro.md", type: "file" }]);
  });

  it("says a file that isn't in the copy, or a folder kept only on the computer, waits for it", async () => {
    const missing = await op("read_file", { path: "node_modules/x/index.js" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("only on their Mac");
    expect(missing.content[0].text).toContain("you'll get it when their Mac is on");
    const live = await copies.answer({ action: "read_file", computer_id: lending, folder_id: big, path: "a.jpg" }, OWNER)!;
    expect(live.isError).toBe(true);
    expect(live.content[0].text).toBe("Photos is only on their Mac: it is too big to keep a copy on the Cloud. Tell them in a few words that you'll get it when their Mac is on.");
    // Not a folder action, or not a lent folder: the usual offline answer.
    expect(copies.answer({ action: "run_command", folder_id: notes }, OWNER)).toBeNull();
    expect(copies.answer({ action: "read_file", folder_id: randomUUID(), path: "plan.md" }, OWNER)).toBeNull();
  });

  it("answers a folder only with the computer that lends it, and never hashes a file too big to read", async () => {
    const other = await copies.answer({ action: "read_file", computer_id: randomUUID(), folder_id: notes, path: "plan.md" }, OWNER)!;
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toContain("That folder is lent by Ash-MBP");
    writeFileSync(join(copy, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
    expect((await op("write_file", { path: "big.bin", content: "x" })).content[0].text).toBe("Only regular, single-link files up to 2 MiB can be shared");
  });

  it("never leaves the folder, and never follows a link", async () => {
    for (const path of ["../folders.json", "/etc/passwd", "a\\b", "drafts/../../x"]) expect((await op("read_file", { path })).isError, path).toBe(true);
    symlinkSync("/etc", join(copy, "etc"));
    const linked = await op("read_file", { path: "etc/hosts" });
    expect(linked.isError).toBe(true);
    expect(linked.content[0].text).toContain("Symbolic links");
  });

  it("stages a write to a folder lent with editing, reads it back, and refuses what a live write refuses", async () => {
    const saved = body(await op("write_file", { path: "drafts/new.md", content: "a bot's draft" }));
    expect(saved).toMatchObject({ written: true, sha256: sha("a bot's draft"), saved: "on the Cloud" });
    expect(saved.note).toContain("saved; it'll reach your Mac when it's on");
    // The copy itself is never written: the computer stays the authority.
    expect(() => readFileSync(join(copy, "drafts", "new.md"))).toThrow();
    expect(body(await op("read_file", { path: "drafts/new.md" }))).toMatchObject({ content: "a bot's draft", from: expect.stringContaining("waiting for their computer") });
    expect(body(await op("list_files", { path: "drafts" })).entries).toContainEqual({ name: "new.md", type: "file", changes_waiting: true });
    expect(copies.staged(syncId)).toEqual([{ id: expect.any(String), path: "drafts/new.md", sha256: sha("a bot's draft"), size: 13, baseSha256: null, at: now }]);
    expect(copies.away(OWNER, []).away_computers![0]).toMatchObject({ folders: expect.arrayContaining([expect.objectContaining({ folder_id: notes, changes_waiting: 1 })]) });

    expect((await op("write_file", { path: "plan.md", content: "x" })).content[0].text).toContain("Read it first");
    expect((await op("write_file", { path: "plan.md", content: "x", expected_sha256: sha("old") })).content[0].text).toBe("File changed. Read it again before overwriting it.");
    expect((await op("write_file", { path: ".git/config", content: "x" })).content[0].text).toContain("Files inside .git");
    expect((await op("write_file", { path: "big.bin", content: Buffer.alloc(300 * 1024).toString("base64"), encoding: "base64" })).content[0].text).toContain("256 KiB");
    expect((await op("write_file", { path: "plan.md/x", content: "x" })).content[0].text).toContain("is a file, not a folder");
    const readOnly = await copies.answer({ action: "write_file", computer_id: lending, folder_id: docs, path: "x.md", content: "x" }, OWNER)!;
    expect(readOnly.content[0].text).toBe("This folder is read-only.");
    expect(copies.staged(syncId)).toHaveLength(1);
  });

  it("an overwrite keeps what the computer had as its base; a second change replaces the first", async () => {
    await op("write_file", { path: "plan.md", content: "v2", expected_sha256: sha("the plan") });
    await op("write_file", { path: "plan.md", content: "v3", expected_sha256: sha("v2") });
    const [change] = copies.staged(syncId);
    expect(change).toMatchObject({ path: "plan.md", sha256: sha("v3"), baseSha256: sha("the plan") });
    expect(readFileSync(copies.stagedFile(syncId, change!.id).file, "utf8")).toBe("v3");
  });

  it("the desktop's done removes a change only as it applied it", async () => {
    await op("write_file", { path: "plan.md", content: "v2", expected_sha256: sha("the plan") });
    const [first] = copies.staged(syncId);
    // A bot changed it again while the desktop applied the first version: the newer one waits, based on what landed.
    await op("write_file", { path: "plan.md", content: "v3", expected_sha256: sha("v2") });
    copies.stagedDone(syncId, first!.id, { sha256: sha("v2") });
    expect(copies.staged(syncId)).toEqual([expect.objectContaining({ sha256: sha("v3"), baseSha256: sha("v2") })]);
    copies.stagedDone(syncId, first!.id, { sha256: sha("v3") });
    expect(copies.staged(syncId)).toEqual([]);
    expect(() => copies.stagedFile(syncId, first!.id)).toThrow();
  });

  it("a copy that is gone, or a change a month old, is dropped", async () => {
    await op("write_file", { path: "new.md", content: "x" });
    copies.sweep();
    expect(copies.stagedCount(syncId)).toBe(1);
    now += 31 * 24 * 60 * 60_000;
    copies.sweep();
    expect(copies.stagedCount(syncId)).toBe(0);
  });
});

describe("SharedComputers with lent copies", () => {
  it("answers a folder action for an away computer from its copy, and the rest as offline", async () => {
    const computers = new SharedComputers(() => true, undefined, undefined, copies);
    const read = await computers.request({ computer_id: lending, action: "read_file", folder_id: notes, path: "plan.md" }, OWNER, () => true) as any;
    expect(body(read).content).toBe("the plan");
    await expect(computers.request({ computer_id: lending, action: "run_command", command: "ls" }, OWNER, () => true)).rejects.toThrow(/This shared computer is offline/);
    expect(computers.away(OWNER)).toMatchObject({ away_computers: [expect.objectContaining({ computer_id: lending })] });
    // A turn that ended gets nothing.
    await expect(computers.request({ computer_id: lending, action: "read_file", folder_id: notes, path: "plan.md" }, OWNER, () => false)).rejects.toThrow();
  });
});
