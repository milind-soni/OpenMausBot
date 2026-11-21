import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Store } from "../store.ts";
import { createStarterAwake } from "./starter-awake.ts";
import { createStarterRoutineWake, routineBots, type RoutineLike } from "./starter-routine-wake.ts";

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
  const items: RoutineLike[] = [];
  const wake = createStarterRoutineWake({ awake, store, items: () => items, busy: () => false, held: (botId) => options.held !== undefined && made[options.held]?.id === botId });
  const id = (n: number) => made[n]!.id;
  const notices = (n: number) => store.messagesFor(made[n]!.threadId).filter((row) => row.kind === "activity").map((row) => row.tool?.name);
  return { store, awake, wake, items, id, notices };
}

describe("a routine's bot on a Starter Cloud", () => {
  it("wakes the bot when a routine for it is switched on, and says so once in its own chat: which routine, which bot made room", () => {
    const { awake, wake, items, id, notices } = cloud();
    expect(awake.paused()).toEqual([id(0), id(1)]);
    const routine = { botId: id(0), name: "Morning report", enabled: true };
    items.push(routine);
    wake.emitted({ kind: "routine", routine });
    expect(awake.paused()).toEqual([id(1), id(2)]);
    expect(notices(0)).toEqual(["notice: Woke @Bot 0 for its routine “Morning report”: this Cloud's Starter plan keeps 5 bots awake, so @Bot 2 is paused to make room. To swap them back, send @Bot 2 a message and choose which bots stay awake."]);
    // Its runs and later saves change nothing more and say nothing more.
    wake.emitted({ kind: "routine", routine });
    wake.running(id(0), "Morning report");
    expect([awake.paused(), notices(0).length]).toEqual([[id(1), id(2)], 1]);
  });

  it("wakes a bot for its webhook and app trigger too, and leaves a switched-off one, a room goal, or another frame alone", () => {
    const { awake, wake, items, id } = cloud();
    wake.emitted({ kind: "routine", routine: { botId: id(0), name: "Off", enabled: false } });
    wake.emitted({ kind: "routine", routine: { botId: id(0), name: "Goal", enabled: true, target: "room-goal" } });
    wake.emitted({ kind: "webhook.attempt", webhook: { botId: id(0), name: "Lead", enabled: true } });
    expect(awake.paused()).toEqual([id(0), id(1)]);
    const hook = { botId: id(0), name: "New lead", enabled: true }, app = { botId: id(1), name: "New email", enabled: true };
    items.push(hook, app);
    wake.emitted({ kind: "webhook", webhook: hook });
    wake.emitted({ kind: "app-trigger", botId: id(1), trigger: app });
    expect(awake.paused()).toEqual([id(2), id(3)]);
  });

  it("tells once that a routine ran while its bot stayed paused, when nothing awake can make room", () => {
    const { awake, wake, items, id, notices } = cloud();
    for (let n = 0; n < 7; n++) items.push({ botId: id(n), name: `Routine ${n}`, enabled: true });
    wake.saved(items[0]);
    expect(notices(0)).toEqual([]);
    wake.running(id(0), "Routine 0");
    wake.running(id(0), "Routine 0");
    expect(notices(0)).toEqual(["notice: Ran the routine “Routine 0” for @Bot 0, which stays paused: this Cloud's Starter plan keeps 5 bots awake. Its routines still run; to chat with it, send it a message and choose which bots stay awake."]);
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

  it("counts only enabled routines aimed at the bot itself", () => {
    expect([...routineBots([{ botId: "a", name: "x", enabled: true }, { botId: "b", name: "x", enabled: false }, { botId: "c", name: "x", enabled: true, target: "room-goal" }, { botId: "d", name: "x", enabled: true, target: "bot" }])]).toEqual(["a", "d"]);
  });
});
