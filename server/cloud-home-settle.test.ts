import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleCloudHome, type CloudHomeSettleDeps } from "./cloud-home-settle.ts";
import { createCloudRoutineAuthors } from "./cloud-lending.ts";
import { CLOUD_OUTSIDE_KEY } from "./cloud-sharing.ts";
import { asSchedule } from "./routine-requests.ts";
import { ThreadStarters } from "./thread-starters.ts";

const key = (name: string) => `p_${name.padEnd(22, "x")}`;
const OWNER = key("owner"), NOBODY = key("nobody"), GUEST = key("guest");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const definition = { name: "Brief", instructions: "Summarise the inbox.", schedule: { type: "interval" as const, everyMinutes: 60 } };
const card = (routineId: string, action: "create" | "update" = "create") => ({ id: `card-${routineId}-${action}`, role: "bot", card: { requestId: `req-${routineId}`, answered: "allow", autoApplied: true,
  routineRequest: { version: 1, requestId: `req-${routineId}`, botId: "bot", threadId: "t", createdAt: 0, resultId: routineId,
    operation: action === "create" ? { action, routine: definition } : { action, routineId, changes: { instructions: "Forward the inbox." } } } } });
const line = (id: string, person?: string) => ({ id, role: "user", kind: "text", text: "hi", ...(person ? { sender: { id: person, name: "x" } } : {}) });

/** A Cloud home's records: conversations by id, routines, their writers, and the people who have sessions. */
function cloudHome(threads: Record<string, any[]>, routines: Array<{ id: string; sourceThreadId?: string }>, writers: Record<string, string>,
  options: { sessions?: Array<{ id: string; scopes: string[] }>; webhookRuns?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-cloud-home-settle-")); dirs.push(dir);
  writeFileSync(join(dir, "lending-routines.json"), JSON.stringify({ version: 1, routines: {}, writers }));
  writeFileSync(join(dir, "thread-starters.json"), "{}");
  const authors = createCloudRoutineAuthors(join(dir, "lending-routines.json"));
  const sessions = options.sessions ?? [{ id: "owner-device", scopes: ["admin"] }];
  const shaped = routines.map((routine) => ({ ...routine, prompt: definition.instructions, botId: "bot", runOn: "maus",
    schedule: asSchedule(definition.schedule, 0), target: "bot" }));
  const deps = (): CloudHomeSettleDeps => ({
    file: join(dir, "cloud-owner.json"), machineId: "machine", ownerKey: OWNER, nobodyKey: NOBODY,
    sessions: { list: () => sessions, revoke: (id) => { const at = sessions.findIndex((s) => s.id === id); if (at >= 0) sessions.splice(at, 1); return at >= 0; } },
    personKey: (session) => key(session.id), starters: new ThreadStarters(join(dir, "thread-starters.json")), authors,
    routines: () => ({ listRoutines: () => shaped, listRuns: () => (options.webhookRuns ?? []).map((threadId) => ({ triggerSource: "webhook", threadId })), update: () => null }) as any,
    store: { bots: [{ id: "bot" }], tasks: () => Object.keys(threads).map((threadId) => ({ threadId })), groups: [], messagesFor: (threadId: string) => threads[threadId] ?? [],
      botByThread: (threadId: string) => threads[threadId] ? { id: "bot" } : null, groupByThread: () => null, unpinTaskCwd: () => {} } as any,
    linePersonKey: (message) => message.role === "user" && !message.peerAsk ? message.sender?.id : undefined, asSchedule,
    settled: () => {}, provenPerson: (person) => person === OWNER || person === key("owner-device"),
    ownersOrNone: (person) => [OWNER, NOBODY, CLOUD_OUTSIDE_KEY, key("owner-device")].includes(person), threadStarters: () => [undefined],
    cardAnswerer: () => undefined, reportFromOthers: () => false, ownersRoutine: (id) => authors.wrote(id, OWNER), log: () => {},
  });
  return { dir, authors, sessions, settle: () => settleCloudHome(deps()), record: () => JSON.parse(readFileSync(join(dir, "cloud-owner.json"), "utf8")) };
}

describe("settling a Cloud home's people at start (server/cloud-home-settle.ts)", () => {
  it("finds only the owner, says so once, and marks routines a webhook's run made or changed as from outside", () => {
    const home = cloudHome({ chat: [line("m1", OWNER)], hook: [line("payload"), card("hooked"), card("changed", "update")], other: [line("m2", OWNER), card("mine"), card("changed")] },
      [{ id: "hooked", sourceThreadId: "hook" }, { id: "mine", sourceThreadId: "other" }, { id: "changed", sourceThreadId: "other" }],
      { hooked: NOBODY, mine: NOBODY, changed: NOBODY }, { webhookRuns: ["hook"] });
    expect(home.settle().solo()).toBe(true);
    expect(home.record()).toMatchObject({ peopleChecked: true });
    expect(home.record()).not.toHaveProperty("sharedSince");
    expect(home.authors.writer("hooked")).toBe(CLOUD_OUTSIDE_KEY);
    expect(home.authors.writer("changed")).toBe(CLOUD_OUTSIDE_KEY);
    expect(home.authors.writer("mine")).toBe(OWNER);
  });

  it("is shared on any trace of a second person, and the first one after a start that found only the owner keeps what the owner made alone", () => {
    const home = cloudHome({ desk: [line("d1"), card("desktop")], theirs: [line("g1", GUEST), card("guests")] },
      [{ id: "desktop", sourceThreadId: "desk" }, { id: "guests", sourceThreadId: "theirs" }], {});
    const first = home.settle();
    expect(first.solo()).toBe(false);
    expect(home.record().sharedSince).toEqual(expect.any(Number));
    expect(home.authors.writer("desktop")).toBe(NOBODY);

    const solo = cloudHome({ desk: [line("d1"), card("desktop")] }, [{ id: "desktop", sourceThreadId: "desk" }], {});
    expect(solo.settle().solo()).toBe(true);
    solo.sessions.push({ id: "friend", scopes: ["client"] });
    const second = solo.settle();
    expect(second.solo()).toBe(false);
    expect(solo.authors.writer("desktop")).toBe(OWNER);
    expect(solo.record().revokedKeys).toEqual([key("friend")]);
    const since = solo.record().sharedSince;
    expect(solo.settle().solo()).toBe(false);
    expect(solo.record().sharedSince).toBe(since);
  });

  it("when a second person's session opens while it runs, keeps what the owner made alone and stays shared", () => {
    const home = cloudHome({ desk: [line("d1"), card("desktop")], hook: [line("payload"), card("hooked")] },
      [{ id: "desktop", sourceThreadId: "desk" }, { id: "hooked", sourceThreadId: "hook" }], {}, { webhookRuns: ["hook"] });
    const settled = home.settle();
    expect(settled.solo()).toBe(true);
    settled.share();
    expect(settled.solo()).toBe(false);
    expect(home.authors.writer("desktop")).toBe(OWNER);
    expect(home.authors.writer("hooked")).toBe(CLOUD_OUTSIDE_KEY);
    expect(home.record().sharedSince).toEqual(expect.any(Number));
    expect(home.settle().solo()).toBe(false);
  });
});
