import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertBotHere, botMoveRefusal, COMPUTER_TEAM_PREFIX, createBotMoves, MY_CLOUD_TEAM, personalTeam } from "./bot-moves.ts";
import { arrivalsFile } from "./move-back.ts";
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

describe("a bot moving from this computer to My Cloud", () => {
  const MY_CLOUD = { id: MY_CLOUD_TEAM, name: "My Cloud" };
  function here() {
    const bots = new Map<string, Record<string, unknown>>([["scout", { id: "scout", name: "Scout" }], ["pip", { id: "pip", name: "Pip" }], ["maus", { id: "maus", name: "Maus", defaultBot: { v: 1 } }]]);
    const groups = [{ id: "both", memberIds: ["scout", "pip"], dm: false }, { id: "alone", memberIds: ["scout", "maus"], dm: false }];
    const routines = [{ id: "brief", botId: "scout", enabled: true }];
    const removed: string[] = [];
    const moves = createBotMoves({
      store: { bot: (id) => (bots.get(id) as unknown as BotRecord) ?? null, patchBot: (id, patch) => Object.assign(bots.get(id)!, patch) as unknown as BotRecord, groups,
        patchGroup: (id, patch) => Object.assign(groups.find((group) => group.id === id)!, patch) },
      routines: () => ({ listRoutines: () => routines as never, update: (id: string, patch: { enabled?: boolean }) => Object.assign(routines.find((routine) => routine.id === id)!, patch) as never, removeForBot: (botId: string) => { removed.push(botId); } }),
      webhooks: () => null, appEvents: () => null, waits: () => null, busy: () => false,
    });
    return { moves, bots, groups, routines, removed };
  }

  it("keeps its routines here, off, leaves a room some of whose bots stay, and keeps a room all of whose bots left", async () => {
    const { moves, bots, groups, routines, removed } = here();
    await moves.hold("scout", MY_CLOUD);
    moves.moved("scout", MY_CLOUD);
    expect(removed, "My Cloud ending brings it back with them").toEqual([]);
    expect(routines[0]!.enabled).toBe(false);
    expect(bots.get("scout")).toMatchObject({ hidden: true, movedTo: { state: "moved" } });
    expect(groups.find((group) => group.id === "both")!.memberIds, "the room goes on here without it").toEqual(["pip"]);
    expect(groups.find((group) => group.id === "alone")!.memberIds, "only the helper every place has is left").toEqual(["scout", "maus"]);
  });

  it("is here again as it went if My Cloud ends, its automations left off", async () => {
    const { moves, bots, routines } = here();
    await moves.hold("scout", MY_CLOUD);
    moves.moved("scout", MY_CLOUD);
    expect(moves.back("scout")).toEqual({ released: true });
    expect(bots.get("scout")).toMatchObject({ hidden: false, movedTo: undefined });
    expect(routines[0]!.enabled).toBe(false);
    expect(moves.back("pip"), "a bot that never left has nothing to come back from").toEqual({ released: true });
  });

  it("a bot that went into a team never comes back this way", async () => {
    const { moves } = here();
    await moves.hold("pip", ACME);
    moves.moved("pip", ACME);
    expect("refused" in moves.back("pip")).toBe(true);
  });
});

it("a bot that lives in another of the person's places takes no turn here, and says where it lives", () => {
  const standIn = { name: "Atlas", home: { place: "ab12cd34", placeName: "My Cloud", botId: "b1" } };
  expect(botMoveRefusal(standIn)).toBe("Atlas lives on My Cloud: its turns run there, not here.");
  expect(() => assertBotHere(standIn)).toThrow(/lives on My Cloud/);
  expect(botMoveRefusal({ name: "Scout" })).toBeNull();
});

