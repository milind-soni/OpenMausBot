import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { Notification } from "../../shared/notification.ts";
import { cloudSendSummary, type CloudSendSources } from "../cloud-send.ts";
import { automatedBot, kindRecord, MOVE_BOT_FIELDS, moveItems, moveKindsRoute, type MoveKindsDeps } from "../cloud-send-kinds.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { EmailHeader } from "../connected-reads.ts";
import { ensureDefaultBot } from "../default-bot.ts";
import { closeMessageDb } from "../message-db.ts";
import { checkRunsLeft, CHECK_RUNS_PER_DAY } from "../routine-check-pacing.ts";
import { RoutineManager, type Routine, type RoutineRun } from "../routines.ts";
import { Store, type BotRecord } from "../store.ts";
import { BRIEF_FILE } from "./brief.ts";
import { createProactive, WATCH_FILE, WATCH_NAME } from "./proactive.ts";
import { proactiveOwner } from "./proactive-owner.ts";
import { CHECKS_FILE } from "./routine-checks.ts";

// MausBot owns the proactive side: the "Keep an eye on my day" routine, the brief and the add-a-key suggestion. Each
// `start()` reads the store, the routines and the proactive files from disk, as the server does when it starts.
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
const ada: EmailHeader = { id: "m1", threadId: "t1", at: 0, from: "Ada <ada@x.test>", subject: "Q3 numbers", preview: "Can you send them?" };
const OWNER = { person: "p_owner0000000000000000", name: "Amit" };

function start(options: { team?: boolean; frozen?: boolean } = {}) {
  const store = new Store(selection);
  const notified: Notification[] = [];
  const reads: string[] = [];
  let routines: RoutineManager | null = null;
  const proactive = createProactive({
    store, cfg: {} as AppConfig, dataDir: DATA_DIR, team: options.team ?? false, frozen: () => options.frozen ?? false, routines: () => routines, cloud: false,
    composio: {
      configured: () => true,
      connectedServices: async () => ({ gmail: { connected: true }, googlecalendar: { connected: true } }),
      relayMcp: async (_cfg: AppConfig, payload: never) => {
        const frame = payload as { method: string; params?: { arguments?: { tools?: Array<{ tool_slug: string }> } } };
        if (frame.method === "tools/call") reads.push(frame.params!.arguments!.tools![0]!.tool_slug);
        return { status: 200, bytes: new TextEncoder().encode("{}"), transportSessionId: "s" };
      },
    },
    registry: { get: () => ({ driverKind: "claudeAgent", adapter: {} as never }) },
    mainThread: (botId) => store.bot(botId)?.threadId, threadBusy: () => false, notify: (notification) => { if (notification) notified.push(notification); },
    engineName: () => "Claude", needsYou: () => [], hostTimeZone: () => "UTC", decide: () => {}, stale: () => false, release: () => {}, owned: () => {},
  });
  routines = new RoutineManager({ file: join(DATA_DIR, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "t" }), startTurn: async () => {}, checks: proactive.checks });
  const manager = routines;
  return {
    store, proactive, routines: manager, notified, reads,
    briefing: () => manager.listRoutines().filter((routine) => routine.deliver === "brief"),
    on: () => manager.listRoutines().filter((routine) => routine.deliver === "brief" && routine.enabled),
  };
}

const json = (file: string) => JSON.parse(readFileSync(join(DATA_DIR, file), "utf8"));
const briefCards = (store: Store, bot: BotRecord) => store.messagesFor(bot.threadId).filter((message) => message.serverCard && message.widget?.root.title === "Your brief");
/** Writes runs into routines.json the way the routine engine keeps them. */
function withRuns(runs: RoutineRun[]): void {
  const file = json("routines.json");
  writeFileSync(join(DATA_DIR, "routines.json"), JSON.stringify({ ...file, runs: [...(file.runs ?? []), ...runs] }));
}
const watchRun = (routine: Routine, fields: Partial<RoutineRun>): RoutineRun => ({
  id: `run-${Math.random().toString(36).slice(2)}`, routineId: routine.id, routineName: routine.name, target: "bot", botId: routine.botId, runOn: "maus",
  scheduledFor: Date.now(), status: "completed", manual: false, checkKey: "key-1", deliver: "brief", access: "read-and-draft", createdAt: Date.now() - 60_000, ...fields,
});

