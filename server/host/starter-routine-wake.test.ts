import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCoordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import { Store } from "../store.ts";
import { createStarterAwake } from "./starter-awake.ts";
import { createStarterRoutineWake, PAUSED_RUN_ROUTINE_TURNS_ONLY, PAUSED_RUN_SCHEDULES_ONLY, routineBots, workInFlight, type RoutineLike } from "./starter-routine-wake.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Seven bots made a minute apart, Bot 0 first: Bots 2–6 awake on Starter, Bots 0 and 1 paused. */
function cloud(options: { starter?: boolean; held?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "starter-routine-wake-")); dirs.push(dir);
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const made = Array.from({ length: 7 }, (_, n) => store.createBot({ name: `Bot ${n}` }));
  // Only this test's bots: a Store reads whatever an earlier one in this data folder saved.
  const bots = () => made.map((bot, n) => ({ ...store.bot(bot.id)!, createdAt: n * 60_000, tasks: [] }));
  const awake = createStarterAwake({ dataDir: dir, starter: () => options.starter ?? true, bots });
  awake.paused();
  const items: RoutineLike[] = [], triggers: RoutineLike[] = [];
  const wake = createStarterRoutineWake({ awake, store, routines: () => items, triggers: () => triggers, busy: () => false, held: (botId) => options.held !== undefined && made[options.held]?.id === botId });
  const id = (n: number) => made[n]!.id;
  const notices = (n: number) => store.messagesFor(made[n]!.threadId).filter((row) => row.kind === "activity").map((row) => row.tool?.name);
  return { store, awake, wake, items, triggers, id, notices };
}

