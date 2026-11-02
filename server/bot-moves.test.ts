import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertBotHere, botMoveRefusal, createBotMoves } from "./bot-moves.ts";
import type { BotRecord } from "./store.ts";
import { WaitManager } from "./waits.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ACME = { id: "team-acme", name: "Acme" };

function waitsFor(settled: string[][]) {
  const dir = mkdtempSync(join(tmpdir(), "omb-bot-moves-"));
  dirs.push(dir);
  return new WaitManager({
    file: join(dir, "waits.json"), probes: { stamp: async () => null }, sourceAlive: () => true, botBusy: () => false,
    post: () => true, followUp: () => undefined, showCard: (wait) => `card-${wait.label}`, settleCard: (wait, how) => { settled.push([wait.label, how]); },
  });
}

function setup({ busy = false, waits = null as WaitManager | null } = {}) {
  const bots = new Map<string, Record<string, unknown>>([["scout", { id: "scout", name: "Scout" }], ["pip", { id: "pip", name: "Pip" }]]);
  const routines = [
    { id: "brief", botId: "scout", enabled: true }, { id: "weekly", botId: "scout", enabled: false }, { id: "pips", botId: "pip", enabled: true },
  ];
  const hooks = [{ id: "hook", botId: "scout", enabled: true }];
  const events = [{ id: "mail", botId: "scout", enabled: true }];
  const removed: string[] = [];
  const moves = createBotMoves({
    store: {
      bot: (id) => (bots.get(id) as unknown as BotRecord) ?? null,
      patchBot: (id, patch) => { const bot = bots.get(id)!; Object.assign(bot, patch); return bot as unknown as BotRecord; },
    },
    routines: () => ({ listRoutines: () => routines as never, update: (id: string, patch: { enabled?: boolean }) => Object.assign(routines.find((routine) => routine.id === id)!, patch) as never,
      removeForBot: (botId: string) => { removed.push(botId); for (let i = routines.length - 1; i >= 0; i--) if (routines[i]!.botId === botId) routines.splice(i, 1); } }),
    webhooks: () => ({ list: () => hooks as never, update: (id: string, patch: unknown) => Object.assign(hooks.find((hook) => hook.id === id)!, patch as object) as never }),
    appEvents: () => ({ list: () => events as never, update: async (id: string, patch: unknown) => Object.assign(events.find((event) => event.id === id)!, patch as object) as never }),
    waits: () => waits,
    busy: () => busy,
    now: () => 1_000,
  });
  return { moves, bots, routines, hooks, events, removed };
}
const on = (list: Array<{ id: string; enabled: boolean }>) => Object.fromEntries(list.map((entry) => [entry.id, entry.enabled]));

describe("My Cloud holding a bot while it moves into a team", () => {
  it("takes no turns and switches off its automations, keeping which were on; holding it again changes nothing", async () => {
    const { moves, bots, routines, hooks, events } = setup();
    expect(await moves.hold("scout", ACME)).toEqual({ movedTo: { team: ACME, state: "moving", at: 1_000, held: ["routine:brief", "webhook:hook", "app-event:mail"] } });
    expect([on(routines), on(hooks), on(events)]).toEqual([{ brief: false, weekly: false, pips: true }, { hook: false }, { mail: false }]);
    expect(() => assertBotHere(bots.get("scout") as never)).toThrow("Scout is moving to Acme. It's ready there in a moment.");
    expect(() => assertBotHere(bots.get("pip") as never)).not.toThrow();
    expect((await moves.hold("scout", ACME) as { movedTo: { held: string[] } }).movedTo.held).toEqual(["routine:brief", "webhook:hook", "app-event:mail"]);
    expect(await moves.hold("scout", { id: "team-beta", name: "Beta" })).toEqual({ refused: "Scout is moving to Acme. It's ready there in a moment." });
  });

  it("waits while the bot is answering, and refuses a bot that is gone", async () => {
    expect(await setup({ busy: true }).moves.hold("scout", ACME)).toEqual({ busy: "Scout" });
    expect(await setup().moves.hold("nobody", ACME)).toEqual({ refused: "This bot is no longer here." });
  });

  it("lets the bot go on as it was when the move stops: what it switched off comes back on, nothing else", async () => {
    const { moves, bots, routines, hooks, events } = setup();
    await moves.hold("scout", ACME);
    expect(await moves.release("scout")).toEqual({ released: true });
    expect([on(routines), on(hooks), on(events)]).toEqual([{ brief: true, weekly: false, pips: true }, { hook: true }, { mail: true }]);
    expect(bots.get("scout")!.movedTo).toBeUndefined();
    expect(() => assertBotHere(bots.get("scout") as never)).not.toThrow();
  });

  it("keeps the bot as the line that opens it in the team once it arrived: archived, its routines gone, never let go of after", async () => {
    const { moves, bots, routines, removed } = setup();
    await moves.hold("scout", ACME);
    expect(moves.moved("scout", { id: "team-beta", name: "Beta" })).toEqual({ refused: "This bot is not moving to that team." });
    expect(moves.moved("scout", ACME)).toMatchObject({ movedTo: { team: ACME, state: "moved" } });
    expect(bots.get("scout")).toMatchObject({ hidden: true, movedTo: { state: "moved" } });
    expect([removed, routines.map((routine) => routine.id)]).toEqual([["scout"], ["pips"]]);
    expect(botMoveRefusal(bots.get("scout") as never)).toBe("Scout lives in Acme now.");
    expect(await moves.release("scout")).toEqual({ refused: "Scout lives in Acme now." });
    expect(moves.moved("scout", ACME)).toMatchObject({ movedTo: { state: "moved" } });
    expect(removed, "once").toEqual(["scout"]);
    expect(moves.moved("pip", ACME)).toEqual({ refused: "This bot is not moving to that team." });
  });

  it("cancels the moving bot's waits, card and all, so none fires for a bot that lives in the team; other bots keep theirs", async () => {
    const settled: string[][] = [];
    const waits = waitsFor(settled);
    const made = (botId: string, label: string) => waits.create({ botId, threadId: `t-${botId}`, label, condition: { kind: "file_exists", path: `/${label}` }, followUp: "Tell them." });
    await made("scout", "the report"); await made("pip", "the build");
    const { moves } = setup({ waits });
    await moves.hold("scout", ACME);
    expect(waits.all().map((wait) => wait.botId)).toEqual(["pip"]);
    expect(settled).toEqual([["the report", "cancelled"]]);
    await made("scout", "the invoice");
    moves.moved("scout", ACME);
    expect(waits.all().map((wait) => wait.botId)).toEqual(["pip"]);
    expect(settled).toEqual([["the report", "cancelled"], ["the invoice", "cancelled"]]);
  });
});
