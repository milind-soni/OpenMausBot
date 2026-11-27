import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener, type SendTurnInput, type TurnStartResult } from "../contracts.ts";
import { CONTROL_BUSY } from "../control-client.ts";
import { Handoffs, unseenMessages, type HandedState, type Handoff } from "../delta-context.ts";
import { EventBus } from "../harness/bus.ts";
import { LimitResetClock } from "../limit-resets.ts";
import { QuickModelFallback } from "../quick-model-fallback.ts";
import type { Message } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { completeWindowState, windowState } from "../testing/saved-steps-fixtures.ts";
import { SavedStepsDispatch, type DispatchDeps, type ReplayRequest } from "./dispatch.ts";
import { requestKey } from "./key.ts";
import { declinedReply, fallbackNote } from "./replay.ts";
import type { CallOutcome, ComputerCaller } from "./resolve.ts";
import type { Recipe, RecipeStep } from "./rules.ts";

const REQUEST = "Open TextEdit and type hello world";
const TARGET: Pick<RecipeStep, "app" | "window" | "element"> = {
  app: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  window: { title: "Untitled" },
  element: { role: "AXTextArea", label: "Document", path: ["AXScrollArea:"] },
};
const RECIPE: Recipe = {
  id: "r1", key: requestKey(REQUEST), request: REQUEST, createdAt: 1_000, lastUsedAt: 1_000,
  steps: [{ tool: "click", args: {}, ...TARGET }, { tool: "set_value", args: { value: "hello world" }, ...TARGET }],
};
const LABEL = '"Document" in TextEdit';
const FAILED = { kind: "failed", done: 1, total: 2, tool: "set_value", label: LABEL, error: "Fixture failure." } as const;
const COMPUTER = { command: "gated-computer", args: ["--turn"], env: { OMB_CONTROL_TOKEN: "turn-token" }, platform: "darwin" as const, scope: "local-computer" as const };
const INPUT: SendTurnInput = { threadId: "t1", botId: "b1", text: REQUEST, approvalMode: "full", integrations: { localComputer: COMPUTER } };
const MESSAGE: Message = { id: "m1", at: 1, role: "user", kind: "text", text: REQUEST };
const REQ: ReplayRequest = { botId: "b1", message: MESSAGE, turnText: REQUEST, placePicked: true };
const reworded = (text: string): ReplayRequest => ({ ...REQ, message: { ...MESSAGE, text }, turnText: text });
const OBSERVATIONS = new Set(["list_apps", "list_windows", "get_window_state"]);

type Answer = "allow" | "deny" | undefined;

function engineStub() {
  const adapter = {
    provider: "claudeAgent",
    capabilities: { sessionModelSwitch: "unsupported" as const, queueing: true },
    cacheKeepWarm: { ping: vi.fn(), hold: vi.fn(() => true) },
    sendTurn: vi.fn(async (): Promise<TurnStartResult> => ({ turnId: "never" })),
    interruptTurn: vi.fn(async () => {}),
    respondToRequest: vi.fn(async () => "rejected" as const),
    steer: vi.fn(async () => "steered" as const),
    hasSession: vi.fn(() => true),
    stopAll: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
  };
  return { instanceId: "claude", driverKind: "claudeAgent", adapter } as unknown as ProviderInstance & { adapter: typeof adapter };
}

let acted: string[];
let events: RuntimeEvent[];
let answer: (event: Extract<RuntimeEvent, { type: "request.opened" }>) => Answer;
let failAt: string | undefined;
let gateAt: string | undefined;
let throwAt: string | undefined;
let documentText: string;
let slots: Map<string, ProviderInstance>;
let engine: ReturnType<typeof engineStub>;
let start: Mock<(input: SendTurnInput) => Promise<TurnStartResult>>;
let close: Mock<() => Promise<void>>;
let recipes: { find: Mock<(botId: string, key: string) => Recipe | undefined>; forget: Mock<(botId: string, recipeId: string) => boolean> };
let openCaller: Mock<DispatchDeps["openCaller"]>;
let taint: Mock<(threadId: string) => boolean>;
let handOn: Mock<(turnId: string) => void>;
let withholdHandoff: Mock<(threadId: string) => (turnId: string) => void>;
let contextChanged: Mock<(botId: string, threadId: string) => void>;
let deps: DispatchDeps;
let stopped: boolean;
let dispatch: SavedStepsDispatch;

function computer(): ComputerCaller {
  let snapshot = 2;
  return {
    async call(tool) {
      if (tool === throwAt) throw new Error("the fixture computer broke");
      if (tool === failAt) return { ok: false, error: "Fixture failure." } satisfies CallOutcome;
      if (tool === gateAt) return { ok: false, error: CONTROL_BUSY, gate: true } satisfies CallOutcome;
      if (tool === "list_apps") return { ok: true, structured: { apps: [{ pid: 4242, name: "TextEdit", bundle_id: "com.apple.TextEdit", running: true }] } };
      if (tool === "list_windows") return { ok: true, structured: { windows: [{ window_id: 7, pid: 4242, title: "Untitled", app_name: "TextEdit" }] } };
      if (tool === "get_window_state") return { ok: true, structured: completeWindowState(windowState(snapshot++), documentText) };
      if (OBSERVATIONS.has(tool)) throw new Error(`unexpected ${tool}`);
      acted.push(tool);
      return { ok: true, structured: {} };
    },
  };
}

