import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { awayNotice, deviceWord, LentComputers } from "./lent-computers.ts";
import { SharedComputers, sharedComputerRegistration } from "./shared-computers.ts";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = () => { const dir = mkdtempSync(join(tmpdir(), "omb-lent-")); dirs.push(dir); return join(dir, "lent-computers.json"); };
const secret = "a".repeat(64);
const lend = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), name: "ASH-PC", environmentId: randomUUID(),
  folders: [{ id: randomUUID(), name: "Plans", write: false }], terminal: false, computer: true, ...extra });

describe("what a server remembers about computers lent to it", () => {
  it("knows a computer by name across new grants, keeps when it was last online and used, and survives a restart", () => {
    let now = Date.UTC(2026, 9, 7, 14, 2);
    const path = file();
    const lent = new LentComputers(path, () => now);
    const first = randomUUID();
    lent.connected("cloud-home", { id: first, name: "ASH-PC", platform: "win32", folders: 1, terminal: false, screen: true });
    now += 30_000;
    lent.seen("cloud-home", first);
    // Within a minute: kept in memory, not yet written.
    expect(JSON.parse(readFileSync(path, "utf8")).computers[0].lastSeenAt).toBe(Date.UTC(2026, 9, 7, 14, 2));
    now += 60_000;
    lent.used("cloud-home", first);
    const again = randomUUID();
    now += 60_000;
    lent.connected("cloud-home", { id: again, name: "ASH-PC", folders: 0, terminal: false, screen: true });
    const reread = new LentComputers(path, () => now);
    expect(reread.list("cloud-home")).toEqual([{ id: again, person: "cloud-home", name: "ASH-PC", platform: "win32", folders: 0, terminal: false, screen: true, internet: false, chrome: false,
      lastSeenAt: now, lastUsedAt: Date.UTC(2026, 9, 7, 14, 2) + 90_000, stoppedAt: null }]);
    expect(reread.list("someone-else")).toEqual([]);
    expect(reread.list(null)).toEqual([]);
    reread.stopped("cloud-home", again);
    expect(new LentComputers(path).list("cloud-home")[0]!.stoppedAt).toBe(now);
    expect(readFileSync(path, "utf8")).not.toMatch(/Plans|secret/u);
  });

  it("says PC on Windows, Mac only on a Mac, and computer otherwise", () => {
    expect([deviceWord("win32"), deviceWord("darwin"), deviceWord("linux"), deviceWord(null)]).toEqual(["PC", "Mac", "computer", "computer"]);
    const at = Date.UTC(2026, 9, 7, 14, 2);
    const record = { id: randomUUID(), person: "cloud-home", name: "ASH-PC", platform: "win32" as const, folders: 1, terminal: false, screen: true, lastSeenAt: at, lastUsedAt: null, stoppedAt: null };
    expect(awayNotice([record], new Set())).toEqual({
      offline: [{ name: "ASH-PC", device: "PC", lastOnline: "2026-10-07 14:02 UTC", lent: true }],
      say: "Their PC ASH-PC is shared with the Cloud but offline (last online 2026-10-07 14:02 UTC): OpenMausBot on it is closed, or the PC is asleep or off. Ask them to open OpenMausBot on that PC; it reconnects by itself.",
    });
    expect(awayNotice([{ ...record, stoppedAt: at }], new Set()).say).toBe("Their PC ASH-PC is no longer shared with the Cloud: sharing was turned off on it. To share it again, they press [Use my PC](openmausbot://use-my-computer) in OpenMausBot on that PC.");
    expect(awayNotice([{ ...record, platform: "darwin" }], new Set()).say).toMatch(/^Their Mac ASH-PC is shared with the Cloud/u);
    expect(awayNotice([record], new Set([record.id]))).toEqual({});
    for (const sentence of [awayNotice([record], new Set()).say!, awayNotice([{ ...record, stoppedAt: at }], new Set()).say!]) expect(sentence).not.toMatch(/this Mac|OMB Cloud|OpenMausBot Cloud/u);
  });
});

