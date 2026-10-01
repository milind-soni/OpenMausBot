import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleCloudOwnership, type CloudOwnershipOptions } from "./cloud-owner.ts";
import { ThreadStarters } from "./thread-starters.ts";

const key = (name: string) => `p_${name.padEnd(22, "x")}`;
const OWNER = key("owner"), NOBODY = key("nobody");
const MACHINE = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "omb-cloud-owner-")); dirs.push(dir); return dir; };

/** A v0.1.91 Cloud home's data as it stands at a boot: sessions, thread
 * openers (a file), routines with their writers and fingerprints, and who
 * wrote which lines and answered which cards. */
interface World {
  dir: string;
  sessions: { id: string; scopes: string[] }[];
  writers: Record<string, string>;
  fingerprinted: string[];
  routines: string[];
  senders: string[];
  answerers: string[];
  /** A routine a bot proposed, who allowed its card, and the instructions it showed. */
  approvals: Array<[string, string, string]>;
  /** What each routine runs as it stands (index.ts approvalShape). */
  shapes: Record<string, string>;
  /** The conversation each routine reports into. */
  results: Record<string, string>;
  paused: string[];
  unpinned: string[];
}
function world(): World {
  const dir = folder();
  writeFileSync(join(dir, "thread-starters.json"), JSON.stringify({
    // The owner's desktop opened two, their phone (unpaired since) one, a
    // guest still paired one, a guest unpaired before the upgrade one.
    desk: key("desktop"), room: key("desktop"), phone: key("phone"), guest: key("guest"), former: key("former"),
  }));
  return {
    dir,
    sessions: [{ id: "desktop", scopes: ["admin", "client"] }, { id: "guest", scopes: ["client"] }],
    // v0.1.91 had no writer map: none recorded. One of the owner's routines
    // carries #2023's fingerprint.
    writers: {},
    fingerprinted: ["owners"],
    routines: ["owners", "template", "guests"],
    // The phone only ever wrote a line (in the desktop's room); the former
    // guest wrote in the owner's conversation; the phone answered a card.
    senders: [key("desktop"), key("phone"), key("former"), key("guest")],
    answerers: [key("phone")],
    approvals: [],
    shapes: {},
    results: {},
    paused: [],
    unpinned: [],
  };
}
type Hook = (step: string) => void;
function options(w: World, hook: Hook = () => {}, extra: Partial<CloudOwnershipOptions> = {}, log: string[] = []): CloudOwnershipOptions {
  const starters = new ThreadStarters(join(w.dir, "thread-starters.json"));
  return {
    file: join(w.dir, "cloud-owner.json"), machineId: MACHINE, ownerKey: OWNER, nobodyKey: NOBODY,
    sessions: {
      list: () => w.sessions,
      revoke: (id) => { hook("revoke"); const at = w.sessions.findIndex((session) => session.id === id); if (at < 0) return false; w.sessions.splice(at, 1); return true; },
    },
    personKey: (session) => key(session.id),
    starters: { people: () => starters.people(), reassign: (move, to) => { hook(`starters→${to === OWNER ? "owner" : "nobody"}`); return starters.reassign(move, to); } },
    writers: {
      people: () => new Set(Object.values(w.writers)),
      reassign: (move, to) => { hook("writers→nobody"); const moved: string[] = []; for (const [id, p] of Object.entries(w.writers)) if (p !== to && move(p)) { w.writers[id] = to; moved.push(id); } return moved; },
    },
    routines: {
      ids: () => w.routines, writer: (id) => w.writers[id], fingerprinted: (id) => w.fingerprinted.includes(id),
      resultsOpener: (id) => w.results[id] ? starters.get(w.results[id]) : undefined,
      shape: (id) => w.shapes[id],
      name: (id, person) => { hook("routine"); w.writers[id] = person; },
      pause: (ids) => { hook("pause"); w.paused.push(...ids); },
    },
    unpin: (threads) => { hook("unpin"); w.unpinned.push(...threads); },
    lines: () => { hook("lines"); return { senders: w.senders, answerers: w.answerers, approvals: w.approvals }; },
    log: (line) => log.push(line),
    ...extra,
  };
}
const starters = (w: World) => JSON.parse(readFileSync(join(w.dir, "thread-starters.json"), "utf8")) as Record<string, string>;