const types = () => events.map((event) => event.type);
const turnCompleted = () => events.filter((event) => event.type === "turn.completed");
const settled = () => vi.waitFor(() => expect(turnCompleted().length + start.mock.calls.length).toBeGreaterThan(0));
const asked = () => vi.waitFor(() => expect(events.some((event) => event.type === "request.opened")).toBe(true));
const ev = (type: string, turnId: string, threadId = "t1") => ({
  eventId: newId(), createdAt: "2026-10-27T00:00:00Z", provider: "claudeAgent", providerInstanceId: "claude", threadId, turnId, type,
  ...(type === "item.completed" ? { itemType: "assistant_text", text: "Done by the AI." } : {}),
  ...(type === "turn.completed" ? { ok: true } : {}),
}) as RuntimeEvent;

beforeEach(() => {
  acted = [];
  events = [];
  answer = () => "allow";
  failAt = undefined;
  gateAt = undefined;
  throwAt = undefined;
  documentText = "";
  stopped = false;
  engine = engineStub();
  slots = new Map([["t1", engine as ProviderInstance]]);
  start = vi.fn(async () => ({ turnId: "e1" }));
  close = vi.fn(async () => {});
  recipes = { find: vi.fn((botId: string, key: string) => (botId === "b1" && key === RECIPE.key ? RECIPE : undefined)), forget: vi.fn(() => true) };
  openCaller = vi.fn(async () => ({ ...computer(), close }));
  taint = vi.fn(() => true);
  handOn = vi.fn();
  withholdHandoff = vi.fn(() => handOn);
  contextChanged = vi.fn();
  deps = {
    recipes,
    enabled: () => true,
    publish: (event) => {
      events.push(event);
      if (event.type !== "request.opened") return;
      const behavior = answer(event);
      if (behavior) void slots.get(event.threadId)!.adapter.respondToRequest(event.threadId, event.requestId!, { behavior });
    },
    engines: { get: (threadId) => slots.get(threadId), set: (threadId, instance) => { slots.set(threadId, instance); } },
    stopped: () => stopped,
    openCaller,
    taint,
    withholdHandoff,
    contextChanged,
  };
  dispatch = new SavedStepsDispatch(deps);
});