describe("the shared-computer registry with that memory", () => {
  it("takes a platform from a new desktop, still takes an old desktop's registration, and gives bots the device word", () => {
    const pc = lend({ platform: "win32" });
    expect(sharedComputerRegistration.safeParse(pc).success).toBe(true);
    expect(sharedComputerRegistration.safeParse(lend()).success).toBe(true);
    expect(sharedComputerRegistration.safeParse(lend({ platform: "freebsd" })).success).toBe(false);
    const broker = new SharedComputers(() => true, new LentComputers(file()));
    broker.register(pc, { session: "s1", person: "cloud-home" }, secret);
    expect(broker.list("cloud-home")).toEqual([{ ...pc, platform: undefined, device: "PC" }].map(({ platform: _p, ...rest }) => rest));
    broker.close();
  });

  it("tells a bot a lent PC is offline by name and since when, and that a stopped one is no longer lent", async () => {
    // A request first waits up to 15 s for a computer seen this recently to reconnect: run that wait on fake time.
    vi.useFakeTimers();
    let live = true;
    const path = file();
    const broker = new SharedComputers(() => live, new LentComputers(path));
    const pc = lend({ platform: "win32" });
    broker.register(pc, { session: "s1", person: "cloud-home" }, secret);
    expect(broker.away("cloud-home")).toEqual({});
    expect(broker.known("cloud-home")).toEqual([expect.objectContaining({ id: pc.id, name: "ASH-PC", platform: "win32", online: true, lent: true, scopes: { folders: 1, terminal: false, screen: true, internet: false, chrome: false } })]);
    live = false;
    expect(broker.away("cloud-home").say).toMatch(/^Their PC ASH-PC is shared with the Cloud but offline \(last online \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/u);
    const offline = expect(broker.request({ computer_id: pc.id, action: "computer_tools" }, "cloud-home", () => true))
      .rejects.toThrow("ASH-PC is offline: OpenMausBot on that PC is closed, or the PC is asleep or off. Ask them to open it; it reconnects by itself.");
    await vi.advanceTimersByTimeAsync(15_250);
    await offline;
    // A restarted server has no registrations, and still knows.
    const restarted = new SharedComputers(() => false, new LentComputers(path));
    expect(restarted.known("cloud-home")).toEqual([expect.objectContaining({ name: "ASH-PC", online: false, lent: true })]);
    expect(restarted.away("cloud-home").offline).toEqual([expect.objectContaining({ name: "ASH-PC", device: "PC", lent: true })]);
    live = true;
    broker.disconnect(pc.id, "s1", secret);
    expect(broker.known("cloud-home")).toEqual([expect.objectContaining({ lent: false, online: false })]);
    expect(broker.away("cloud-home").say).toMatch(/^Their PC ASH-PC is no longer shared with the Cloud/u);
    expect(broker.away(null)).toEqual({});
    broker.close();
  });

  it("remembers a computer that lends its internet connection, even an old record without it, and says when the bots browse from My Cloud's own connection", () => {
    const path = file();
    const at = Date.UTC(2026, 9, 7, 14, 2);
    // A record from before the internet connection could be lent.
    writeFileSync(path, JSON.stringify({ version: 1, computers: [{ id: randomUUID(), person: "cloud-home", name: "OLD-PC", platform: "win32", folders: 1, terminal: false, screen: false, lastSeenAt: at, lastUsedAt: null, stoppedAt: null }] }));
    expect(new LentComputers(path).list("cloud-home")).toHaveLength(1);
    let live = true;
    const broker = new SharedComputers(() => live, new LentComputers(path));
    expect(broker.internetAway("cloud-home"), "no computer lends its connection: nothing to say").toBeNull();
    const mac = lend({ name: "Ash's MacBook", platform: "darwin", internet: true });
    expect(sharedComputerRegistration.safeParse(mac).success).toBe(true);
    broker.register(mac, { session: "s1", person: "cloud-home" }, secret);
    expect(broker.known("cloud-home")[0]).toEqual(expect.objectContaining({ name: "Ash's MacBook", online: true, scopes: { folders: 1, terminal: false, screen: true, internet: true, chrome: false } }));
    expect(broker.status("cloud-home")[0]!.scopes.internet).toBe(true);
    expect(broker.internetAway("cloud-home"), "online: the browsing goes through it").toBeNull();
    live = false;
    expect(broker.internetAway("cloud-home")).toEqual({ away: "Mac" });
    expect(new LentComputers(path).list("cloud-home")[0]).toEqual(expect.objectContaining({ name: "Ash's MacBook", internet: true }));
    live = true;
    broker.disconnect(mac.id, "s1", secret);
    expect(broker.internetAway("cloud-home"), "turned off there: no longer lent, so nothing to say").toBeNull();
    broker.close();
  });

  it("remembers whether a computer lends its Chrome", () => {
    const path = file();
    const lent = new LentComputers(path);
    lent.connected("cloud-home", { id: randomUUID(), name: "ASH-PC", platform: "win32", folders: 0, terminal: false, screen: false, chrome: true });
    expect(new LentComputers(path).list("cloud-home")[0]!.chrome).toBe(true);
  });

  it("keeps a paused computer lent: it reads as offline, never as turned off, and an older desktop's disconnect still stops it", () => {
    const broker = new SharedComputers(() => true, new LentComputers(file()));
    const pc = lend({ platform: "win32" });
    broker.register(pc, { session: "s1", person: "cloud-home" }, secret);
    broker.disconnect(pc.id, "s1", secret, true);
    expect(broker.known("cloud-home")).toEqual([expect.objectContaining({ lent: true, online: false })]);
    expect(broker.away("cloud-home").say).toMatch(/^Their PC ASH-PC is shared with the Cloud but offline/u);
    broker.register(pc, { session: "s1", person: "cloud-home" }, secret);
    broker.disconnect(pc.id, "s1", secret);
    expect(broker.known("cloud-home")).toEqual([expect.objectContaining({ lent: false })]);
    broker.close();
  });
});
