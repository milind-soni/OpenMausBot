// Threads follow their bot's model: a thread keeps a model of its own only
// when a person picks one there. These tests cover
// the store's half (what a thread stores, the one-time cleanup of the copies
// older builds made, and moving threads back onto the bot's model) and the
// rule a turn's start applies to a thread's own model (threadModelFallback).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { Store, toWireTask, type BotRecord, type TaskRecord } from "./store.ts";
import { threadModelFallback, type ThreadEngine } from "./thread-model.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const opus: ModelSelection = { instanceId: "claude", model: "claude-opus-5" };
const codex: ModelSelection = { instanceId: "codex", model: "gpt-5-codex" };
const drivers: Record<string, string> = { claude: "claudeAgent", spare: "claudeAgent", codex: "codex" };
const open = () => new Store(() => sonnet, undefined, (instanceId) => drivers[instanceId]);
const ownModel = (store: Store, botId: string, threadId: string) => store.taskByThread(botId, threadId)?.modelSelection;
const runsOn = (store: Store, botId: string, threadId: string) => store.projectBotForTask(botId, threadId)!.modelSelection;

describe("threads follow their bot's model", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("a new thread has no model of its own and follows every change of its bot's model", () => {
    const store = open();
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id, "Second")!;
    expect(ownModel(store, bot.id, first)).toBeUndefined();
    expect(ownModel(store, bot.id, second.threadId)).toBeUndefined();
    expect(runsOn(store, bot.id, second.threadId)).toEqual(sonnet);

    store.patchBot(bot.id, { modelSelection: opus });
    expect(runsOn(store, bot.id, first)).toEqual(opus);
    expect(runsOn(store, bot.id, second.threadId)).toEqual(opus);
    store.applyModelDefault(bot.id, codex);
    expect(runsOn(store, bot.id, second.threadId)).toEqual(codex);
    // Changing the bot's model from one thread moves every follower too, and
    // the thread it was changed from follows the bot rather than copying it.
    store.switchTaskModel(bot.id, first, sonnet, true, false);
    expect(ownModel(store, bot.id, first)).toBeUndefined();
    expect(runsOn(store, bot.id, second.threadId)).toEqual(sonnet);

    const reloaded = open();
    expect(ownModel(reloaded, bot.id, first)).toBeUndefined();
    expect(ownModel(reloaded, bot.id, second.threadId)).toBeUndefined();
    reloaded.patchBot(bot.id, { modelSelection: opus });
    expect(runsOn(reloaded, bot.id, second.threadId)).toEqual(opus);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].tasks
      .every((task: TaskRecord) => !("modelSelection" in task))).toBe(true);
  });

  it("a person's pick in one thread survives every change of the bot's model", () => {
    const store = open();
    const bot = store.createBot();
    const picked = store.createTask(bot.id, "Picked")!;
    const follower = store.createTask(bot.id, "Follower")!;
    store.switchTaskModel(bot.id, picked.threadId, codex, false, false);
    expect(ownModel(store, bot.id, picked.threadId)).toEqual(codex);

    store.patchBot(bot.id, { modelSelection: opus });
    store.applyModelDefault(bot.id, { ...opus, effort: "high" });
    store.switchTaskModel(bot.id, follower.threadId, sonnet, true, false);
    store.applyTeamSetup({ version: 1, requestId: "setup", botId: bot.id, threadId: bot.threadId, reason: "Requested", createdAt: 1,
      requesterRevision: "fixture", newTeams: [], operations: [{ action: "update", botId: bot.id, fields: { modelSelection: opus } }] } as TeamSetupRequest);
    expect(runsOn(store, bot.id, picked.threadId)).toEqual(codex);
    expect(runsOn(store, bot.id, follower.threadId)).toEqual(opus);
    expect(ownModel(open(), bot.id, picked.threadId)).toEqual(codex);
  });

  it("picking the bot's own model in a thread is following the bot", () => {
    const store = open();
    const bot = store.createBot();
    store.switchTaskModel(bot.id, bot.threadId, codex, false, false);
    store.switchTaskModel(bot.id, bot.threadId, sonnet, false, false);
    expect(ownModel(store, bot.id, bot.threadId)).toBeUndefined();
    store.patchBot(bot.id, { modelSelection: opus });
    expect(runsOn(store, bot.id, bot.threadId)).toEqual(opus);
  });

  it("a thread opened from a thread with its own model starts on that model; one opened from a follower follows", () => {
    const store = open();
    const bot = store.createBot();
    const child = store.createTask(bot.id, "Child", false, undefined, undefined, undefined, codex)!;
    const fresh = store.createTask(bot.id, "Fresh", false)!;
    expect(ownModel(store, bot.id, child.threadId)).toEqual(codex);
    expect(ownModel(store, bot.id, fresh.threadId)).toBeUndefined();
    // Handed the bot's own model: nothing to keep.
    const same = store.createTask(bot.id, "Same", false, undefined, undefined, undefined, sonnet)!;
    expect(ownModel(store, bot.id, same.threadId)).toBeUndefined();
  });

  it("the one-time cleanup clears the copies older builds made and keeps a different model", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const task = (threadId: string, modelSelection?: ModelSelection): TaskRecord => ({
      threadId, title: threadId, createdAt: 1, updatedAt: 1, resumeCursors: {}, ...(modelSelection ? { modelSelection } : {}),
    });
    const bot = {
      id: "legacy", threadId: "copy", name: "Legacy", title: "", description: "", soul: "", notifications: true, color: "#000",
      unread: false, modelSelection: sonnet, resumeCursors: {}, createdAt: 1,
      tasks: [task("copy", { ...sonnet }), task("different", codex), task("other-effort", { ...sonnet, effort: "high" })],
    } as unknown as BotRecord;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([bot]));

    const store = open();
    expect(ownModel(store, "legacy", "copy")).toBeUndefined();
    expect(ownModel(store, "legacy", "different")).toEqual(codex);
    expect(ownModel(store, "legacy", "other-effort")).toEqual({ ...sonnet, effort: "high" });
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].tasks as TaskRecord[];
    expect(saved.map((entry) => entry.modelSelection)).toEqual([undefined, codex, { ...sonnet, effort: "high" }]);

    // Once only: a pick that later equals the bot's model is still a pick, so
    // when the bot moves on again the thread stays where the person put it.
    store.patchBot("legacy", { modelSelection: codex });
    const again = open();
    expect(ownModel(again, "legacy", "different")).toEqual(codex);
    again.patchBot("legacy", { modelSelection: opus });
    expect(runsOn(again, "legacy", "different")).toEqual(codex);
    expect(runsOn(again, "legacy", "copy")).toEqual(opus);
  });

  it("the cleanup waits for a bot list it can read", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "bots.json"), "{ not json");
    open();
    const bot = {
      id: "legacy", threadId: "copy", name: "Legacy", title: "", description: "", soul: "", notifications: true, color: "#000",
      unread: false, modelSelection: sonnet, resumeCursors: {}, createdAt: 1,
      tasks: [{ threadId: "copy", title: "copy", createdAt: 1, updatedAt: 1, resumeCursors: {}, modelSelection: { ...sonnet } }],
    };
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([bot]));
    expect(ownModel(open(), "legacy", "copy")).toBeUndefined();
  });

  it("followBotModel clears exactly the listed threads' own model, in one write, and Ask where the bot's engine would have to confirm", () => {
    const store = open();
    const bot = store.createBot();
    const first = bot.threadId;
    store.patchBot(bot.id, { modelSelection: codex });
    const full = store.createTask(bot.id, "Full on Claude")!;
    const asks = store.createTask(bot.id, "Ask on Claude")!;
    const same = store.createTask(bot.id, "Full on the same engine")!;
    const untouched = store.createTask(bot.id, "Not listed")!;
    store.switchTaskModel(bot.id, full.threadId, sonnet, false, false, { approvalMode: "full", autoApprove: false, alwaysAllow: ["Bash"] });
    store.switchTaskModel(bot.id, asks.threadId, sonnet, false, false, { approvalMode: "ask" });
    store.switchTaskModel(bot.id, same.threadId, { ...codex, effort: "high" }, false, false, { approvalMode: "full" });
    store.switchTaskModel(bot.id, untouched.threadId, opus, false, false);
    const resets: Array<[ModelSelection, ModelSelection]> = [];
    const moved = store.followBotModel(bot.id, [full.threadId, asks.threadId, same.threadId, first], (from, to) => {
      resets.push([from, to]);
      return { rewound: true };
    });
    expect(moved.sort()).toEqual([full.threadId, asks.threadId, same.threadId].sort());
    expect(store.taskByThread(bot.id, full.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [], rewound: true });
    expect(store.taskByThread(bot.id, full.threadId)?.modelSelection).toBeUndefined();
    expect(store.taskByThread(bot.id, asks.threadId)).toMatchObject({ approvalMode: "ask" });
    // Another model on the same engine: the level stays.
    expect(store.taskByThread(bot.id, same.threadId)).toMatchObject({ approvalMode: "full" });
    expect(ownModel(store, bot.id, untouched.threadId)).toEqual(opus);
    expect(resets.map(([, to]) => to)).toEqual([codex, codex, codex]);
    const reloaded = open();
    expect(ownModel(reloaded, bot.id, full.threadId)).toBeUndefined();
    expect(reloaded.taskByThread(bot.id, full.threadId)?.approvalMode).toBe("ask");
    expect(ownModel(reloaded, bot.id, untouched.threadId)).toEqual(opus);
  });

  it("a following thread's Full access goes back to Ask when the bot moves to another engine, never on the same engine", () => {
    const store = open();
    const bot = store.createBot();
    const full = store.createTask(bot.id, "Full")!;
    store.patchTask(bot.id, full.threadId, { approvalMode: "full", autoApprove: false, alwaysAllow: ["Bash"] });
    store.patchBot(bot.id, { modelSelection: opus });
    expect(store.taskByThread(bot.id, full.threadId)).toMatchObject({ approvalMode: "full", alwaysAllow: ["Bash"] });
    store.patchBot(bot.id, { modelSelection: codex });
    expect(store.taskByThread(bot.id, full.threadId)).toMatchObject({ approvalMode: "ask", autoApprove: false, alwaysAllow: [] });
    expect(open().taskByThread(bot.id, full.threadId)?.approvalMode).toBe("ask");

    const other = store.createTask(bot.id, "Full again")!;
    store.patchTask(bot.id, other.threadId, { approvalMode: "full", autoApprove: false });
    store.applyModelDefault(bot.id, sonnet);
    expect(store.taskByThread(bot.id, other.threadId)?.approvalMode).toBe("ask");
  });

  it("the wire carries the model a thread runs on and whether it follows the bot", () => {
    const store = open();
    const bot = store.createBot();
    const first = bot.threadId;
    const picked = store.createTask(bot.id, "Picked")!;
    store.switchTaskModel(bot.id, picked.threadId, codex, false, false);
    const tasks = store.tasks(bot.id);
    const follower = tasks.find((task) => task.threadId === first)!;
    expect(toWireTask(follower, sonnet)).toMatchObject({ modelSelection: sonnet, followsBotModel: true });
    expect(toWireTask(tasks.find((task) => task.threadId === picked.threadId)!, sonnet)).toMatchObject({ modelSelection: codex, followsBotModel: false });
  });
});