describe("SavedStepsDispatch.sendTurn", () => {
  it.each([
    ["no request", null, INPUT],
    ["Ask", REQ, { ...INPUT, approvalMode: "ask" }],
    ["Auto", REQ, { ...INPUT, approvalMode: "auto" }],
    ["no host computer", REQ, { ...INPUT, integrations: {} }],
    ["the person did not pick this computer as the bot's place", { ...REQ, placePicked: false }, INPUT],
    ["another computer", REQ, { ...INPUT, integrations: { localComputer: { ...COMPUTER, scope: undefined } } }],
    ["spoken", { ...REQ, message: { ...REQ.message, via: "call" } }, INPUT],
    ["no saved steps", reworded("open notes"), INPUT],
    ["new words", reworded("open textedit and type hello, world"), INPUT],
    ["the same key in other words, for steps that type", reworded("Please open TextEdit and type hello world."), INPUT],
    ["the same key in other case, for steps that type", reworded("open textedit and type HELLO WORLD"), INPUT],
    ["a step's tool is not selected for the bot", REQ, { ...INPUT, toolScope: { deny: ["mcp:computer:set_value"] } }],
    ["a lookup the replay needs is not selected for the bot", REQ, { ...INPUT, toolScope: { deny: ["mcp:computer:list_windows"] } }],
    ["only some of the steps' tools are selected", REQ, { ...INPUT, toolScope: { allow: ["mcp:computer:click", "mcp:computer:list_apps"] } }],
    ["the computer is not selected", REQ, { ...INPUT, toolScope: { deny: ["mcp:computer:*"] } }],
    ["the bot's tool selection cannot be read", REQ, { ...INPUT, toolScope: { allow: "mcp:computer:*" } as never }],
  ])("passes through: %s", async (_, request, input) => {
    expect(await dispatch.sendTurn(engine, request as never, input as SendTurnInput, start)).toEqual({ turnId: "e1" });
    expect(start).toHaveBeenCalledWith(input);
    expect(events).toEqual([]);
    expect(openCaller).not.toHaveBeenCalled();
    expect(taint).not.toHaveBeenCalled();
    expect(withholdHandoff).not.toHaveBeenCalled();
    expect(contextChanged).not.toHaveBeenCalled();
    expect(slots.get("t1")).toBe(engine);
  });

  it.each([
    ["Full access", INPUT],
    ["Ask", { ...INPUT, approvalMode: "ask" as const }],
  ])("lets the AI answer two queued lines sent as one turn and keeps that request from saving (%s)", async (_, input) => {
    const turnText = `close every window without saving\n\n${REQUEST}`;
    const sent = { ...input, text: turnText };
    expect(await dispatch.sendTurn(engine, { ...REQ, turnText }, sent, start)).toEqual({ turnId: "e1" });
    expect(start).toHaveBeenCalledWith(sent);
    expect(taint).toHaveBeenCalledExactlyOnceWith("t1");
    expect(openCaller).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(slots.get("t1")).toBe(engine);
  });

  it("holds back two queued lines sent as one turn that it cannot mark", async () => {
    taint.mockReturnValueOnce(false);
    const turnText = `close every window without saving\n\n${REQUEST}`;
    const sent = { ...INPUT, text: turnText };
    expect(await dispatch.sendTurn(engine, { ...REQ, turnText }, sent, start)).toEqual({ turnId: "e1" });
    expect(start).toHaveBeenCalledWith(sent);
    expect(openCaller).not.toHaveBeenCalled();
    expect(dispatch.takeUnmarked("t1")).toBe(true);
    expect(dispatch.takeUnmarked("t1")).toBe(false);
  });

  it("holds back nothing when it marks the request or the turn is the person's one line", async () => {
    await dispatch.sendTurn(engine, { ...REQ, turnText: `close every window without saving\n\n${REQUEST}` }, INPUT, start);
    expect(dispatch.takeUnmarked("t1")).toBe(false);
    taint.mockReturnValueOnce(false);
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    expect(dispatch.takeUnmarked("t1")).toBe(false);
  });

  it("runs the AI when the request cannot be kept from saving", async () => {
    taint.mockReturnValueOnce(false);
    expect(await dispatch.sendTurn(engine, REQ, INPUT, start)).toEqual({ turnId: "e1" });
    expect(taint).toHaveBeenCalledWith("t1");
    expect(start).toHaveBeenCalledWith(INPUT);
    expect(openCaller).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(slots.get("t1")).toBe(engine);
  });

  it("passes through while the setting is off", async () => {
    dispatch = new SavedStepsDispatch({ ...deps, enabled: () => false });
    expect(await dispatch.sendTurn(engine, REQ, INPUT, start)).toEqual({ turnId: "e1" });
    expect(start).toHaveBeenCalledWith(INPUT);
    expect(recipes.find).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("answers a saved request with no engine call", async () => {
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(start).not.toHaveBeenCalled();
    expect(engine.adapter.sendTurn).not.toHaveBeenCalled();
    expect(acted).toEqual(["click", "set_value"]);
    expect(types()).toEqual(["turn.started", "request.opened", "request.resolved", "item.started", "item.completed", "request.opened",
      "request.resolved", "item.started", "item.completed", "item.completed", "turn.completed"]);
    expect(events.every((event) => event.turnId === turnId && event.threadId === "t1")).toBe(true);
    expect(events.find((e) => e.type === "request.opened")).toMatchObject({
      requestType: "permission", tool: "mcp__computer__click", summary: `click on ${LABEL}`, approvalScope: "local-computer", allowSession: false, turnId,
    });
    expect(events.filter((e) => e.type === "request.opened")[1]).toMatchObject({ tool: "mcp__computer__set_value", summary: `set_value on ${LABEL}` });
    expect(events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "allow", source: "user", approvalScope: "local-computer" });
    expect(events.at(-2)).toMatchObject({ itemType: "assistant_text", text: "Done. I repeated 2 saved steps: clicked “Document”, filled in “Document”." });
    expect(JSON.stringify(events)).not.toContain("hello world");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, stopReason: "end_turn", provider: "claudeAgent", providerInstanceId: "claude" });
    expect(dispatch.replayed("t1", turnId)).toBe(RECIPE.id);
    expect(dispatch.replayed("t1", "another-turn")).toBeUndefined();
    expect(recipes.forget).not.toHaveBeenCalled();
  });

  it.each([
    ["every computer tool selected", { allow: ["mcp:computer:*"] }],
    ["another tool turned off", { deny: ["mcp:computer:drag", "native:Bash"] }],
  ])("replays with %s", async (_, toolScope) => {
    await dispatch.sendTurn(engine, REQ, { ...INPUT, toolScope }, start);
    await settled();
    expect(start).not.toHaveBeenCalled();
    expect(acted).toEqual(["click", "set_value"]);
  });

  it("keeps the replayed turn from the engine's session record and has the next AI turn read it from the conversation", async () => {
    const order: string[] = [];
    withholdHandoff.mockImplementation(() => { order.push("withheld"); return handOn; });
    contextChanged.mockImplementation(() => { order.push(`changed:${events.at(-1)?.type}`); });
    const sent = dispatch.sendTurn(engine, REQ, INPUT, start);
    expect(withholdHandoff).toHaveBeenCalledExactlyOnceWith("t1");
    expect(events).toEqual([]);
    await sent;
    await settled();
    expect(contextChanged).toHaveBeenCalledExactlyOnceWith("b1", "t1");
    expect(order).toEqual(["withheld", "changed:item.completed"]);
    expect(handOn).not.toHaveBeenCalled();
  });

  it.each([
    ["is declined", () => { answer = (event) => (event.tool === "mcp__computer__set_value" ? "deny" : "allow"); }],
    ["breaks", () => { throwAt = "list_apps"; }],
  ])("tells the engine's session about a replay that %s", async (_, arrange) => {
    arrange();
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(contextChanged).toHaveBeenCalledExactlyOnceWith("b1", "t1");
    expect(handOn).not.toHaveBeenCalled();
  });

  it("still ends the turn with its reply when the conversation cannot be marked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    contextChanged.mockImplementation(() => { throw new Error("bots.json could not be written"); });
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(turnCompleted()).toHaveLength(1));
    expect(events.slice(-2)).toMatchObject([
      { type: "item.completed", itemType: "assistant_text", turnId, text: expect.stringContaining("Done. I repeated 2 saved steps") },
      { type: "turn.completed", turnId, ok: true },
    ]);
    expect(dispatch.replayed("t1", turnId)).toBe(RECIPE.id);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bots.json could not be written"));
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    warn.mockRestore();
  });

  it("hands the turn's context on to the AI that takes over, under the replay's turn id", async () => {
    failAt = "set_value";
    start.mockImplementationOnce(async () => {
      expect(handOn).toHaveBeenCalledTimes(1);
      return { turnId: "e1" };
    });
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(handOn).toHaveBeenCalledExactlyOnceWith(turnId);
    expect(contextChanged).not.toHaveBeenCalled();
  });

  it("drives the turn's own gated computer and closes it", async () => {
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(openCaller).toHaveBeenCalledTimes(1);
    expect(openCaller.mock.calls[0]![0]).toBe(INPUT.integrations!.localComputer);
    expect(openCaller.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("marks the request so its steps are never saved again from this turn", async () => {
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    expect(taint).toHaveBeenCalledWith("t1");
    await settled();
  });

  it("binds the turn before any of its events", async () => {
    const sent = dispatch.sendTurn(engine, REQ, INPUT, start);
    expect(events).toEqual([]);
    const { turnId } = await sent;
    expect(events).toEqual([]);
    await settled();
    expect(events[0]).toMatchObject({ type: "turn.started", turnId });
  });

  it("stands in for the engine while it replays", async () => {
    answer = () => undefined;
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await asked();
    const standIn = slots.get("t1")!;
    expect(standIn.instanceId).toBe("claude");
    expect(standIn.driverKind).toBe("claudeAgent");
    expect(standIn.adapter).not.toBe(engine.adapter);
    expect(standIn.adapter.provider).toBe("claudeAgent");
    expect(standIn.adapter.capabilities).toBe(engine.adapter.capabilities);
    expect(standIn.adapter.cacheKeepWarm).toBe(engine.adapter.cacheKeepWarm);
    expect(standIn.adapter.hasSession("t1")).toBe(true);
    expect(engine.adapter.hasSession).toHaveBeenCalledWith("t1");
    expect(await standIn.adapter.steer!("t1", "faster")).toBe("refused");
    expect(engine.adapter.steer).not.toHaveBeenCalled();
    expect(await standIn.adapter.respondToRequest("t1", "an-engine-request", { behavior: "allow" })).toBe("rejected");
    expect(engine.adapter.respondToRequest).toHaveBeenCalledWith("t1", "an-engine-request", { behavior: "allow" });
    const opened = events.find((e) => e.type === "request.opened")!;
    expect(await standIn.adapter.respondToRequest("t1", opened.requestId!, { behavior: "allow" })).toBe("allowed-once");
    expect(engine.adapter.respondToRequest).toHaveBeenCalledTimes(1);
    answer = () => "allow";
    await settled();
    expect(engine.adapter.interruptTurn).not.toHaveBeenCalled();
  });

  it("a declined step ends the turn without the AI and keeps the recipe", async () => {
    answer = (event) => (event.tool === "mcp__computer__set_value" ? "deny" : "allow");
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(acted).toEqual(["click"]);
    expect(events.at(-2)).toMatchObject({ type: "item.completed", itemType: "assistant_text", turnId, text: declinedReply({ kind: "declined", tool: "set_value", label: LABEL }) });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId, ok: true, stopReason: "end_turn", denials: ["mcp__computer__set_value"] });
    expect(events.filter((e) => e.type === "request.resolved").at(-1)).toMatchObject({ behavior: "deny", source: "user" });
    expect(start).not.toHaveBeenCalled();
    expect(recipes.forget).not.toHaveBeenCalled();
    expect(dispatch.replayed("t1", turnId)).toBeUndefined();
  });

  it("a failed step forgets the recipe and hands the request to the AI under the replay's turn id", async () => {
    failAt = "set_value";
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(recipes.forget).toHaveBeenCalledWith("b1", RECIPE.id);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toEqual({ ...INPUT, text: `${INPUT.text}\n\n${fallbackNote(FAILED)}` });
    expect(start.mock.calls[0]![0]).not.toHaveProperty("recoveryText");
    expect(engines()).toBe(engine);
    expect(close).toHaveBeenCalledTimes(1);
    expect(turnCompleted()).toEqual([]);
    expect(events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toBe(false);
    const replayed = events.length;
    expect(dispatch.take(ev("turn.started", "e1"))).toBe(true);
    expect(dispatch.take(ev("item.completed", "e1"))).toBe(true);
    expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
    expect(events.length).toBe(replayed + 2);
    expect(events.slice(-2).map((e) => [e.type, e.turnId])).toEqual([["item.completed", turnId], ["turn.completed", turnId]]);
    expect(events.at(-2)).toMatchObject({ text: "Done by the AI." });
    expect(dispatch.take(ev("item.completed", "e1"))).toBe(false);
    expect(dispatch.replayed("t1", turnId)).toBeUndefined();
  });

  it.each(["", "hello world"])("types into a field that holds %j: empty, or already what the steps type", async (held) => {
    documentText = held;
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(acted).toEqual(["click", "set_value"]);
    expect(start).not.toHaveBeenCalled();
  });

  it("never types over text a field holds: it stops there and hands the request to the AI, naming none of that text", async () => {
    documentText = "Notes for Friday's meeting";
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(acted).toEqual(["click"]);
    expect(events.filter((e) => e.type === "request.opened").map((e) => "tool" in e && e.tool)).toEqual(["mcp__computer__click"]);
    expect(recipes.forget).toHaveBeenCalledWith("b1", RECIPE.id);
    expect(start).toHaveBeenCalledTimes(1);
    const note = start.mock.calls[0]![0].text;
    expect(note).toContain(`did steps 1–1 of 2 and failed at step 2 (set_value)`);
    expect(note).toContain('already holds other text');
    expect(`${note}${JSON.stringify(events)}`).not.toContain("Friday");
  });

  it("a control-gate refusal keeps the recipe and hands the request to the AI with the note", async () => {
    gateAt = "set_value";
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(recipes.forget).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].text).toBe(`${INPUT.text}\n\n${fallbackNote({ kind: "failed", done: 1, total: 2, tool: "set_value", label: LABEL, error: CONTROL_BUSY })}`);
    expect(engines()).toBe(engine);
    expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId });
  });

  it("appends the note to recoveryText too", async () => {
    failAt = "set_value";
    await dispatch.sendTurn(engine, REQ, { ...INPUT, recoveryText: "The conversation so far." }, start);
    await settled();
    expect(start.mock.calls[0]![0]).toMatchObject({
      text: `${INPUT.text}\n\n${fallbackNote(FAILED)}`, recoveryText: `The conversation so far.\n\n${fallbackNote(FAILED)}`,
    });
  });

  it("counts a computer that cannot start as a failure at the first step", async () => {
    openCaller.mockRejectedValueOnce(new Error("MCP server could not start; check its command and installation"));
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(recipes.forget).toHaveBeenCalledWith("b1", RECIPE.id);
    expect(start.mock.calls[0]![0].text).toBe(`${INPUT.text}\n\n${fallbackNote({
      kind: "failed", done: 0, total: 2, tool: "click", label: LABEL, error: "MCP server could not start; check its command and installation",
    })}`);
    expect(close).not.toHaveBeenCalled();
  });

  it("leaves other threads' and turns' events alone", async () => {
    failAt = "set_value";
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(dispatch.take(ev("item.completed", "e1", "t2"))).toBe(false);
    expect(dispatch.take(ev("item.completed", "x"))).toBe(false);
    expect(dispatch.take(ev("item.completed", turnId))).toBe(false);
    expect(dispatch.take({ ...ev("runtime.error", "e1"), turnId: undefined })).toBe(false);
  });

  it("follows the AI turn that reports before its sendTurn answers", async () => {
    failAt = "set_value";
    let answerStart!: (result: TurnStartResult) => void;
    start.mockImplementationOnce(() => new Promise((resolve) => { answerStart = resolve; }));
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(dispatch.take(ev("turn.started", "e1"))).toBe(true);
    expect(dispatch.take(ev("item.completed", "e1"))).toBe(true);
    answerStart({ turnId: "e1" });
    await Promise.resolve();
    expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
    expect(events.slice(-2).map((e) => [e.type, e.turnId])).toEqual([["item.completed", turnId], ["turn.completed", turnId]]);
  });

  it("a fallback that cannot start ends the turn with its error", async () => {
    failAt = "set_value";
    start.mockRejectedValueOnce(new Error("Claude could not start"));
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(turnCompleted()).toHaveLength(1));
    expect(events.slice(-2)).toMatchObject([
      { type: "runtime.error", turnId, message: "Claude could not start" },
      { type: "turn.completed", turnId, ok: false, stopReason: "Claude could not start" },
    ]);
    expect(dispatch.take(ev("item.completed", "e1"))).toBe(false);
  });

  it("interrupts the AI when the person stopped while it was starting", async () => {
    failAt = "set_value";
    start.mockImplementationOnce(async () => {
      stopped = true;
      return { turnId: "e1" };
    });
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(engine.adapter.interruptTurn).toHaveBeenCalledWith("t1"));
  });

  it("does not start the AI for a request the person already stopped", async () => {
    failAt = "set_value";
    answer = (event) => {
      if (event.tool === "mcp__computer__set_value") stopped = true;
      return "allow";
    };
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(turnCompleted()).toHaveLength(1));
    expect(start).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(recipes.forget).toHaveBeenCalledWith("b1", RECIPE.id);
  });

  it("Stop during a replay ends the turn interrupted", async () => {
    answer = () => undefined;
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await asked();
    await slots.get("t1")!.adapter.interruptTurn("t1");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId, ok: false, stopReason: "interrupted" });
    expect(events.filter((e) => e.type === "request.resolved")).toMatchObject([{ behavior: "deny", source: "system" }]);
    expect(acted).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(recipes.forget).not.toHaveBeenCalled();
    expect(engine.adapter.interruptTurn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(contextChanged).toHaveBeenCalledExactlyOnceWith("b1", "t1");
  });

  it("Stop while the computer is still starting ends the turn interrupted", async () => {
    openCaller.mockImplementationOnce((_computer: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("MCP operation cancelled")), { once: true });
    }));
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(openCaller).toHaveBeenCalled());
    await slots.get("t1")!.adapter.interruptTurn("t1");
    expect(types()).toEqual(["turn.started", "turn.completed"]);
    expect(events.at(-1)).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(start).not.toHaveBeenCalled();
    expect(recipes.forget).not.toHaveBeenCalled();
  });

  it("hands Stop to the engine once the AI has taken over", async () => {
    failAt = "set_value";
    answer = () => undefined;
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await asked();
    const standIn = slots.get("t1")!;
    answer = () => "allow";
    const opened = events.find((e) => e.type === "request.opened")!;
    await standIn.adapter.respondToRequest("t1", opened.requestId!, { behavior: "allow" });
    await settled();
    await standIn.adapter.interruptTurn("t1", "e1");
    expect(engine.adapter.interruptTurn).toHaveBeenCalledWith("t1", "e1");
  });

  it("closes the computer and ends the turn when a step throws", async () => {
    throwAt = "list_apps";
    close.mockRejectedValueOnce(new Error("could not stop the computer"));
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(events.slice(-2)).toMatchObject([
      { type: "runtime.error", turnId, message: "the fixture computer broke" },
      { type: "turn.completed", turnId, ok: false, stopReason: "the fixture computer broke" },
    ]);
    expect(recipes.forget).toHaveBeenCalledWith("b1", RECIPE.id);
  });

  it("ends the turn when the replay itself breaks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let broke = false;
    dispatch = new SavedStepsDispatch({ ...deps, publish: (event) => {
      if (event.type === "turn.started" && !broke) {
        broke = true;
        throw new Error("the bus is down");
      }
      deps.publish(event);
    } });
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(turnCompleted()).toHaveLength(1));
    expect(events).toMatchObject([
      { type: "runtime.error", turnId, message: "the bus is down" },
      { type: "turn.completed", turnId, ok: false, stopReason: "the bus is down" },
    ]);
    expect(openCaller).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the bus is down"));
    warn.mockRestore();
  });

  it("ends the turn when handing the request to the AI breaks before the AI starts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failAt = "set_value";
    dispatch = new SavedStepsDispatch({ ...deps, engines: { get: (threadId) => slots.get(threadId), set: (threadId, instance) => {
      if (instance === engine) throw new Error("the engine slot is gone");
      slots.set(threadId, instance);
    } } });
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(turnCompleted()).toHaveLength(1));
    expect(events.slice(-2)).toMatchObject([
      { type: "runtime.error", turnId, message: "the engine slot is gone" },
      { type: "turn.completed", turnId, ok: false, stopReason: "the engine slot is gone" },
    ]);
    expect(start).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the AI's turn alone when the replay breaks after the AI started", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failAt = "set_value";
    dispatch = new SavedStepsDispatch({ ...deps, stopped: () => {
      if (start.mock.calls.length > 0) throw new Error("the request owner is gone");
      return false;
    } });
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("the request owner is gone")));
    expect(start).toHaveBeenCalledTimes(1);
    expect(turnCompleted()).toEqual([]);
    expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
    expect(turnCompleted()).toMatchObject([{ turnId, ok: true }]);
    warn.mockRestore();
  });

  it("forgets an earlier turn's fallback when the next turn starts", async () => {
    failAt = "set_value";
    start.mockImplementationOnce(() => new Promise(() => {}));
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    await dispatch.sendTurn(engine, null, INPUT, start);
    expect(dispatch.take(ev("turn.started", "e2"))).toBe(false);
  });
});