describe("a routine's bot on a Starter Cloud", () => {
  it("wakes the bot when a routine for it is switched on, and says so once in its own chat: which routine, which bot made room", () => {
    const { awake, wake, items, id, notices } = cloud();
    expect(awake.paused()).toEqual([id(0), id(1)]);
    const routine = { botId: id(0), name: "Morning report", enabled: true };
    items.push(routine);
    wake.emitted({ kind: "routine", routine });
    expect(awake.paused()).toEqual([id(1), id(2)]);
    expect(notices(0)).toEqual(["notice: Woke @Bot 0 for “Morning report”: this Cloud's Starter plan keeps 5 bots awake, so @Bot 2, idle for a while, is paused to make room. To swap them back, send @Bot 2 a message and choose which bots stay awake."]);
    // Its runs and later saves change nothing more and say nothing more.
    wake.emitted({ kind: "routine", routine });
    wake.running(id(0), "Morning report");
    expect([awake.paused(), notices(0).length]).toEqual([[id(1), id(2)], 1]);
  });

  it("wakes a bot for its webhook and app trigger too (not with option B), and leaves a switched-off one, a room goal, a webhook that only posts, or another frame alone", () => {
    const { awake, wake, triggers, id } = cloud();
    const posts = { botId: id(0), name: "Post it", enabled: true, delivery: "post" };
    triggers.push(posts);
    wake.emitted({ kind: "routine", routine: { botId: id(0), name: "Off", enabled: false } });
    wake.emitted({ kind: "routine", routine: { botId: id(0), name: "Goal", enabled: true, target: "room-goal" } });
    wake.emitted({ kind: "webhook", webhook: posts });
    wake.emitted({ kind: "webhook.attempt", webhook: { botId: id(0), name: "Lead", enabled: true } });
    expect(awake.paused()).toEqual([id(0), id(1)]);
    const hook = { botId: id(0), name: "New lead", enabled: true }, app = { botId: id(1), name: "New email", enabled: true };
    triggers.push(hook, app);
    wake.emitted({ kind: "webhook", webhook: hook });
    wake.emitted({ kind: "app-trigger", botId: id(1), trigger: app });
    expect(awake.paused()).toEqual(PAUSED_RUN_SCHEDULES_ONLY ? [id(0), id(1)] : [id(2), id(3)]);
  });

  it("tells once that a routine ran while its bot stayed paused, when nothing awake can make room", () => {
    const { awake, wake, items, id, notices } = cloud();
    for (let n = 0; n < 7; n++) items.push({ botId: id(n), name: `Routine ${n}`, enabled: true });
    wake.saved(items[0]);
    expect(notices(0)).toEqual([]);
    wake.running(id(0), "Routine 0");
    wake.running(id(0), "Routine 0");
    expect(notices(0)).toEqual(["notice: @Bot 0 is taking care of “Routine 0” and otherwise stays paused: this Cloud's Starter plan keeps 5 bots awake. Its routines and triggers still run; to chat with it, send it a message and choose which bots stay awake."]);
    expect(awake.paused()).toEqual([id(0), id(1)]);
  });

  it("never wakes a bot the person paused, and does nothing off Starter", () => {
    const held = cloud({ held: 0 });
    held.items.push({ botId: held.id(0), name: "Report", enabled: true });
    held.wake.saved(held.items[0]);
    held.wake.running(held.id(0), "Report");
    expect([held.awake.paused(), held.notices(0)]).toEqual([[held.id(0), held.id(1)], []]);

    const off = cloud({ starter: false });
    off.items.push({ botId: off.id(0), name: "Report", enabled: true });
    off.wake.saved(off.items[0]);
    off.wake.running(off.id(0), "Report");
    expect([off.awake.paused(), off.notices(0)]).toEqual([[], []]);
  });

  it("refuses a run of a bot the limit paused only as the owner's options say, in the paused line", () => {
    const { wake, items, triggers, id } = cloud();
    items.push({ id: "off", botId: id(0), name: "Switched off", enabled: false }, { id: "on", botId: id(0), name: "Switched on", enabled: true });
    triggers.push({ id: "hook", botId: id(1), name: "New lead", enabled: true }, { id: "hook-off", botId: id(1), name: "Old lead", enabled: false });
    const paused = "Paused: Starter keeps 5 bots awake. Upgrade to wake it, or swap which bots are awake.";
    // Option A: Run now of a switched-off routine, or a person's test of a switched-off trigger.
    expect(wake.refusal({ botId: id(0), routineId: "off", manual: true })).toBe(PAUSED_RUN_ROUTINE_TURNS_ONLY ? paused : null);
    // Option B: any webhook, app-event or wait run.
    expect(wake.refusal({ botId: id(1), routineId: "hook", manual: false, triggerSource: "webhook" })).toBe(PAUSED_RUN_SCHEDULES_ONLY ? paused : null);
    expect(wake.refusal({ botId: id(1), routineId: "hook-off", manual: false, byPerson: true, triggerSource: "webhook" }))
      .toBe(PAUSED_RUN_ROUTINE_TURNS_ONLY || PAUSED_RUN_SCHEDULES_ONLY ? paused : null);
    // Never: Run now of an enabled routine, a scheduled run, or any run of an awake bot.
    expect(wake.refusal({ botId: id(0), routineId: "on", manual: true })).toBeNull();
    expect(wake.refusal({ botId: id(0), routineId: "off", manual: false, triggerSource: "schedule" })).toBeNull();
    expect(wake.refusal({ botId: id(6), routineId: "off", manual: true })).toBeNull();
  });

  it("counts only enabled routines and triggers that run the bot itself", () => {
    expect([...routineBots([{ botId: "a", name: "x", enabled: true }, { botId: "b", name: "x", enabled: false }, { botId: "c", name: "x", enabled: true, target: "room-goal" },
      { botId: "d", name: "x", enabled: true, target: "bot" }, { botId: "e", name: "x", enabled: true, delivery: "post" }, { botId: "f", name: "x", enabled: true, delivery: "run" }])]).toEqual(["a", "d", "f"]);
  });
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("which awake bot a routine may not pause, with the real coordinator", () => {
  type Ask = "outstandingFor" | "activeDirect" | "parkedFor";
  /** A coordinator whose turns answer with `answer(node)`, and `busy` reading it through `asks` only (all by default), so each
   * of its answers is shown to count on its own. */
  function coordinated(answer: (node: HandoffView) => HostTurnResult) {
    const host: CoordinatorHost = {
      validate: vi.fn(() => undefined), busy: vi.fn(() => false), run: vi.fn(async (node: HandoffView) => answer(node)), report: vi.fn(), changed: vi.fn(),
      names: vi.fn((node: HandoffView) => ({ requester: "Chief", assignee: node.botId })), park: vi.fn(), levelOf: vi.fn(() => ({ level: "ask" as const })), chiefOf: vi.fn(() => false),
    };
    const coordinator = createCoordinator({ dataDir: ":memory:", host, log: () => {} });
    const extra = { checkBacks: new Map<string, number>(), waits: new Map<string, number>() };
    const busy = (botId: string, asks: Ask[] = ["outstandingFor", "activeDirect", "parkedFor"]) => workInFlight({
      conversations: (id) => [`${id}-chat`], turnActive: () => false, conversationBusy: () => false,
      coordinator: {
        outstandingFor: (threadId) => (asks.includes("outstandingFor") ? coordinator.outstandingFor(threadId) : []),
        activeDirect: (threadId) => asks.includes("activeDirect") && coordinator.activeDirect(threadId),
        parkedFor: (id) => (asks.includes("parkedFor") ? coordinator.parkedFor(id) : []),
      },
      checkBacks: (_botId, threadId) => extra.checkBacks.get(threadId) ?? 0, waits: (id) => extra.waits.get(id) ?? 0,
    })(botId);
    return { coordinator, busy, extra };
  }
  const address = (botId: string) => ({ botId, threadId: `${botId}-chat` });

  it("keeps a bot whose own conversation is parked on a question card for the person", () => {
    const { coordinator, busy } = coordinated(() => ({ ok: true, text: "" }));
    coordinator.beginTurn({ id: "gen-b", address: address("b"), brief: "Pick a plan", level: "ask", origin: { kind: "user", request: "Pick a plan" } });
    coordinator.endTurn("gen-b", { ok: true, text: "", cards: { question: "Which option?", ids: ["card-1"] } });
    expect(coordinator.outstandingFor("b-chat")).toEqual([]);
    expect([busy("b"), busy("b", ["activeDirect"]), busy("b", ["outstandingFor"]), busy("idle")]).toEqual([true, true, false, false]);
  });

  it("keeps a bot whose handed-off work waits on the person, and one that waits on work it handed out", async () => {
    const { coordinator, busy } = coordinated((node) => (node.botId === "b" ? { ok: true, text: "NEEDS INPUT: CSV or Excel?" } : { ok: true, text: "" }));
    coordinator.beginTurn({ id: "gen-chief", address: address("chief"), brief: "Export", level: "ask", origin: { kind: "user", request: "Export" } });
    coordinator.enqueue(address("chief"), "gen-chief", undefined, address("b"), "Export the report");
    coordinator.endTurn("gen-chief", { ok: true, text: "" });
    coordinator.tick(); await flush();
    expect(coordinator.parkedFor("b")).toHaveLength(1);
    expect([busy("b"), busy("b", ["parkedFor"]), busy("chief"), busy("chief", ["outstandingFor"])]).toEqual([true, true, true, true]);
    expect([busy("b", ["outstandingFor"]), busy("chief", ["parkedFor"])]).toEqual([false, false]);
  });

  it("keeps a bot with a check-back or a wait, and lets an idle one go", () => {
    const { busy, extra } = coordinated(() => ({ ok: true, text: "" }));
    expect(busy("b")).toBe(false);
    extra.checkBacks.set("b-chat", 1);
    expect(busy("b")).toBe(true);
    extra.checkBacks.clear();
    extra.waits.set("b", 1);
    expect(busy("b")).toBe(true);
  });
});
