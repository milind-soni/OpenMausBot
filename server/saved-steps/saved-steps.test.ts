import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent, SendTurnInput, TurnStartResult } from "../contracts.ts";
import type { Message } from "../store.ts";
import { textEditJournal } from "../testing/saved-steps-fixtures.ts";
import type { RecordedCall } from "./journal.ts";
import { requestKey } from "./key.ts";
import type { ReplayRequest } from "./dispatch.ts";
import type { Recipe, RecipeStep } from "./rules.ts";
import { createSavedSteps, savedStepsEnabled, type SavedSteps, type SavedStepsDeps, type SettledRequest } from "./saved-steps.ts";

const FAKE = fileURLToPath(new URL("../testing/fake-mcp-server.ts", import.meta.url));
const REQUEST = "Open TextEdit and type hello world";
const TARGET: Pick<RecipeStep, "app" | "window" | "element"> = {
  app: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  window: { title: "Untitled" },
  element: { role: "AXTextArea", label: "Document", path: ["AXScrollArea:"] },
};
const RECIPE: Recipe = {
  id: "r1", key: requestKey(REQUEST), request: REQUEST, createdAt: Date.now(), lastUsedAt: Date.now(),
  steps: [{ tool: "click", args: {}, ...TARGET }, { tool: "set_value", args: { value: "hello world" }, ...TARGET }],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("savedStepsEnabled", () => {
  it("is on unless turned off", () => {
    expect(savedStepsEnabled({})).toBe(true);
    expect(savedStepsEnabled({ features: {} })).toBe(true);
    expect(savedStepsEnabled({ features: { savedSteps: true } })).toBe(true);
    expect(savedStepsEnabled({ features: { savedSteps: false } })).toBe(false);
  });
});

describe("createSavedSteps", () => {
  it("runs the AI when the thread has no turn generation to keep the request from saving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-saved-steps-facade-"));
    dirs.push(dir);
    const events: RuntimeEvent[] = [];
    const slots = new Map<string, ProviderInstance>();
    const steps = createSavedSteps({
      enabled: () => true,
      bot: () => ({}),
      publish: (event) => events.push(event),
      engines: { get: (threadId) => slots.get(threadId), set: (threadId, engine) => { slots.set(threadId, engine); } },
      stopped: () => false,
      generation: () => undefined,
      patchMessage: () => {},
      withholdHandoff: () => () => {},
      contextChanged: () => {},
      folder: (botId) => join(dir, botId),
      platform: "darwin",
    });
    steps.recipes.save("b1", RECIPE);
    const engine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { provider: "claudeAgent" } } as unknown as ProviderInstance;
    const start = vi.fn(async (_input: SendTurnInput): Promise<TurnStartResult> => ({ turnId: "e1" }));
    const input: SendTurnInput = { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full",
      integrations: { localComputer: { command: process.execPath, args: ["--experimental-strip-types", FAKE], env: {}, scope: "local-computer" } } };

    expect(await steps.dispatch.sendTurn(engine, { botId: "b1", message: { id: "m1", at: 1, role: "user", kind: "text", text: REQUEST }, turnText: REQUEST, placePicked: true }, input, start))
      .toEqual({ turnId: "e1" });
    expect(start).toHaveBeenCalledWith(input);
    expect(events).toEqual([]);
    expect(slots.size).toBe(0);
    expect(steps.recipes.find("b1", RECIPE.key)?.id).toBe(RECIPE.id);
  });

  it("replays from the bot's own store on the turn's computer and keeps the request from saving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-saved-steps-facade-"));
    dirs.push(dir);
    const events: RuntimeEvent[] = [];
    const slots = new Map<string, ProviderInstance>();
    const steps = createSavedSteps({
      enabled: () => true,
      bot: () => ({}),
      publish: (event) => events.push(event),
      engines: { get: (threadId) => slots.get(threadId), set: (threadId, engine) => { slots.set(threadId, engine); } },
      stopped: () => false,
      generation: (threadId) => (threadId === "t1" ? "g1" : undefined),
      patchMessage: () => {},
      withholdHandoff: () => () => {},
      contextChanged: () => {},
      folder: (botId) => join(dir, botId),
      platform: "darwin",
    });
    steps.recipes.save("b1", RECIPE);
    const engine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { provider: "claudeAgent" } } as unknown as ProviderInstance;
    const start = vi.fn(async (_input: SendTurnInput): Promise<TurnStartResult> => ({ turnId: "e1" }));
    const computer = { command: process.execPath, args: ["--experimental-strip-types", FAKE], env: { OMB_CONTROL_URL: "http://127.0.0.1:1/control", OMB_CONTROL_TOKEN: "t" }, scope: "local-computer" as const };

    const { turnId } = await steps.dispatch.sendTurn(engine, { botId: "b1", message: { id: "m1", at: 1, role: "user", kind: "text", text: REQUEST }, turnText: REQUEST, placePicked: true },
      { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full", integrations: { localComputer: computer } }, start);

    expect(steps.journal.take("t1", new Set(["g1"]))).toEqual({ calls: [], complete: true, tainted: true });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(start.mock.calls[0]![0].text).toContain('failed at step 1 of 2 (click).');
    expect(start.mock.calls[0]![0].text).toContain('{"target":"\\"Document\\" in TextEdit","error":"TextEdit is not running"}');
    expect(steps.recipes.find("b1", RECIPE.key)).toBeUndefined();
    expect(events[0]).toMatchObject({ type: "turn.started", turnId });
    expect(slots.get("t1")).toBe(engine);
  });
});