function engines() {
  return slots.get("t1");
}

describe("SavedStepsDispatch.wouldReplay", () => {
  const RECIPE_TOOLS = RECIPE;
  const sendThrough = async (request: ReplayRequest | null, input: SendTurnInput) => {
    recipes.find.mockReturnValue(undefined);
    await dispatch.sendTurn(engine, request, input, start);
  };

  it("holds after a turn that met every replay condition", async () => {
    await sendThrough(REQ, INPUT);
    expect(start).toHaveBeenCalledWith(INPUT);
    expect(dispatch.wouldReplay("t1", RECIPE_TOOLS)).toBe(true);
    expect(dispatch.wouldReplay("t2", RECIPE_TOOLS)).toBe(false);
  });

  it.each<[string, ReplayRequest | null, SendTurnInput]>([
    ["no request", null, INPUT],
    ["Ask", REQ, { ...INPUT, approvalMode: "ask" }],
    ["an Auto place", { ...REQ, placePicked: false }, INPUT],
    ["no host computer", REQ, { ...INPUT, integrations: {} }],
    ["a step's tool not selected", REQ, { ...INPUT, toolScope: { deny: ["mcp:computer:set_value"] } }],
    ["two lines sent as one turn", { ...REQ, turnText: `first\n\n${REQUEST}` }, INPUT],
  ])("fails after a turn with %s", async (_, request, input) => {
    await sendThrough(REQ, INPUT);
    await sendThrough(request, input);
    expect(dispatch.wouldReplay("t1", RECIPE_TOOLS)).toBe(false);
  });

  it("fails while the setting is off", async () => {
    dispatch = new SavedStepsDispatch({ ...deps, enabled: () => false });
    await sendThrough(REQ, INPUT);
    expect(dispatch.wouldReplay("t1", RECIPE_TOOLS)).toBe(false);
  });
});

