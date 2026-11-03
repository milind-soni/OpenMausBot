import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ drafts: [] as Array<[string, string]>, requests: [] as Array<[string, unknown]>, failWebhook: false }));

vi.mock("@/lib/drafts", () => ({ prependComposerDraft: (id: string, text: string) => fixture.drafts.push([id, text]) }));
vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init: { body?: string }) => {
    fixture.requests.push([path, JSON.parse(init.body ?? "{}")]);
    if (path === "/api/webhooks") {
      if (fixture.failWebhook) throw new Error("no");
      return { webhook: { id: `hook-${fixture.requests.length}` } };
    }
    return { bots: [{ id: "b1", name: "Desk", threadId: "t1" }], routines: [{ id: "r1" }, { id: "r2" }], connections: [{ name: "linear" }] };
  }),
}));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { ready: boolean }) => instance.ready }));

import type { Action, Bot, InstanceInfo } from "@/state/store";
import { GROK_EXPORT_FORMAT, grokMovePlan, parseGrokExport } from "../../shared/grok-import";
import {
  foundExports, goToGrokMoveTarget, grokMoveRows, missingRoutines, moveGrokBot, rebuildMessage, type GrokMoved, type GrokMoveFacts,
} from "./grok-move";

const planOf = (bot: Record<string, unknown>) => grokMovePlan(parseGrokExport(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [bot] }))[0]!, { timeZone: "UTC" });
const FULL = {
  name: "Desk",
  skills: [{ name: "Greet", instructions: "Hi." }],
  routines: [
    { name: "Open", instruction: "Open.", schedule_cron: "0 9 * * *" },
    { name: "Old", instruction: "Old.", schedule_cron: "0 9 * * *", paused: true },
    { name: "Hook", instruction: "Hook it.", trigger: "webhook" },
    { name: "Ping", instruction: "Answer the ping.", trigger: "slack", trigger_details: "#door" },
  ],
  apps: [{ name: "Linear", mcp_url: "https://mcp.linear.app/mcp", header_names: ["Authorization"] }, { name: "Gmail" }],
};
const bot = { id: "b1", name: "Desk", threadId: "t1" } as Bot;
const ready = [{ ready: true }] as unknown as InstanceInfo[];
const facts = (over: Partial<GrokMoveFacts> = {}): GrokMoveFacts => ({ instances: ready, routines: [], webhooks: [], seen: new Set(), ...over });
const movedOf = (input: Record<string, unknown>, over: Partial<GrokMoved> = {}): GrokMoved => ({
  plan: planOf(input), bot, routineIds: [], webhookIds: [], webhooksFailed: [], servers: [], serversSkipped: 0, ...over,
});

beforeEach(() => {
  fixture.drafts.length = 0;
  fixture.requests.length = 0;
  fixture.failWebhook = false;
});