/** An install from before MausBot owned the watch: its Chief made it, and MausBot joined later. */
function existingInstall() {
  const first = start();
  const clive = first.store.createBot({ name: "Clive" });
  first.store.setChiefOfStaff(clive.id);
  const watch = first.proactive.ensureWatch()!;
  expect(watch.botId).toBe(clive.id);
  return { first, clive, watch };
}

describe("MausBot keeps an eye on the day", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("on a new install, its MausBot is the Chief and gets the one watch, once", () => {
    const first = start();
    first.store.seedIfEmpty();
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    expect(maus).toMatchObject({ chiefOfStaff: true, defaultBot: {} });
    expect(first.proactive.ensureWatch()).toMatchObject({ name: WATCH_NAME, botId: maus.id, enabled: true });
    const again = start();
    expect(again.proactive.ensureWatch()).toBeNull();
    expect(again.briefing().map((routine) => routine.botId)).toEqual([maus.id]);
  });

  it("on an install where MausBot comes later, the watch is made on MausBot, not the Chief", () => {
    const first = start();
    const clive = first.store.createBot({ name: "Clive" });
    first.store.setChiefOfStaff(clive.id);
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    expect(proactiveOwner(first.store)?.id).toBe(maus.id);
    expect(first.proactive.ensureWatch()!.botId).toBe(maus.id);
    expect(start().briefing()).toHaveLength(1);
  });

  it("on an existing install, the Chief's watch moves to MausBot once, exactly as the person left it", async () => {
    const { first, clive, watch } = existingInstall();
    await first.proactive.brief.report({ routine: watch, at: Date.now(), picked: [{ email: ada, why: "Ada needs the numbers.", needsReply: true }] });
    expect(briefCards(first.store, clive)).toHaveLength(1);
    first.routines.update(watch.id, { prompt: "Watch for Ada.", enabled: false });
    const checksState = JSON.stringify({ version: 1, routines: { [watch.id]: { mailCursor: 1_000, judged: ["m0", "m1"], runsCursor: 2_000 } } });
    writeFileSync(join(DATA_DIR, CHECKS_FILE), checksState);
    withRuns([watchRun(watch, {}), watchRun(watch, { checkKey: "key-2" })]);
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    const before = json("routines.json").routines.find((routine: Routine) => routine.id === watch.id);

    const after = start();
    after.proactive.ensureWatch();
    const [moved] = after.briefing();
    expect(after.briefing()).toHaveLength(1);
    expect(moved).toMatchObject({ id: watch.id, botId: maus.id, enabled: false, prompt: "Watch for Ada.", checks: ["calendar", "mail", "runs"], access: "read-and-draft",
      deliver: "brief", schedule: before.schedule, nextRunAt: null, createdAt: before.createdAt });
    expect(readFileSync(join(DATA_DIR, CHECKS_FILE), "utf8")).toBe(checksState);
    expect(checkRunsLeft(after.routines.listRuns(), watch.id, Date.now())).toBe(CHECK_RUNS_PER_DAY - 2);
    expect(json(BRIEF_FILE).home).toEqual({ botId: maus.id, threadId: maus.threadId });
    expect(json(BRIEF_FILE).introducedOn).toBeUndefined();
    expect(briefCards(after.store, after.store.bot(clive.id)!), "past cards stay where they were").toHaveLength(1);
    expect(after.store.bot(clive.id)?.chiefOfStaff).toBe(true);
    expect(json(WATCH_FILE).handed).toEqual({ [watch.id]: maus.id });

    const settled = after.routines.listRoutines().find((routine) => routine.id === watch.id)!.updatedAt;
    after.proactive.ensureWatch();
    start().proactive.ensureWatch();
    expect(start().routines.listRoutines().find((routine) => routine.id === watch.id)!.updatedAt).toBe(settled);

    // Handed over once: put back on the Chief by the person, it stays there.
    after.routines.update(watch.id, { botId: clive.id });
    start().proactive.ensureWatch();
    expect(start().briefing().map((routine) => routine.botId)).toEqual([clive.id]);
  });

  it("an install whose watch.json predates the handover still hands over once", () => {
    const { first, watch } = existingInstall();
    writeFileSync(join(DATA_DIR, WATCH_FILE), JSON.stringify({ version: 1, routineId: watch.id, createdAt: 1 }));
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    const after = start();
    expect(after.proactive.ensureWatch()).toBeNull();
    expect(after.briefing().map((routine) => [routine.id, routine.botId, routine.enabled])).toEqual([[watch.id, maus.id, true]]);
  });

  it("finishes a handover a restart cut short, without a second watch", async () => {
    const { first, clive, watch } = existingInstall();
    await first.proactive.brief.report({ routine: watch, at: Date.now(), picked: [{ email: ada, why: "Ada needs the numbers.", needsReply: true }] });
    expect(json(BRIEF_FILE).home.botId).toBe(clive.id);
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    // The routine was moved, and the server stopped before the brief and watch.json followed.
    first.routines.update(watch.id, { botId: maus.id });
    const marker = readFileSync(join(DATA_DIR, WATCH_FILE), "utf8");

    const after = start();
    after.proactive.ensureWatch();
    expect(after.briefing().map((routine) => [routine.id, routine.botId, routine.enabled])).toEqual([[watch.id, maus.id, true]]);
    expect(json(BRIEF_FILE).home).toEqual({ botId: maus.id, threadId: maus.threadId });
    expect(readFileSync(join(DATA_DIR, WATCH_FILE), "utf8")).not.toBe(marker);
    expect(json(WATCH_FILE).handed[watch.id]).toBe(maus.id);
  });

  it("never leaves two watches on: the Chief's is the one kept, MausBot's own is paused, and none is deleted", () => {
    const { first, watch } = existingInstall();
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    const own = first.routines.create({ name: "MausBot's watch", prompt: "Watch.", botId: maus.id, enabled: true, checks: ["mail"], deliver: "brief",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 } });
    const after = start();
    after.proactive.ensureWatch();
    expect(after.briefing().map((routine) => [routine.id, routine.botId, routine.enabled]).sort()).toEqual([[own.id, maus.id, false], [watch.id, maus.id, true]].sort());
    expect(after.on().map((routine) => routine.id)).toEqual([watch.id]);
  });

  it("keeps the person's pause: a paused watch moves paused, and nothing else is left on", () => {
    const { first, watch } = existingInstall();
    first.routines.update(watch.id, { enabled: false });
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    first.routines.create({ name: "MausBot's watch", prompt: "Watch.", botId: maus.id, enabled: true, checks: ["mail"], deliver: "brief",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 } });
    const after = start();
    after.proactive.ensureWatch();
    expect(after.briefing().find((routine) => routine.id === watch.id)).toMatchObject({ botId: maus.id, enabled: false });
    expect(after.on()).toEqual([]);
  });

  it("waits while a run of the watch is queued or working, then hands it over", () => {
    const { first, clive, watch } = existingInstall();
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    const queued = watchRun(watch, { status: "queued" });
    withRuns([queued]);
    const busy = start();
    busy.proactive.ensureWatch();
    expect(busy.briefing().map((routine) => routine.botId)).toEqual([clive.id]);
    const file = json("routines.json");
    writeFileSync(join(DATA_DIR, "routines.json"), JSON.stringify({ ...file, runs: file.runs.map((run: RoutineRun) => ({ ...run, status: "completed", finishedAt: Date.now() })) }));
    const idle = start();
    idle.proactive.ensureWatch();
    expect(idle.briefing().map((routine) => routine.botId)).toEqual([maus.id]);
  });

  it("hands nothing over on a computer whose bots moved to My Cloud", () => {
    const { first, clive } = existingInstall();
    ensureDefaultBot(first.store, { dataDir: DATA_DIR });
    const frozen = start({ frozen: true });
    expect(frozen.proactive.ensureWatch()).toBeNull();
    expect(frozen.briefing().map((routine) => routine.botId)).toEqual([clive.id]);
  });

  it("posts the brief, its notification, the presence answer and the add-a-key card to MausBot hidden from the sidebar", async () => {
    const { first, clive, watch } = existingInstall();
    await first.proactive.brief.report({ routine: watch, at: Date.now(), picked: [{ email: { ...ada, id: "m0" }, why: "Earlier today.", needsReply: false }] });
    expect(briefCards(first.store, clive)).toHaveLength(1);
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    first.store.patchBot(maus.id, { sidebarHidden: true, welcomed: true });
    const after = start();
    after.proactive.ensureWatch();
    const moved = after.briefing()[0]!;
    await after.proactive.brief.report({ routine: moved, at: Date.now(), picked: [{ email: ada, why: "Ada needs the numbers.", needsReply: true }] });
    const hidden = after.store.bot(maus.id)!;
    expect(hidden.sidebarHidden).toBe(true);
    expect(briefCards(after.store, hidden)).toHaveLength(1);
    expect(JSON.stringify(briefCards(after.store, hidden)[0]!.widget!.root)).toContain("Tell me to stop, or what to watch for.");
    expect(briefCards(after.store, after.store.bot(clive.id)!), "today's earlier card stays with the Chief").toHaveLength(1);
    expect(after.notified.at(-1)).toMatchObject({ kind: "brief", botId: maus.id, threadId: hidden.threadId });
    expect(await after.proactive.brief.active("desktop", "UTC")).toMatchObject({ open: { botId: maus.id, threadId: hidden.threadId } });
    await after.proactive.checks.check(moved, { manual: true });
    expect(after.store.messagesFor(hidden.threadId).filter((message) => message.setupSuggestion)).toHaveLength(1);
    expect(after.store.messagesFor(clive.threadId).filter((message) => message.setupSuggestion)).toEqual([]);
    expect(watch.id).toBe(moved.id);
  });

  it("on a Team Cloud: no watch, nothing handed over, and a member's MausBot never reads the shared inbox", async () => {
    const first = start({ team: true });
    first.store.seedIfEmpty({ defaultBot: false });
    const chief = first.store.bots.find((bot) => bot.chiefOfStaff)!;
    const member = ensureDefaultBot(first.store, { dataDir: DATA_DIR, person: "ada@example.test", team: "Acme" })!;
    expect(proactiveOwner(first.store)?.id).toBe(chief.id);
    expect(first.proactive.ensureWatch()).toBeNull();
    expect(first.briefing()).toEqual([]);
    const restored = first.routines.create({ name: WATCH_NAME, prompt: "Watch.", botId: chief.id, enabled: true, checks: ["mail"], deliver: "brief",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 } });
    const own = first.routines.create({ name: "Ada's watch", prompt: "Watch.", botId: member.id, enabled: true, checks: ["mail", "calendar"], deliver: "brief",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 } });
    expect(first.proactive.ensureWatch()).toBeNull();
    expect(first.routines.listRoutines().find((routine) => routine.id === restored.id)?.botId).toBe(chief.id);
    expect(await first.proactive.checks.check(own, { manual: true })).toEqual({});
    expect(await first.proactive.checks.check(restored, { manual: true })).toEqual({});
    // Off a team too, a member's MausBot is never the proactive bot.
    const untagged = start();
    expect(proactiveOwner(untagged.store)?.id).toBe(chief.id);
    expect(await untagged.proactive.checks.check(own, { manual: true })).toEqual({});
    expect([...first.reads, ...untagged.reads]).toEqual([]);
  });

  it("moves to My Cloud with MausBot, untouched as it looks, once the person changed the watch, and is the only watch on there", async () => {
    // This computer: the watch was handed to a MausBot nobody has opened yet.
    const { first, clive, watch } = existingInstall();
    const maus = ensureDefaultBot(first.store, { dataDir: DATA_DIR })!;
    const here = start();
    here.proactive.ensureWatch();
    const deps = (place: ReturnType<typeof start>): MoveKindsDeps => ({ dataDir: DATA_DIR, store: place.store, routines: () => place.routines, calls: () => null, webhooks: () => null,
      appEvents: () => null, claudeCodeSkills: () => [], instanceExists: () => true, owner: () => OWNER, ownRoutine: () => {} } as unknown as MoveKindsDeps);
    const sources = (withRoutines: boolean): CloudSendSources => ({
      appVersion: "0.0.0", bots: () => here.store.bots, skills: () => [], picture: () => null, logins: () => [], onePassword: () => null, settings: () => ({}),
      greetingOnly: (threadId, name) => {
        const rows = here.store.messagesFor(threadId);
        return rows.length === 1 && rows[0]!.role === "bot" && Boolean(rows[0]!.text?.includes(name));
      },
      ...(withRoutines ? { automated: (botId: string) => automatedBot(deps(here), botId) } : {}),
      move: { items: (bots, only) => moveItems(deps(here), bots, only), botParts: () => ({}) },
    });
    const carries = (key: string, options: { move: boolean }) => cloudSendSummary(sources(true), options).items.some((item) => item.key === key);
    expect(carries(`bot:${maus.id}`, { move: true }), "the watch as the server made it is nobody's use").toBe(false);
    here.routines.update(watch.id, { prompt: "Watch for Ada." });
    expect(carries(`bot:${maus.id}`, { move: false }), "a send without the routines leaves it as it was").toBe(false);
    const carried = cloudSendSummary(sources(true), { move: true }).items;
    expect(carried.some((item) => item.key === `bot:${maus.id}`)).toBe(true);
    expect(carried.find((item) => item.key === `routine:${watch.id}`)).toMatchObject({ bot: maus.id });
    expect(cloudSendSummary(sources(false), { move: true }).items.some((item) => item.key === `routine:${watch.id}`), "without its routines it looked unused").toBe(false);
    const pick = (bot: BotRecord) => Object.fromEntries(MOVE_BOT_FIELDS.map((name) => [name, (bot as unknown as Record<string, unknown>)[name] ?? null]));
    const mausFields = pick(here.store.bot(maus.id)!), cliveFields = pick(here.store.bot(clive.id)!);
    const routine = kindRecord(deps(here), "routine", watch.id)!;

    // My Cloud: its own MausBot and its own watch, then this computer's bots, then its automations, as a move sends them.
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    const cloud = start();
    cloud.store.seedIfEmpty();
    const starter = ensureDefaultBot(cloud.store, { dataDir: DATA_DIR })!;
    const own = cloud.proactive.ensureWatch()!;
    expect(own.botId).toBe(starter.id);
    const take = async (key: string, record: unknown, runs?: unknown) => {
      let status = 0;
      await moveKindsRoute(deps(cloud), { path: "/api/cloud-send/kind", method: "PUT", url: new URL("http://127.0.0.1/api/cloud-send/kind"), auth: {} as never, req: {} as never,
        res: { setHeader() {} } as never, json: ((_res: unknown, code: number) => { status = code; }) as never,
        readBody: (async () => ({ v: 1, key, dataDir: "/Users/amit/.openmausbot", record, ...(runs ? { runs } : {}) })) as never });
      return status;
    };
    cloud.store.createBot({ name: "Clive" }, { id: clive.id, seedMessages: false });
    cloud.store.createBot({ name: "MausBot" }, { id: maus.id, seedMessages: false });
    expect(await take(`bot:${clive.id}`, cliveFields)).toBe(200);
    expect(await take(`bot:${maus.id}`, mausFields)).toBe(200);
    cloud.proactive.ensureWatch();
    expect(proactiveOwner(cloud.store)?.id).toBe(maus.id);
    expect(await take(`routine:${watch.id}`, routine.record, routine.runs)).toBe(200);
    cloud.routines.update(watch.id, { enabled: true });
    cloud.proactive.ensureWatch();
    cloud.proactive.ensureWatch();

    expect(cloud.on().map((one) => [one.id, one.botId, one.prompt])).toEqual([[watch.id, maus.id, "Watch for Ada."]]);
    expect(cloud.briefing().find((one) => one.id === own.id)).toMatchObject({ botId: starter.id, enabled: false });
    expect(cloud.briefing()).toHaveLength(2);
    expect(json(BRIEF_FILE).home).toEqual({ botId: maus.id, threadId: cloud.store.bot(maus.id)!.threadId });
  });
});