describe("SavedStepsDispatch.answering", () => {
  it("names a replay's own events, its end included, and not the AI's after a fallback", async () => {
    const seen: [string, boolean][] = [];
    dispatch = new SavedStepsDispatch({ ...deps, publish: (event) => { deps.publish(event); seen.push([event.type, dispatch.answering(event)]); } });
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.filter(([, answering]) => !answering)).toEqual([]);
    expect(seen.at(-1)).toEqual(["turn.completed", true]);
    expect(dispatch.answering(events.at(-1)!)).toBe(false);

    failAt = "set_value";
    seen.length = 0;
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
    expect(seen.at(-1)).toEqual(["turn.completed", false]);
    expect(dispatch.answering({ ...ev("item.completed", turnId), threadId: "t2" })).toBe(false);
  });

  it("keeps an engine's usage-limit hold through a replay, and lets an AI turn end it", async () => {
    const NOW = Date.UTC(2026, 9, 28, 12);
    const clock = new LimitResetClock({ accounts: () => [], loadUsage: async () => ({ fetchedAt: new Date(NOW).toISOString(), providers: [] }), now: () => NOW });
    clock.noteRefusal("claude", NOW + 3_600_000);
    const note = (event: RuntimeEvent) => clock.noteRuntimeEvent(dispatch.answering(event) ? undefined : "claude", event);
    dispatch = new SavedStepsDispatch({ ...deps, publish: (event) => { deps.publish(event); note(event); } });
    await dispatch.sendTurn(engine, REQ, INPUT, start);
    await settled();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(clock.blockedUntil("claude")).toBe(NOW + 3_600_000);
    note(ev("turn.started", "ai-turn"));
    note(ev("turn.completed", "ai-turn"));
    expect(clock.blockedUntil("claude")).toBeNull();
  });
});