describe("a Cloud home is personal: settling who its owner was (server/cloud-owner.ts)", () => {
  it("revokes every non-admin session and makes what it opened nobody's; earlier keys are the owner's in two tiers; routines only with proof", () => {
    const w = world();
    const log: string[] = [];
    const settled = settleCloudOwnership(options(w, undefined, {}, log));
    expect(w.sessions.map((session) => session.id)).toEqual(["desktop"]);
    expect(log[0]).toBe("cloud home: revoked 1 session that was not the owner's own device");
    expect(log.join("\n")).not.toContain("guest");
    // Adopted (who opened, level, folder): every earlier key but the revoked guest's.
    expect([...settled.adopted].sort()).toEqual([key("desktop"), key("former"), key("phone")].sort());
    // Proven (lending, memory): a device still paired, and one that answered a card.
    expect([...settled.proven].sort()).toEqual([key("desktop"), key("phone")].sort());
    expect(settled.proven.has(key("former"))).toBe(false);
    // Openers: proven → the owner's key; the revoked guest's → nobody's; the rest kept.
    expect(starters(w)).toEqual({ desk: OWNER, room: OWNER, phone: OWNER, guest: NOBODY, former: key("former") });
    // Routines: the fingerprinted one is the owner's, every other nobody's.
    expect(w.writers).toEqual({ owners: OWNER, template: NOBODY, guests: NOBODY });
    // Later starts only revoke: settled stays settled.
    w.sessions.push({ id: "late", scopes: ["client"] });
    w.routines.push("new");
    const again = settleCloudOwnership(options(w));
    expect(w.sessions.map((session) => session.id)).toEqual(["desktop"]);
    expect([...again.adopted].sort()).toEqual([...settled.adopted].sort());
    expect(w.writers.new).toBeUndefined();
  });

  it("a crash at any step never makes a revoked session's key the owner's, and the next start finishes the job", () => {
    // Every step the settlement takes, and the state on disk and in the
    // stores right before it: a crash there.
    const steps: string[] = [];
    const first = world();
    const snapshots: Array<{ step: string; state: World }> = [];
    const snapshot = (step: string) => {
      const dir = folder();
      cpSync(first.dir, dir, { recursive: true });
      snapshots.push({ step, state: { ...structuredClone(first), dir } });
    };
    snapshot("start");
    settleCloudOwnership(options(first, (step) => { steps.push(step); snapshot(`before ${step} #${steps.length}`); }));
    snapshot("end");
    expect(steps).toEqual(["revoke", "starters→nobody", "unpin", "writers→nobody", "lines", "starters→owner", "routine", "routine", "routine"]);
    for (const { step, state } of snapshots) {
      const settled = settleCloudOwnership(options(state));
      expect(settled.adopted.has(key("guest")), step).toBe(false);
      expect(settled.proven.has(key("guest")), step).toBe(false);
      expect(starters(state).guest, step).toBe(NOBODY);
      expect(starters(state).desk, step).toBe(OWNER);
      expect(state.sessions.map((session) => session.id), step).toEqual(["desktop"]);
      expect(settled.proven.has(key("phone")), step).toBe(true);
      expect(state.writers, step).toEqual({ owners: OWNER, template: NOBODY, guests: NOBODY });
    }
    // Two guests, the second revoke failing to save (finding 7): the first
    // guest's key is recorded, so the next start never adopts it.
    const w = world();
    w.sessions.push({ id: "second", scopes: ["client"] });
    let revokes = 0;
    const failing = options(w);
    const revoke = failing.sessions.revoke;
    failing.sessions.revoke = (id) => { if (++revokes === 2) throw new Error("ENOSPC"); return revoke(id); };
    settleCloudOwnership(failing);
    const next = settleCloudOwnership(options(w));
    for (const guest of [key("guest"), key("second")]) expect(next.adopted.has(guest)).toBe(false);
  });

  it("revokes nothing and trusts nothing new when the record cannot be saved", () => {
    const w = world();
    mkdirSync(join(w.dir, "cloud-owner.json"));
    const log: string[] = [];
    const settled = settleCloudOwnership(options(w, undefined, {}, log));
    expect(w.sessions).toHaveLength(2); // inert anyway: sessions.requireAdmin
    expect(settled.adopted.size + settled.proven.size).toBe(0);
    expect(starters(w).former).toBe(key("former"));
    expect(log.join("\n")).toContain("unreadable");
  });

  it("a restore applied here is the owner's: its routines are theirs unless nobody's or a revoked key's, and a crash mid-way finishes at the next start", () => {
    const w = world();
    settleCloudOwnership(options(w));
    // The restore brings other data: routines without writers, and keys.
    writeFileSync(join(w.dir, "thread-starters.json"), JSON.stringify({ moved: key("mac"), old: key("guest") }));
    w.routines = ["moved", "nobodys", "revoked"];
    w.writers = { nobodys: NOBODY, revoked: key("guest") };
    w.senders = [key("mac")];
    w.answerers = [];
    let crashed = false;
    try {
      settleCloudOwnership(options(w, (step) => { if (step === "routine") { crashed = true; throw new Error("killed"); } }, { restoredNow: "restore-1" }));
    } catch { /* the crash */ }
    expect(crashed).toBe(true);
    const settled = settleCloudOwnership(options(w)); // no restoredNow: the record remembers
    expect(settled.adopted.has(key("mac"))).toBe(true);
    expect(settled.adopted.has(key("guest"))).toBe(false);
    expect(starters(w)).toEqual({ moved: key("mac"), old: NOBODY });
    expect(w.writers).toEqual({ moved: OWNER, nobodys: NOBODY, revoked: NOBODY });
    expect(JSON.parse(readFileSync(join(w.dir, "cloud-owner.json"), "utf8"))).not.toHaveProperty("pendingRestore");
  });

  it("an unreadable record, or another machine's, makes nothing from before the owner's without settling over it", () => {
    for (const record of ["{broken", JSON.stringify({ version: 2, machineId: "another", revokedKeys: [], adoptedKeys: [key("desktop")], provenKeys: [], settled: true })]) {
      const w = world();
      writeFileSync(join(w.dir, "cloud-owner.json"), record);
      const settled = settleCloudOwnership(options(w));
      if (record.startsWith("{broken")) {
        expect(settled.adopted.size).toBe(0);
        expect(starters(w).desk).toBe(key("desktop"));
      } else {
        // Another machine's record is ignored: this one settles its own.
        expect(settled.adopted.has(key("desktop"))).toBe(true);
        expect(JSON.parse(readFileSync(join(w.dir, "cloud-owner.json"), "utf8")).machineId).toBe(MACHINE);
      }
      expect(existsSync(join(w.dir, "cloud-owner.json"))).toBe(true);
    }
  });

  it("what a revoked session opened loses its folder and its routines stop; the owner is told once to review their devices", () => {
    const w = world();
    w.writers = { theirs: key("guest"), mine: key("desktop") };
    w.routines = ["theirs", "mine"];
    const log: string[] = [];
    settleCloudOwnership(options(w, undefined, {}, log));
    expect(w.unpinned).toEqual(["guest"]);
    expect(w.paused).toEqual(["theirs"]);
    expect(log.filter((line) => line.includes("Paired devices"))).toHaveLength(1);
    const again: string[] = [];
    settleCloudOwnership(options(w, undefined, {}, again));
    expect(again.join("\n")).not.toContain("Paired devices");
    expect(w.paused).toEqual(["theirs"]);
  });

  it("a routine a bot proposed is the owner's when a proven key allowed its card and it still runs exactly what the card showed", () => {
    const w = world();
    w.routines = ["byPhone", "byFormer", "byNobody", "rewritten"];
    const shown = "[\"Check the site.\",\"bot\"]";
    // The phone answered cards (proven); the former guest only wrote lines (adopted).
    w.approvals = [["byPhone", key("phone"), shown], ["byFormer", key("former"), shown], ["rewritten", key("phone"), shown]];
    // On v0.1.91 anyone could change a routine (its instructions, bot, an attachment), unrecorded.
    w.shapes = { byPhone: shown, byFormer: shown, rewritten: "[\"Check the site.\",\"another-bot\"]" };
    settleCloudOwnership(options(w));
    expect(w.writers).toEqual({ byPhone: OWNER, byFormer: NOBODY, byNobody: NOBODY, rewritten: NOBODY });
  });

  it("a restore is proof only for routines reporting into a conversation that names nobody yet or the owner", () => {
    const w = world();
    settleCloudOwnership(options(w));
    // A backup from before: the former guest (adopted, unproven) opened one results conversation.
    writeFileSync(join(w.dir, "thread-starters.json"), JSON.stringify({ friends: key("former"), desks: key("desktop") }));
    w.routines = ["unnamed", "desks", "friends"];
    w.writers = {};
    w.fingerprinted = [];
    w.results = { desks: "desks", friends: "friends" };
    settleCloudOwnership(options(w, undefined, { restoredNow: "restore-1" }));
    expect(w.writers).toEqual({ unnamed: OWNER, desks: OWNER, friends: NOBODY });
  });

  it("a restore whose start ended before it was recorded is settled at the next; an old one at the very first start is not", () => {
    const w = world();
    settleCloudOwnership(options(w, undefined, { lastRestore: "long-ago" }));
    // The old restore was the first settlement's data: its routines needed proof.
    expect(w.writers).toEqual({ owners: OWNER, template: NOBODY, guests: NOBODY });
    expect(JSON.parse(readFileSync(join(w.dir, "cloud-owner.json"), "utf8")).settledRestore).toBe("long-ago");
    // A new restore is applied, and that start ends before the settlement
    // runs: the next start only knows it as the last restore on record.
    w.routines = ["moved"];
    w.writers = {};
    w.fingerprinted = [];
    const next = options(w, undefined, { lastRestore: "restore-2" });
    settleCloudOwnership(next);
    expect(w.writers).toEqual({ moved: OWNER });
    expect(JSON.parse(readFileSync(join(w.dir, "cloud-owner.json"), "utf8")).settledRestore).toBe("restore-2");
    // …and only once.
    w.writers = { moved: NOBODY };
    settleCloudOwnership(options(w, undefined, { lastRestore: "restore-2" }));
    expect(w.writers).toEqual({ moved: NOBODY });
  });
});