describe("threadModelFallback", () => {
  const snapshot = (overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({ state: "available", authenticated: true, ...overrides });
  const engine = (instanceId: string, overrides: Partial<ThreadEngine> = {}): ThreadEngine => ({
    instanceId, driverKind: drivers[instanceId] ?? "claudeAgent", enabled: true, snapshot: snapshot(),
    models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }, { id: "claude-opus-5", label: "Opus" }, { id: "gpt-5-codex", label: "Codex" }] },
    ...overrides,
  });
  const spare: ModelSelection = { instanceId: "spare", model: "claude-opus-5" };
  const engines = (overrides: Record<string, ThreadEngine | undefined>) => (instanceId: string) =>
    Object.hasOwn(overrides, instanceId) ? overrides[instanceId] : engine(instanceId);

  it("runs a model that can run as picked", () => {
    expect(threadModelFallback(spare, sonnet, engines({}))).toBeNull();
  });

  it("gives way when the engine is gone, disabled, unavailable, or not allowed", () => {
    expect(threadModelFallback(spare, sonnet, engines({ spare: undefined }))).toBe("unavailable");
    expect(threadModelFallback(spare, sonnet, engines({ spare: engine("spare", { enabled: false }) }))).toBe("unavailable");
    expect(threadModelFallback(spare, sonnet, engines({ spare: engine("spare", { snapshot: { state: "unavailable", reason: "missing" } }) }))).toBe("unavailable");
    expect(threadModelFallback(spare, sonnet, engines({}), { refusal: (instance) => instance.instanceId === "spare" ? "not allowed" : undefined })).toBe("unavailable");
    expect(threadModelFallback(spare, sonnet, engines({}), { allows: (selection) => selection.instanceId !== "spare" })).toBe("unavailable");
  });

  it("runs a model its engine's catalog does not list as picked: IDs are free-form", () => {
    expect(threadModelFallback({ ...spare, model: "claude-sonnet-4-6[1m]" }, sonnet, engines({}))).toBeNull();
    expect(threadModelFallback({ ...spare, variant: "low" }, sonnet, engines({}))).toBeNull();
  });

  it("gives way to a signed-out engine only when the bot's model is on another engine that can run", () => {
    const signedOut = engine("spare", { snapshot: snapshot({ authenticated: false }) });
    expect(threadModelFallback(spare, sonnet, engines({ spare: signedOut }))).toBe("signed-out");
    // The same engine: the turn runs as picked, so its sign-in prompt shows.
    const claudeOut = engine("claude", { snapshot: snapshot({ authenticated: false }) });
    expect(threadModelFallback(opus, sonnet, engines({ claude: claudeOut }))).toBeNull();
    // The bot's engine can't run either: nothing better to run on.
    expect(threadModelFallback(spare, sonnet, engines({ spare: signedOut, claude: claudeOut }))).toBeNull();
    expect(threadModelFallback(spare, sonnet, engines({ spare: signedOut, claude: undefined }))).toBeNull();
    expect(threadModelFallback(spare, sonnet, engines({ spare: signedOut, claude: engine("claude", { enabled: false }) }))).toBeNull();
    // A custom endpoint brings its own credential: its sign-in state does not count.
    expect(threadModelFallback(spare, sonnet, engines({ spare: { ...signedOut, access: "custom" } }))).toBeNull();
  });

  it("never gives way to the same model", () => {
    expect(threadModelFallback(sonnet, sonnet, engines({ claude: undefined }))).toBeNull();
  });
});

describe("the cleanup marker", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is written once the bots are saved", () => {
    open().createBot();
    expect(existsSync(join(DATA_DIR, "thread-model-copies-cleared"))).toBe(true);
  });
});