describe("SavedStepsDispatch with the engine's session record", () => {
  let order: string[];
  let records: Map<string, HandedState>;
  let replies: Map<string, string[]>;
  let handoffs: Handoffs;
  const unseen = () => unseenMessages(order.map((id) => ({ id, role: "user" as const, text: id })), order, records.get("claude")!).map((m) => m.id);
  const begin = (claimId: string, handoff: Partial<Handoff>) => {
    handoffs.begin("t1", claimId, {
      botId: "b1", instanceId: "claude", config: "c", resumeCursor: "s", started: { sent: [] }, recovery: { sent: [] },
      resumed: { sent: [] }, placed: [], carried: [], own: [], ...handoff,
    });
    handoffs.dispatching("t1", claimId);
  };
  const nextTurnReads = (placed: string[]) => {
    order.push("m4", "m5");
    begin("claim-2", { placed, carried: ["m4"], own: ["m4"] });
    handoffs.bindTurn("t1", "claim-2", "turn-2");
    replies.set("turn-2", ["m5"]);
    handoffs.onEvent(ev("item.completed", "turn-2"));
    handoffs.onEvent(ev("turn.completed", "turn-2"));
  };

  beforeEach(() => {
    order = ["m0", "m1", "m2", "m3"];
    records = new Map([["claude", { session: "s", through: "m1", ids: [] }]]);
    replies = new Map();
    handoffs = new Handoffs({
      order: () => order,
      read: (_bot, _thread, instance) => records.get(instance),
      write: (_bot, _thread, instance, state) => { records.set(instance, state); },
      replies: (_thread, turnId) => replies.get(turnId) ?? [],
    });
    const publish = deps.publish;
    dispatch = new SavedStepsDispatch({ ...deps, withholdHandoff: (threadId) => handoffs.withhold(threadId), publish: (event) => {
      publish(event);
      handoffs.onEvent(event);
    } });
    begin("claim-1", { carried: ["m2"], own: ["m2"] });
  });

  it("leaves the replayed line and its reply for the next AI turn to read, once", async () => {
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    handoffs.bindTurn("t1", "claim-1", turnId);
    replies.set(turnId, ["m3"]);
    await settled();
    expect(start).not.toHaveBeenCalled();
    expect(unseen()).toEqual(["m2", "m3"]);
    nextTurnReads(unseen());
    expect(unseen()).toEqual([]);
  });

  it("counts what the AI that took over received, so the next turn is not offered it again", async () => {
    failAt = "set_value";
    const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start);
    handoffs.bindTurn("t1", "claim-1", turnId);
    replies.set(turnId, ["m3"]);
    await settled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(dispatch.take(ev("item.completed", "e1"))).toBe(true);
    expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
    expect(unseen()).toEqual([]);
  });
});