describe("Finish setting up", () => {
  it("shows only what is needed: a Bot with nothing to do has no rows", () => {
    expect(grokMoveRows([movedOf({ name: "Desk", instructions: "Chat." })], facts())).toEqual([]);
  });

  it("asks for an AI only when none is ready, and not before the instances are known", () => {
    const quiet = [movedOf({ name: "Desk" })];
    expect(grokMoveRows(quiet, facts({ instances: [{ ready: false }] as unknown as InstanceInfo[] })).map((row) => row.id)).toEqual(["ai"]);
    expect(grokMoveRows(quiet, facts({ instances: [] }))).toEqual([]);
    expect(grokMoveRows(quiet, facts())).toEqual([]);
  });

  it("lists every row, each going to the right place", () => {
    const rows = grokMoveRows([movedOf(FULL, { routineIds: ["r1"], webhookIds: ["w1"], servers: ["linear"] })], facts({ instances: [{ ready: false }] as unknown as InstanceInfo[] }));
    expect(rows.map((row) => [row.id, row.target.kind === "chat" ? { kind: "chat", botId: row.target.bot.id } : row.target])).toEqual([
      ["ai", { kind: "appSettings", section: "engines" }],
      ["signIn", { kind: "plugins", surface: "apps" }],
      ["appAccess", { kind: "botSettings", section: "access", botId: "b1" }],
      ["servers", { kind: "plugins", surface: "mcp" }],
      ["skills", { kind: "botSettings", section: "skills", botId: "b1" }],
      ["routines", { kind: "botSettings", section: "routines", botId: "b1" }],
      ["webhooks", { kind: "automations", botId: "b1" }],
      ["rebuild", { kind: "chat", botId: "b1" }],
    ]);
    expect(rows.find((row) => row.id === "signIn")!.title).toContain("Gmail");
    expect(rows.find((row) => row.id === "servers")!.detail).toContain("Authorization");
  });

  it.each([
    ["appSettings", { kind: "appSettings", section: "engines" }, [{ type: "toggleAppSettings", open: true, section: "engines" }]],
    ["plugins", { kind: "plugins", surface: "apps" }, [{ type: "togglePlugins", open: true, surface: "apps" }]],
    ["botSettings", { kind: "botSettings", section: "skills", botId: "b1" }, [{ type: "toggleSettings", open: true, section: "skills", botId: "b1" }]],
    ["automations", { kind: "automations", botId: "b1" }, [{ type: "toggleAppSettings", open: false }, { type: "showRoutines", botId: "b1" }]],
  ] as const)("a %s row dispatches the existing surface", (_name, target, actions) => {
    const seen: Action[] = [];
    goToGrokMoveTarget(target, (action) => seen.push(action));
    expect(seen).toEqual(actions);
  });

  it("the rebuild row puts a message in the bot's composer and never sends it", () => {
    const moved = movedOf(FULL);
    const [row] = grokMoveRows([moved], facts()).filter((candidate) => candidate.id === "rebuild");
    const seen: Action[] = [];
    goToGrokMoveTarget(row!.target, (action) => seen.push(action));
    expect(fixture.drafts).toEqual([["bot:b1:t1", rebuildMessage(moved)]]);
    expect(fixture.drafts[0]![1]).toContain("Answer the ping.");
    expect(fixture.drafts[0]![1]).toContain("#door");
    expect(seen.map((action) => action.type)).toEqual(["toggleAppSettings", "showChat", "select"]);
    expect(fixture.requests).toEqual([]);
  });

  it("ticks routines and webhooks by their real state, the rest once tapped", () => {
    const moved = [movedOf(FULL, { routineIds: ["r1"], webhookIds: ["w1"] })];
    const done = (over: Partial<GrokMoveFacts>) => grokMoveRows(moved, facts(over)).filter((row) => row.done).map((row) => row.id);
    expect(done({})).toEqual([]);
    expect(done({ seen: new Set(["b1:routines"]) })).toEqual([]);
    expect(done({ routines: [{ id: "r1", enabled: true }] })).toEqual(["routines"]);
    expect(done({ webhooks: [{ id: "w1", enabled: true }] })).toEqual(["webhooks"]);
    expect(done({ seen: new Set(["b1:skills"]) })).toEqual(["skills"]);
  });

  it("names the bot on each row when several moved", () => {
    const rows = grokMoveRows([movedOf(FULL), movedOf(FULL, { bot: { ...bot, id: "b2", name: "Lobby" } })], facts());
    expect(rows.filter((row) => row.id === "skills").map((row) => row.title)).toEqual(["Desk: Review skills: 1", "Lobby: Review skills: 1"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("the move itself", () => {
  it("adds the package, then one paused webhook automation; a routine paused in Grok Bot needs no turning on", async () => {
    const moved = await moveGrokBot(planOf(FULL), vi.fn());
    expect(fixture.requests.map(([path]) => path)).toEqual(["/api/teams/import?mode=add", "/api/webhooks"]);
    expect(fixture.requests[1]![1]).toEqual({ name: "Hook", prompt: "Hook it.", botId: "b1", enabled: false });
    expect(moved).toMatchObject({ routineIds: ["r1"], webhookIds: [expect.any(String)], webhooksFailed: [], servers: ["linear"], serversSkipped: 0 });
    expect(JSON.stringify(fixture.requests)).not.toContain("trigger_details");
  });

  it("keeps the bot when an automation can't be made, and lists it to rebuild", async () => {
    fixture.failWebhook = true;
    const moved = await moveGrokBot(planOf(FULL), vi.fn());
    expect(moved.webhooksFailed).toEqual(["Hook"]);
    const rows = grokMoveRows([moved], facts());
    expect(rows.map((row) => row.id)).not.toContain("webhooks");
    expect(rows.find((row) => row.id === "rebuild")!.title).toContain("2");
    expect(rebuildMessage(moved)).toContain("Hook it.");
  });
});

describe("what was found on this computer", () => {
  const file = (name: string, bots: unknown) => ({ name, modifiedAt: 1, text: JSON.stringify({ format: GROK_EXPORT_FORMAT, bots }) });

  it("one row per Bot however many files it wrote; a refused file says why and spoils nothing else", () => {
    const found = foundExports([
      file("grok-bot-export-drew.json", [{ name: "Drew", memories: ["a"] }]),
      file("grok-bot-export-drew (1).json", [{ name: "Drew", memories: ["a"] }]),
      file("grok-bot-export-eve.json", [{ name: "Eve" }]),
      file("grok-bot-export-bad.json", [{ name: "Bad", api_key: "x" }]),
    ]);
    expect(found.bots.map((item) => item.name).sort()).toEqual(["Drew", "Eve"]);
    expect(found.bots.find((item) => item.name === "Drew")!.memories).toEqual(["a"]);
    expect(found.refused).toEqual([{ file: "grok-bot-export-bad.json", error: expect.stringContaining("passwords or keys") }]);
  });

  it("warns about routines a Bot announced and left out", () => {
    const bots = parseGrokExport(JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [{ name: "Drew", routines: [{ name: "Morning watch", instruction: "x" }] }] }));
    expect(missingRoutines(bots, { files: [], bots: ["Drew"], routines: { drew: ["Morning watch", "routine-healthcheck"], other: ["x"] } }))
      .toEqual([{ bot: "Drew", routines: ["routine-healthcheck"] }]);
    expect(missingRoutines(bots, { files: [], bots: [], routines: {} })).toEqual([]);
  });
});