describe("SavedSteps.requestSettled", () => {
  const NOW = Date.UTC(2026, 9, 28);
  const LINE: Message = { id: "m1", at: 1, role: "user", kind: "text", text: REQUEST };
  const REPLY: Message = {
    id: "reply-1", at: 2, role: "bot", kind: "text", text: "Typed hello world into TextEdit. Nothing else changed.",
    turnId: "turn-1", requestMessageId: "m1", turnTerminal: true, turnSucceeded: true,
  };
  let steps: SavedSteps;
  let patches: Array<[string, string, Partial<Message>]>;
  let enabled: boolean;
  let folder: string;

  const facade = (change: Partial<SavedStepsDeps> = {}) => createSavedSteps({
    enabled: () => enabled,
    bot: () => ({}),
    publish: () => {},
    engines: { get: () => undefined, set: () => {} },
    stopped: () => false,
    generation: (threadId) => (threadId === "t1" ? "g1" : undefined),
    patchMessage: (threadId, messageId, patch) => { patches.push([threadId, messageId, patch]); },
    withholdHandoff: () => () => {},
    contextChanged: () => {},
    folder: (botId) => join(folder, botId),
    now: () => NOW,
    platform: "darwin",
    ...change,
  });
  const settled = (change: Partial<SettledRequest> = {}): SettledRequest => ({
    botId: "b1", threadId: "t1", request: LINE, reply: REPLY, after: [REPLY], generations: new Set(["g1"]), automated: false, ...change,
  });
  const record = (calls: readonly RecordedCall[]) => {
    for (const { generation, ...entry } of calls) {
      const scope = { botId: "b1", threadId: "t1", generation };
      steps.journal.gateChecked(scope);
      steps.journal.record(scope, entry);
    }
  };
  const saved = () => steps.recipes.find("b1", requestKey(REQUEST));

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "omb-saved-steps-settle-"));
    dirs.push(folder);
    patches = [];
    enabled = true;
    steps = facade();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const engine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { provider: "claudeAgent" } } as unknown as ProviderInstance;
  const sentThrough = async (input: Partial<SendTurnInput> = {}, request: Partial<ReplayRequest> = {}) => {
    const start = vi.fn(async (_input: SendTurnInput): Promise<TurnStartResult> => ({ turnId: "turn-1" }));
    const computer = { command: process.execPath, args: [FAKE], env: {}, scope: "local-computer" as const };
    await steps.dispatch.sendTurn(engine, { botId: "b1", message: LINE, turnText: REQUEST, placePicked: true, ...request },
      { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full", integrations: { localComputer: computer }, ...input }, start);
    expect(start).toHaveBeenCalledTimes(1);
  };

  it("saves a settled host run and marks the reply", async () => {
    await sentThrough();
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    const recipe = steps.recipes.find("b1", "open textedit and type hello world")!;
    expect(recipe).toMatchObject({ request: REQUEST, createdAt: NOW, lastUsedAt: NOW });
    expect(recipe).not.toHaveProperty("reply");
    expect(readFileSync(join(folder, "b1", "saved-steps.json"), "utf8")).not.toContain("Nothing else changed");
    expect(recipe.steps.map((step) => step.tool)).toEqual(["click", "set_value"]);
    expect(patches).toEqual([["t1", "reply-1", { savedSteps: { recipeId: recipe.id, learned: true } }]]);
  });

  it.each<[string, Partial<SendTurnInput>, Partial<ReplayRequest>]>([
    ["the bot asks before acting", { approvalMode: "ask" }, {}],
    ["the bot approves on Auto", { approvalMode: "auto" }, {}],
    ["the person did not pick this computer", {}, { placePicked: false }],
    ["a step's tool is not selected for the bot", { toolScope: { deny: ["mcp:computer:set_value"] } }, {}],
  ])("saves nothing, and so nothing that could run later unseen, when the same words would still go to the AI: %s", async (_, input, request) => {
    await sentThrough(input, request);
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("saves nothing when the request's last turn sent no line of the person's to replay", async () => {
    await sentThrough();
    await steps.dispatch.sendTurn(engine, null, { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full" }, async () => ({ turnId: "turn-1" }));
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
  });

  it("marks a replayed reply, touches its recipe and clears the quick model label", () => {
    steps.recipes.save("b1", { ...RECIPE, createdAt: NOW - 5_000, lastUsedAt: NOW - 5_000 });
    const replayed = vi.spyOn(steps.dispatch, "replayed").mockImplementation((threadId, turnId) => (threadId === "t1" && turnId === "turn-r" ? "r1" : undefined));
    steps.journal.taint({ threadId: "t1", generation: "g1" });
    const reply: Message = { ...REPLY, id: "reply-r", turnId: "turn-r", text: "Done. I repeated 2 saved steps." };

    steps.requestSettled(settled({ request: { ...LINE, quickModel: "Haiku 4.5" }, reply, after: [reply] }));

    expect(replayed).toHaveBeenCalledWith("t1", "turn-r");
    expect(patches).toStrictEqual([["t1", "m1", { quickModel: undefined }], ["t1", "reply-r", { savedSteps: { recipeId: "r1", replayed: true } }]]);
    expect(steps.recipes.find("b1", RECIPE.key)).toMatchObject({ id: "r1", createdAt: NOW - 5_000, lastUsedAt: NOW });
    expect(steps.journal.take("t1", new Set(["g1"]))).toBeNull();
  });

  it("leaves the request line alone when a replayed request had no quick model label", () => {
    steps.recipes.save("b1", RECIPE);
    vi.spyOn(steps.dispatch, "replayed").mockReturnValue("r1");
    steps.requestSettled(settled());
    expect(patches).toStrictEqual([["t1", "reply-1", { savedSteps: { recipeId: "r1", replayed: true } }]]);
  });

  it.each<[string, { enabled?: boolean; automated?: boolean; after?: Message[]; request?: Partial<Message>; calls?: RecordedCall[] }]>([
    ["the setting is off", { enabled: false }],
    ["the request was automated", { automated: true }],
    ["a person line followed", { after: [{ id: "m2", at: 3, role: "user", kind: "text", text: "faster" }] }],
    ["the request was spoken", { request: { via: "call" } }],
    ["nothing touched the computer", { calls: [] }],
  ])("saves nothing when %s", (_, change) => {
    enabled = change.enabled ?? true;
    record(change.calls ?? textEditJournal().calls);
    steps.requestSettled(settled({
      automated: change.automated ?? false,
      after: [REPLY, ...(change.after ?? [])],
      request: { ...LINE, ...change.request },
    }));
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("records a mount's computer calls only for the person's own request while saving is on", () => {
    const person = { origin: { kind: "user" }, personLine: true };
    expect(steps.journals(person)).toBe(true);
    expect(steps.journals(undefined)).toBe(false);
    expect(steps.journals({ ...person, automation: { kind: "schedule" } })).toBe(false);
    expect(steps.journals({ origin: { kind: "outside" } })).toBe(false);
    expect(steps.journals({ origin: { kind: "bot" } })).toBe(false);
    expect(steps.journals({})).toBe(false);
    enabled = false;
    expect(steps.journals(person)).toBe(false);
    expect(facade({ platform: "linux" }).journals(person)).toBe(false);
  });

  it("says saved steps can run only on a Mac, setting or not, so clients hide the switch elsewhere", () => {
    expect(facade({ platform: "darwin" }).here()).toBe(true);
    enabled = false;
    expect(facade({ platform: "darwin" }).here()).toBe(true);
    expect(facade({ platform: "linux" }).here()).toBe(false);
    expect(facade({ platform: "win32" }).here()).toBe(false);
  });

  it("never records a turn a peer handed on, though it carries the person's origin", () => {
    const handed = { origin: { kind: "user", request: "Open TextEdit and type hello world" } };
    expect(steps.journals(handed)).toBe(false);
    expect(steps.journals({ ...handed, personLine: false })).toBe(false);
    expect(steps.journals({ ...handed, personLine: true })).toBe(true);
  });

  it.each(["linux", "win32"] as const)("neither saves nor replays on %s", async (platform) => {
    steps = facade({ platform });
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);

    steps.recipes.save("b1", { ...RECIPE, createdAt: NOW, lastUsedAt: NOW });
    const engine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { provider: "claudeAgent" } } as unknown as ProviderInstance;
    const start = vi.fn(async (_input: SendTurnInput): Promise<TurnStartResult> => ({ turnId: "turn-1" }));
    const input: SendTurnInput = { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full",
      integrations: { localComputer: { command: process.execPath, args: [FAKE], env: {}, scope: "local-computer" } } };
    await steps.dispatch.sendTurn(engine, { botId: "b1", message: LINE, turnText: REQUEST, placePicked: true }, input, start);
    expect(start).toHaveBeenCalledWith(input);
  });

  it("saves nothing for a request whose turn began with a replay", () => {
    steps.journal.taint({ threadId: "t1", generation: "g1" });
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("a denial during the request stops it saving", () => {
    record(textEditJournal().calls);
    steps.observe({ type: "turn.completed", threadId: "t1", turnId: "x", ok: true, denials: ["Bash"] } as RuntimeEvent);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("a denied approval during the request stops it saving", () => {
    steps.observe({ type: "request.resolved", threadId: "t1", turnId: "x", requestId: "q1", behavior: "deny", source: "user" } as RuntimeEvent);
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("an answered question during the request stops it saving", () => {
    record(textEditJournal().calls);
    steps.observe({ type: "request.resolved", threadId: "t1", turnId: "x", requestId: "q1", behavior: "answer", source: "user" } as RuntimeEvent);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("an allowed approval and a turn with no denials leave it saveable", async () => {
    await sentThrough();
    steps.observe({ type: "request.resolved", threadId: "t1", turnId: "x", requestId: "q1", behavior: "allow", source: "user" } as RuntimeEvent);
    record(textEditJournal().calls);
    steps.observe({ type: "turn.completed", threadId: "t1", turnId: "x", ok: true, denials: [] as string[] } as RuntimeEvent);
    steps.observe({ type: "request.resolved", threadId: "t2", turnId: "y", requestId: "q2", behavior: "deny", source: "user" } as RuntimeEvent);
    steps.requestSettled(settled());
    expect(saved()?.steps).toHaveLength(2);
  });

  it("never saves a request whose thread was evicted from the journal mid-request", () => {
    const [first] = textEditJournal().calls;
    record([first!]);
    for (let i = 0; i < 64; i++) {
      const other = { botId: "b2", threadId: `other-${i}`, generation: `o${i}` };
      steps.journal.gateChecked(other);
      steps.journal.record(other, { tool: "click", arguments: {}, result: { isError: false } });
    }
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  const toolLine = (name: string, at: number): Message => ({ id: `tool-${at}`, at, role: "bot", kind: "activity", tool: { name, ok: true, itemId: `item-${at}` } });
  const COMPUTER_LINES = [toolLine("mcp__computer__get_window_state", 10), toolLine("mcp__computer__click", 11), toolLine("mcp__computer__set_value", 12)];

  it.each(["Read", "Glob", "Grep", "LS", "ToolSearch", "TodoWrite", "WebSearch", "WebFetch", "mcp__agents__select_computer", "select_computer", "web_search"])(
    "saves a computer run that also used %s", async (tool) => {
    await sentThrough();
    record(textEditJournal().calls);
    steps.requestSettled(settled({ after: [toolLine(tool, 9), ...COMPUTER_LINES, REPLY] }));
    expect(saved()?.steps).toHaveLength(2);
  },
  );

  it("saves nothing for a select_computer hand-off: the same words would start again without this computer", async () => {
    await sentThrough({ integrations: {} });
    await steps.dispatch.sendTurn(engine, null, { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full" }, async () => ({ turnId: "turn-2" }));
    record(textEditJournal().calls.map((call) => ({ ...call, generation: "g2" })));
    steps.requestSettled(settled({ generations: new Set(["g1", "g2"]), after: [toolLine("mcp__agents__select_computer", 9), ...COMPUTER_LINES, REPLY] }));
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it.each([
    ["without their server prefix", ""],
    ["with a single-underscore server prefix", "computer_"],
  ])("saves a run whose engine names the computer's tools %s", async (_, prefix) => {
    await sentThrough();
    record(textEditJournal().calls);
    const named = ["list_apps", "list_windows", "get_window_state", "click", "set_value"].map((name, index) => toolLine(`${prefix}${name}`, 20 + index));
    steps.requestSettled(settled({ after: [...named, REPLY] }));
    expect(saved()?.steps).toHaveLength(2);
  });

  it.each([
    ["Local VM", { localVmTarget: { kind: "vm" } }],
    ["Cloud Boat", { boxId: "bx_1" }],
    ["Cloud Boat not created yet", { boxId: null }],
    ["team computer", { teamComputerId: "tc_1" }],
  ])("saves nothing when the request also used a %s", (_, place) => {
    steps.gateChecked({ botId: "b1", threadId: "t1", generation: "g1", kind: "computer", ...place });
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);
  });

  it("a browser call leaves the request saveable", async () => {
    await sentThrough();
    steps.gateChecked({ botId: "b1", threadId: "t1", generation: "g1", kind: "browser" });
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()?.steps).toHaveLength(2);
  });

  it("saves a computer-only run beside rows that are not tool calls", async () => {
    await sentThrough();
    record(textEditJournal().calls);
    const notice: Message = { id: "notice", at: 9, role: "bot", kind: "activity", tool: { name: "Bash", ok: true } };
    steps.requestSettled(settled({ after: [notice, ...COMPUTER_LINES, REPLY] }));
    expect(saved()?.steps).toHaveLength(2);
  });

  it.each(["Bash", "Write", "Edit", "NotebookEdit", "mcp__gmail__send_email", "mcp__browser__navigate", "mcp__agents__use_tool", "Task", "apply_patch", "edit", "rm -rf ~/Desktop/notes",
    "computer_x_click", "computer_computer_click", "computer_exec", "computer_click_2"])(
    "saves nothing when the run also used %s",
    (tool) => {
      record(textEditJournal().calls);
      steps.requestSettled(settled({ after: [...COMPUTER_LINES, toolLine(tool, 13), REPLY] }));
      expect(saved()).toBeUndefined();
      expect(patches).toEqual([]);
    },
  );

  it("never saves two queued lines sent as one turn, even when the turn cannot be marked", async () => {
    steps = facade({ generation: () => undefined });
    const turnText = `close every window without saving\n\n${REQUEST}`;
    const engine = { instanceId: "claude", driverKind: "claudeAgent", adapter: { provider: "claudeAgent" } } as unknown as ProviderInstance;
    const start = vi.fn(async (_input: SendTurnInput): Promise<TurnStartResult> => ({ turnId: "turn-1" }));
    const input: SendTurnInput = { threadId: "t1", botId: "b1", text: turnText, approvalMode: "full" };
    await steps.dispatch.sendTurn(engine, { botId: "b1", message: LINE, turnText, placePicked: true }, input, start);
    expect(start).toHaveBeenCalledWith(input);
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()).toBeUndefined();
    expect(patches).toEqual([]);

    await sentThrough();
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()?.steps).toHaveLength(2);
  });

  it("frees the journal even when it saves nothing", () => {
    enabled = false;
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(steps.journal.take("t1", new Set(["g1"]))).toBeNull();
  });

  it("frees a request that ended without settling, so its calls never crowd out the next request's", async () => {
    await sentThrough();
    const leftover = { ...textEditJournal().calls[0]!, generation: "g0" };
    record(Array.from({ length: 400 }, () => leftover));
    steps.requestEnded("t1", new Set(["g0"]));
    record(textEditJournal().calls);
    steps.requestSettled(settled());
    expect(saved()?.steps).toHaveLength(2);
  });

  it("keeps settling when the recipe cannot be written", async () => {
    writeFileSync(join(folder, "blocked"), "");
    steps = facade({ folder: (botId) => join(folder, "blocked", botId) });
    await sentThrough();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    record(textEditJournal().calls);
    expect(() => steps.requestSettled(settled())).not.toThrow();
    expect(patches).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