describe("SavedStepsDispatch with the quick model fallback", () => {
  let scratch: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(scratch);
  });

  it("shows a refused quick model's retry as the replay's one turn", async () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-saved-steps-dispatch-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listeners = new Set<RuntimeEventListener>();
    const sent: SendTurnInput[] = [];
    const scripts: Array<(emit: (type: string, extra?: Record<string, unknown>) => void) => void> = [
      (emit) => {
        emit("turn.started");
        emit("runtime.error", { message: "400 invalid_request_error: quick-model is not supported" });
        emit("turn.completed", { ok: false, stopReason: "400 invalid_request_error: quick-model is not supported" });
      },
      (emit) => {
        emit("turn.started");
        emit("item.completed", { itemType: "assistant_text", text: "Typed it." });
        emit("turn.completed", { ok: true });
      },
    ];
    const adapter = {
      provider: "claudeAgent",
      onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async (input: SendTurnInput) => {
        sent.push(input);
        const turnId = `turn-${sent.length}`;
        const play = scripts[sent.length - 1]!;
        setImmediate(() => play((type, extra = {}) => {
          for (const listener of listeners) listener({ eventId: newId(), provider: "claudeAgent", threadId: input.threadId, turnId, createdAt: "2026-10-27T00:00:00Z", type, ...extra } as RuntimeEvent);
        }));
        return { turnId };
      },
      interruptTurn: async () => {},
    };
    const real = { instanceId: "claude", driverKind: "claudeAgent", adapter } as unknown as ProviderInstance;
    failAt = "list_apps";
    let bus!: EventBus;
    const quick = new QuickModelFallback({ file: join(scratch, "refused.json"), publish: (event) => { if (!composed.take(event)) bus.publish(event); }, stopped: () => false });
    const composed: SavedStepsDispatch = new SavedStepsDispatch({ ...deps, publish: (event) => bus.publish(event) });
    bus = new EventBus(() => {}, (event) => quick.take(event) || composed.take(event));
    bus.attach([real]);
    const delivered: RuntimeEvent[] = [];
    bus.subscribe((event) => delivered.push(event));

    const { turnId } = await composed.sendTurn(real, REQ, { ...INPUT, model: "quick-model" }, (input) =>
      quick.sendTurn(real, input, { model: "quick-model", own: { model: "own-model" }, onFallback: () => {} }));
    await vi.waitFor(() => expect(delivered.some((event) => event.type === "turn.completed")).toBe(true));
    bus.detachAll();

    expect(delivered.map((event) => [event.type, event.turnId])).toEqual([
      ["turn.started", turnId], ["item.completed", turnId], ["turn.completed", turnId],
    ]);
    expect(delivered.at(-1)).toMatchObject({ ok: true });
    expect(delivered[1]).toMatchObject({ itemType: "assistant_text", text: "Typed it." });
    const note = fallbackNote({ kind: "failed", done: 0, total: 2, tool: "click", label: LABEL, error: "Fixture failure." });
    expect(sent.map(({ model, text }) => ({ model, text }))).toEqual([
      { model: "quick-model", text: `${INPUT.text}\n\n${note}` }, { model: "own-model", text: `${INPUT.text}\n\n${note}` },
    ]);
  });
});