describe("a bot coming back from My Cloud to this computer, and going there again", () => {
  const MY_CLOUD = { id: MY_CLOUD_TEAM, name: "My Cloud" };
  const LAPTOP = { id: `${COMPUTER_TEAM_PREFIX}inst-1`, name: "MacBook Air" };
  const MINUTE = 60_000;

  /** One place's server: a stub of Scout (or Scout live), its routines, webhook and app event, the MCP servers it has. */
  function place({ computer = true, scout = "stub" as "stub" | "live" | "none", createdAt = 0, busy = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "omb-move-back-"));
    dirs.push(dir);
    let clock = 10 * MINUTE;
    const bots = new Map<string, Record<string, unknown>>();
    if (scout === "stub") bots.set("scout", { id: "scout", name: "Scout", createdAt, hidden: true, mcpServers: ["notes"], movedTo: { team: computer ? MY_CLOUD : LAPTOP, state: "moved", at: 1, held: ["routine:brief"] } });
    if (scout === "live") bots.set("scout", { id: "scout", name: "Scout", createdAt, mcpServers: ["notes"] });
    bots.set("pip", { id: "pip", name: "Pip", createdAt: 0 });
    const routines = [{ id: "brief", name: "Morning brief", botId: "scout", enabled: false }, { id: "weekly", name: "Weekly", botId: "scout", enabled: false }];
    const hooks = [{ id: "orders", name: "Orders", botId: "scout", enabled: false }];
    const events = [{ id: "mail", name: "New mail", botId: "scout", enabled: false }];
    const removed: string[] = [];
    const deps = {
      store: { bot: (id: string) => (bots.get(id) as unknown as BotRecord) ?? null, patchBot: (id: string, patch: object) => Object.assign(bots.get(id)!, patch) as unknown as BotRecord,
        get bots() { return [...bots.values()] as unknown as BotRecord[]; } },
      routines: () => ({ listRoutines: () => routines as never, update: (id: string, patch: { enabled?: boolean }) => Object.assign(routines.find((routine) => routine.id === id)!, patch) as never,
        removeForBot: (botId: string) => { removed.push(botId); } }),
      webhooks: () => ({ list: () => hooks as never, update: (id: string, patch: unknown) => Object.assign(hooks.find((hook) => hook.id === id)!, patch as object) as never }),
      appEvents: () => ({ list: () => events as never, update: async (id: string, patch: unknown) => Object.assign(events.find((event) => event.id === id)!, patch as object) as never }),
      waits: () => null, busy: () => busy, now: () => clock, computer,
      mcp: () => ({ all: ["notes", "shell", "docs"], command: ["notes", "shell"] }),
      arrivals: arrivalsFile(dir),
      stays: () => ({ logins: 2, secrets: 1, onePassword: true, connections: ["linear"] }),
    };
    const moves = createBotMoves(deps);
    return { moves, bots, routines, hooks, events, removed, dir, tick: (ms: number) => { clock += ms; }, again: () => createBotMoves(deps) };
  }
  const scoutOf = (bots: Map<string, Record<string, unknown>>) => bots.get("scout") as Record<string, any>;
  const live = (bot: Record<string, any>) => !bot.movedTo && bot.hidden !== true && botMoveRefusal(bot as never) === null;

  it("holds the stub as returning: hidden, no turns, keeps what it had; stopped, it is the stub it was, nothing switched on", async () => {
    const { moves, bots, routines } = place();
    const held = await moves.hold("scout", MY_CLOUD, { back: true });
    expect(held).toMatchObject({ movedTo: { team: MY_CLOUD, state: "moving", back: true, had: { mcp: ["notes"] }, held: ["routine:brief"] } });
    expect(scoutOf(bots).hidden).toBe(true);
    expect(() => assertBotHere(scoutOf(bots) as never)).toThrow("Scout is coming here from My Cloud. It's ready here in a moment.");
    expect(await moves.hold("scout", MY_CLOUD), "no forward hold of a bot that is coming here").toEqual({ refused: "Scout is coming here from My Cloud. It's ready here in a moment." });
    expect(await moves.release("scout")).toEqual({ released: true });
    expect(scoutOf(bots)).toMatchObject({ hidden: true, movedTo: { team: MY_CLOUD, state: "moved", held: ["routine:brief"] } });
    expect(scoutOf(bots).movedTo.back).toBeUndefined();
    expect(routines.every((routine) => !routine.enabled), "the bot lives on My Cloud: nothing of it runs here").toBe(true);
  });

  it("refuses a live bot with the same id, and only takes a bot the move just made as its first arrival", async () => {
    const here = place({ scout: "live", createdAt: 0 });
    here.tick(60 * MINUTE);
    expect(await here.moves.hold("scout", MY_CLOUD, { back: true })).toEqual({ refused: "Scout is already here.", here: true });
    expect(await here.moves.hold("scout", MY_CLOUD, { back: true, arrival: true }), "an older bot is the person's own").toEqual({ refused: "Scout is already here.", here: true });
    expect(live(scoutOf(here.bots))).toBe(true);
    const fresh = place({ scout: "live", createdAt: 9 * MINUTE });
    expect(await fresh.moves.hold("scout", MY_CLOUD, { back: true, arrival: true })).toMatchObject({ movedTo: { back: true, arrival: true, had: { mcp: [] } } });
    expect(scoutOf(fresh.bots).hidden).toBe(true);
    // Stopped, a first arrival is the line of where it lives, never deleted and never live here.
    expect(await fresh.moves.release("scout")).toEqual({ released: true });
    expect(scoutOf(fresh.bots)).toMatchObject({ hidden: true, movedTo: { team: MY_CLOUD, state: "moved" } });
    expect((await fresh.moves.hold("scout", MY_CLOUD, { back: true }) as { movedTo: object }).movedTo, "the next try takes its line as returning").toMatchObject({ back: true });
    expect(await place({ scout: "none" }).moves.hold("scout", MY_CLOUD, { back: true })).toEqual({ refused: "This bot is no longer here." });
    expect(await place().moves.hold("scout", { id: "team-other", name: "Other" }, { back: true }), "a stub of another place").toEqual({ refused: "Scout lives in My Cloud now." });
  });

  it("arrives on this computer: live, routines that were on there on, webhooks, app events and new command MCP servers off, said once and the same when asked again", async () => {
    const { moves, bots, routines, hooks, events, again } = place();
    await moves.hold("scout", MY_CLOUD, { back: true });
    // What the move sent while it came: the Cloud's newer tools, and its archived switch, which waits for the arrival.
    Object.assign(scoutOf(bots), { mcpServers: ["notes", "shell", "docs"] });
    scoutOf(bots).movedTo = { ...scoutOf(bots).movedTo, archived: false };
    const on = ["routine:brief", "webhook:orders", "app-event:mail", "routine:elsewhere"];
    const answer = await moves.arrived("scout", MY_CLOUD, on);
    expect(answer).toEqual({ arrived: { v: 1, from: MY_CLOUD, hold: 10 * MINUTE, at: 10 * MINUTE, place: "computer",
      on: { routines: [{ id: "brief", name: "Morning brief" }], webhooks: [], appEvents: [] },
      offHere: { webhooks: [{ id: "orders", name: "Orders" }], appEvents: [{ id: "mail", name: "New mail" }], mcpServers: ["shell"] } } });
    expect(live(scoutOf(bots))).toBe(true);
    expect(scoutOf(bots).mcpServers, "the command server it did not use here stays off; the remote one stays on").toEqual(["notes", "docs"]);
    expect([on.length, routines.map((routine) => routine.enabled), hooks[0]!.enabled, events[0]!.enabled]).toEqual([4, [true, false], false, false]);
    expect(await moves.arrived("scout", MY_CLOUD, on), "asked again").toEqual(answer);
    expect(await again().arrived("scout", MY_CLOUD, []), "after a restart, from what was kept").toEqual(answer);
    expect(moves.state("scout")).toEqual({ movedTo: null, holding: false, arrived: (answer as { arrived: unknown }).arrived });
    expect(await moves.arrived("pip", MY_CLOUD, []), "a bot that is not coming").toEqual({ refused: "This bot is not coming here." });
  });

  it("finishes an arrival a crash cut short, from what it kept first", async () => {
    const { moves, bots, routines } = place();
    await moves.hold("scout", MY_CLOUD, { back: true });
    // The facts were kept and the routine switched on, then the server stopped before the bot was let go of.
    const first = await moves.arrived("scout", MY_CLOUD, ["routine:brief"]);
    scoutOf(bots).movedTo = { team: MY_CLOUD, state: "moving", at: 10 * MINUTE, back: true, had: { mcp: ["notes"] } };
    scoutOf(bots).hidden = true;
    routines[0]!.enabled = false;
    expect(await moves.arrived("scout", MY_CLOUD, ["routine:weekly"]), "the same arrival, done the same way").toEqual(first);
    expect([live(scoutOf(bots)), routines.map((routine) => routine.enabled)]).toEqual([true, [true, false]]);
  });

  it("an arriving bot with every MCP server on gets none new when it used every one here, and all command ones off when it is new here", async () => {
    const stub = place();
    delete scoutOf(stub.bots).mcpServers;
    await stub.moves.hold("scout", MY_CLOUD, { back: true });
    expect((await stub.moves.arrived("scout", MY_CLOUD, []) as { arrived: { offHere: { mcpServers: string[] } } }).arrived.offHere.mcpServers).toEqual([]);
    expect(scoutOf(stub.bots).mcpServers).toBeUndefined();
    const fresh = place({ scout: "live", createdAt: 10 * MINUTE });
    delete scoutOf(fresh.bots).mcpServers;
    await fresh.moves.hold("scout", MY_CLOUD, { back: true, arrival: true });
    expect((await fresh.moves.arrived("scout", MY_CLOUD, []) as { arrived: { offHere: { mcpServers: string[] } } }).arrived.offHere.mcpServers).toEqual(["notes", "shell"]);
    expect(scoutOf(fresh.bots).mcpServers).toEqual(["docs"]);
  });

  it("on My Cloud, a bot leaving for a computer keeps its routines there, off, and the answer says what stays; going there again switches on all that was on", async () => {
    const cloud = place({ computer: false, scout: "live" });
    cloud.routines[0]!.enabled = true;
    cloud.hooks[0]!.enabled = true;
    const held = await cloud.moves.hold("scout", LAPTOP, { lapse: true });
    expect(held).toMatchObject({ movedTo: { team: LAPTOP, state: "moving", held: ["routine:brief", "webhook:orders"], lapseAt: 40 * MINUTE } });
    expect(cloud.moves.moved("scout", LAPTOP)).toEqual({ movedTo: { team: LAPTOP, state: "moved", at: 10 * MINUTE, held: ["routine:brief", "webhook:orders"] },
      stays: { logins: 2, secrets: 1, onePassword: true, connections: ["linear"] } });
    expect([cloud.removed, cloud.routines.map((routine) => routine.enabled)], "kept, off").toEqual([[], [false, false]]);
    expect(cloud.moves.back("scout"), "a computer's line comes back if the person wants it").toEqual({ released: true });

    const again = place({ computer: false });
    await again.moves.hold("scout", LAPTOP, { back: true });
    const arrived = await again.moves.arrived("scout", LAPTOP, ["routine:brief", "webhook:orders", "app-event:mail"]);
    expect(arrived).toMatchObject({ arrived: { place: "cloud", on: { routines: [{ id: "brief" }], webhooks: [{ id: "orders" }], appEvents: [{ id: "mail" }] }, offHere: { webhooks: [], appEvents: [], mcpServers: [] } } });
    expect([again.routines[0]!.enabled, again.hooks[0]!.enabled, again.events[0]!.enabled, live(scoutOf(again.bots))]).toEqual([true, true, true, true]);
  });

  it("a lapsing hold not renewed lets the bot go on where it is, as it was; renewed, it holds; one that moved never lapses", async () => {
    const cloud = place({ computer: false, scout: "live" });
    cloud.routines[0]!.enabled = true;
    await cloud.moves.hold("scout", LAPTOP, { lapse: true });
    cloud.tick(29 * MINUTE);
    expect(await cloud.moves.sweep()).toEqual([]);
    expect((await cloud.moves.hold("scout", LAPTOP, { lapse: true }) as { movedTo: { lapseAt: number } }).movedTo.lapseAt, "renewed").toBe(69 * MINUTE);
    cloud.tick(29 * MINUTE);
    expect(await cloud.moves.sweep()).toEqual([]);
    cloud.tick(2 * MINUTE);
    expect(await cloud.moves.sweep()).toEqual(["scout"]);
    expect([live(scoutOf(cloud.bots)), cloud.routines[0]!.enabled], "working on My Cloud again, its routine back on").toEqual([true, true]);
    expect(cloud.moves.moved("scout", LAPTOP), "the switch after a lapse finds no hold").toEqual({ refused: "This bot is not moving to that team." });

    const plain = place({ computer: false, scout: "live" });
    await plain.moves.hold("scout", ACME);
    plain.tick(10 * 60 * MINUTE);
    expect(await plain.moves.sweep(), "a hold that did not ask to lapse holds").toEqual([]);

    const moved = place({ computer: false, scout: "live" });
    await moved.moves.hold("scout", LAPTOP, { lapse: true });
    moved.moves.moved("scout", LAPTOP);
    moved.tick(60 * MINUTE);
    expect(await moved.moves.sweep()).toEqual([]);
    expect(scoutOf(moved.bots).movedTo.state).toBe("moved");

    const back = place();
    await back.moves.hold("scout", MY_CLOUD, { back: true, lapse: true });
    back.tick(31 * MINUTE);
    expect(await back.moves.sweep()).toEqual(["scout"]);
    expect(scoutOf(back.bots)).toMatchObject({ hidden: true, movedTo: { state: "moved" } });
  });

  it("remembers what the stub used here across a stopped try, so command servers new here still arrive off after an undo", async () => {
    const { moves, bots } = place();
    await moves.hold("scout", MY_CLOUD, { back: true });
    scoutOf(bots).mcpServers = ["notes", "shell", "docs"];
    await moves.release("scout");
    expect((await moves.hold("scout", MY_CLOUD, { back: true }) as { movedTo: object }).movedTo).toMatchObject({ had: { mcp: ["notes"] } });
    expect((await moves.arrived("scout", MY_CLOUD, []) as { arrived: { offHere: { mcpServers: string[] } } }).arrived.offHere.mcpServers).toEqual(["shell"]);
    const fresh = place({ scout: "live", createdAt: 10 * MINUTE });
    await fresh.moves.hold("scout", MY_CLOUD, { back: true, arrival: true });
    scoutOf(fresh.bots).mcpServers = ["shell"];
    await fresh.moves.release("scout");
    expect((await fresh.moves.hold("scout", MY_CLOUD, { back: true }) as { movedTo: object }).movedTo, "a first arrival had none here").toMatchObject({ had: { mcp: [] } });
  });

  it("a hold past its time no longer holds before the sweep has run: no switch, no arrival, and holding again is a new hold", async () => {
    const cloud = place({ computer: false, scout: "live" });
    cloud.routines[0]!.enabled = true;
    const first = await cloud.moves.hold("scout", LAPTOP, { lapse: true }) as { movedTo: { at: number; lapseAt: number } };
    expect(cloud.moves.nextLapseAt(), "a sleeping Cloud wakes for it").toBe(first.movedTo.lapseAt);
    cloud.tick(31 * MINUTE);
    expect(cloud.moves.state("scout")).toMatchObject({ holding: false });
    expect(cloud.moves.moved("scout", LAPTOP)).toEqual({ refused: "This bot is not moving to that team." });
    const again = await cloud.moves.hold("scout", LAPTOP, { lapse: true }) as { movedTo: { at: number } };
    expect(again.movedTo.at, "a new hold, so the move copies again what the bot did meanwhile").toBe(41 * MINUTE);
    expect(cloud.routines[0]!.enabled, "switched back on and off again by the new hold").toBe(false);
    const here = place();
    await here.moves.hold("scout", MY_CLOUD, { back: true, lapse: true });
    here.tick(31 * MINUTE);
    expect(await here.moves.arrived("scout", MY_CLOUD, [])).toEqual({ refused: "This bot is not coming here from there." });
    expect(live(scoutOf(here.bots))).toBe(false);
    expect(place().moves.nextLapseAt()).toBeNull();
  });

  it("waits for a turn going on My Cloud before it holds the bot there", async () => {
    const cloud = place({ computer: false, scout: "live", busy: true });
    expect(await cloud.moves.hold("scout", LAPTOP, { lapse: true })).toEqual({ busy: "Scout" });
    expect(scoutOf(cloud.bots).movedTo).toBeUndefined();
  });

  it("a computer team is a place of the person's own; a team's own id never is", () => {
    expect([personalTeam(MY_CLOUD_TEAM), personalTeam("computer-inst-1"), personalTeam("computer-"), personalTeam("0b6f8e52-9d6c-4f0e-8f43-2f0c3cf8c1d2")]).toEqual([true, true, false, false]);
  });
});
