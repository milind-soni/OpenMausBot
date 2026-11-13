import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog, ProviderInstance, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { quickRetryRequestMayDispatch } from "./host/request-session.ts";
import { QuickModelFallback, refusesModel, type QuickRetryOwner, type QuickRoute } from "./quick-model-fallback.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { routeDirectTurn } from "./turn-route.ts";

const CHATGPT_REFUSAL = 'unexpected status 400 Bad Request: {"type":"invalid_request_error","message":"The \'gpt-5.4-mini\' model is not supported when using Codex with a ChatGPT account."}';

type Emit = (type: string, extra?: Record<string, unknown>) => void;
type Play = (emit: Emit) => void | Promise<void>;

/** An engine whose nth sendTurn plays the nth script, after sendTurn has answered, as real adapters do. */
function engine(scripts: Play[]) {
  const listeners = new Set<RuntimeEventListener>();
  const sent: SendTurnInput[] = [];
  const interrupted: string[] = [];
  const adapter = {
    provider: "codex",
    onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendTurn: async (input: SendTurnInput) => {
      sent.push(input);
      const turnId = `turn-${sent.length}`;
      const play = scripts[sent.length - 1];
      const emit: Emit = (type, extra = {}) => {
        for (const listener of listeners) {
          listener({ eventId: `${turnId}-${type}`, provider: "codex", threadId: input.threadId, turnId, createdAt: "2026-10-23T00:00:00Z", type, ...extra } as RuntimeEvent);
        }
      };
      setImmediate(() => { void play?.(emit); });
      return { turnId };
    },
    interruptTurn: async (threadId: string) => { interrupted.push(threadId); },
  };
  const instance = { instanceId: "codex", driverKind: "codex", adapter } as unknown as ProviderInstance;
  return { instance, sent, interrupted };
}

const refusedQuickTurn: Play = (emit) => {
  emit("turn.started");
  emit("session.started", { sessionId: "native-1", model: "gpt-5.4-mini" });
  emit("runtime.error", { message: CHATGPT_REFUSAL });
  emit("turn.completed", { ok: false, stopReason: CHATGPT_REFUSAL, cost: null });
};
const answered: Play = (emit) => {
  emit("turn.started");
  emit("item.completed", { itemType: "assistant_text", text: "Hi! All good here." });
  emit("turn.completed", { ok: true, cost: null });
};

describe("refusesModel", () => {
  it("knows a refusal that names the model", () => {
    expect(refusesModel(CHATGPT_REFUSAL, "gpt-5.4-mini")).toBe(true);
    expect(refusesModel("There's an issue with the selected model (claude-haiku-4-5). It may not exist or you may not have access to it.", "claude-haiku-4-5")).toBe(true);
    expect(refusesModel("model_not_found: haiku-9 does not exist", "anthropic/haiku-9")).toBe(true);
  });

  it("leaves other failures, and refusals of another model, alone", () => {
    expect(refusesModel("stream disconnected before completion", "gpt-5.4-mini")).toBe(false);
    expect(refusesModel("400 Bad Request: input is too long", "gpt-5.4-mini")).toBe(false);
    expect(refusesModel(CHATGPT_REFUSAL, "gpt-6-luna")).toBe(false);
    expect(refusesModel(undefined, "gpt-5.4-mini")).toBe(false);
  });
});

describe("QuickModelFallback", () => {
  let scratch: string;
  let file: string;
  let stopped: boolean;
  let liveSession: string | undefined;
  let requestSessionId: string | undefined;
  let activeGeneration: string;
  let turnBusy: boolean;
  let companyShutdown: boolean;
  let dispatchClaimPresent: boolean;
  let observeClaimAtRetry: boolean;
  let claimsAtRetry: boolean[];
  let fallback: QuickModelFallback;
  let bus: EventBus;
  let delivered: Array<{ event: RuntimeEvent; routed: string | undefined }>;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-quick-fallback-"));
    file = join(scratch, "refused-quick-models.json");
    stopped = false;
    liveSession = "session-a";
    requestSessionId = "session-a";
    activeGeneration = "generation-a";
    turnBusy = true;
    companyShutdown = false;
    dispatchClaimPresent = true;
    observeClaimAtRetry = false;
    claimsAtRetry = [];
    fallback = new QuickModelFallback({ file, publish: (event) => bus.publish(event), stopped: () => stopped,
      mayDispatch: (_threadId, owner) => quickRetryRequestMayDispatch(owner, activeGeneration,
        { generation: activeGeneration, generations: new Set([activeGeneration]), requestSessionId, stopped, turnId: null },
        (botId) => { if (observeClaimAtRetry) claimsAtRetry.push(dispatchClaimPresent); return botId === "bot-a" && !companyShutdown && turnBusy; }, (id) => id === liveSession) });
    bus = new EventBus(() => {}, (event) => fallback.take(event));
    delivered = [];
    bus.subscribe((event) => delivered.push({ event, routed: fallback.routedModel(event.threadId) }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    bus.detachAll();
    await removeTempDir(scratch);
  });

  const quick = (onFallback = vi.fn()): QuickRoute & { onFallback: ReturnType<typeof vi.fn> } =>
    ({ model: "gpt-5.4-mini", own: { model: "gpt-6-luna", effort: "high", variant: "v" }, onFallback });
  const retryOwner: QuickRetryOwner = { botId: "bot-a", generation: "generation-a", requestSessionId: "session-a" };
  const input: SendTurnInput = { threadId: "t", text: "hey, how are you?", model: "gpt-5.4-mini", system: "You are Elo." };
  const settled = () => vi.waitFor(() => expect(delivered.some(({ event }) => event.type === "turn.completed")).toBe(true));

  it("runs a refused quick turn again on the bot's own model, as one turn with one reply", async () => {
    const { instance, sent } = engine([refusedQuickTurn, answered]);
    bus.attach([instance]);
    const route = quick();

    await expect(fallback.sendTurn(instance, input, route, retryOwner)).resolves.toEqual({ turnId: "turn-1" });
    await settled();

    expect(delivered.map(({ event }) => [event.type, event.turnId])).toEqual([
      ["turn.started", "turn-1"],
      ["session.started", "turn-1"],
      ["item.completed", "turn-1"],
      ["turn.completed", "turn-1"],
    ]);
    expect(delivered.at(-1)).toMatchObject({ event: { ok: true }, routed: undefined });
    expect(delivered.some(({ event }) => event.type === "runtime.error")).toBe(false);
    expect(sent.map(({ model, effort, variant }) => ({ model, effort, variant }))).toEqual([
      { model: "gpt-5.4-mini", effort: undefined, variant: undefined },
      { model: "gpt-6-luna", effort: "high", variant: "v" },
    ]);
    expect(sent[1]).toMatchObject({ threadId: "t", text: input.text, system: input.system });
    expect(route.onFallback).toHaveBeenCalledTimes(1);
  });

  it("remembers the refused quick model for that engine instance, across restarts", async () => {
    const { instance } = engine([refusedQuickTurn, answered]);
    bus.attach([instance]);
    await fallback.sendTurn(instance, input, quick(), retryOwner);
    await settled();

    expect([...fallback.refused("codex")]).toEqual(["gpt-5.4-mini"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ codex: ["gpt-5.4-mini"] });
    const restarted = new QuickModelFallback({ file, publish: () => {}, stopped: () => false, mayDispatch: (_threadId, owner) => Boolean(owner) });
    expect([...restarted.refused("codex")]).toEqual(["gpt-5.4-mini"]);
    expect([...restarted.refused("claude")]).toEqual([]);

    const catalog: ModelCatalog = { default: "gpt-5.4", options: [{ id: "gpt-5.4", label: "GPT-5.4" }, { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" }] };
    const bot = { replyStyle: "conversational" as const, modelSelection: { instanceId: "codex", model: "gpt-5.4" } };
    const codex = { models: catalog, adapter: { capabilities: { effortLevels: ["low", "high"] as const } } };
    const hi = { text: "hey, how are you?", images: [] };
    expect(routeDirectTurn(bot, {}, [], hi, codex, false, fallback.refused("other")).quickModel).toBe("GPT-5.4 Mini");
    expect(routeDirectTurn(bot, {}, [], hi, codex, false, restarted.refused("codex")).quickModel).toBeUndefined();
  });

  it("keeps a quick turn that worked, and says which model it ran on as it settles", async () => {
    const { instance, sent } = engine([answered]);
    bus.attach([instance]);
    await fallback.sendTurn(instance, input, quick(), retryOwner);
    await settled();

    expect(sent).toHaveLength(1);
    expect(delivered.at(-1)).toMatchObject({ event: { type: "turn.completed", ok: true }, routed: "gpt-5.4-mini" });
    expect(fallback.routedModel("t")).toBeUndefined();
  });

  it("passes any other failure through and runs nothing again", async () => {
    const { instance, sent } = engine([(emit) => {
      emit("turn.started");
      emit("runtime.error", { message: "stream disconnected before completion" });
      emit("turn.completed", { ok: false, stopReason: "stream disconnected before completion", cost: null });
    }]);
    bus.attach([instance]);
    const route = quick();
    await fallback.sendTurn(instance, input, route, retryOwner);
    await settled();

    expect(delivered.map(({ event }) => event.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(sent).toHaveLength(1);
    expect(route.onFallback).not.toHaveBeenCalled();
    expect([...fallback.refused("codex")]).toEqual([]);
  });

  it("reports the refusal instead of running again once the person pressed Stop", async () => {
    const { instance, sent } = engine([refusedQuickTurn, answered]);
    bus.attach([instance]);
    stopped = true;
    await fallback.sendTurn(instance, input, quick(), retryOwner);
    await settled();

    expect(delivered.map(({ event }) => event.type)).toEqual(["turn.started", "session.started", "runtime.error", "turn.completed"]);
    expect(delivered.at(-1)).toMatchObject({ event: { ok: false }, routed: "gpt-5.4-mini" });
    expect(sent).toHaveLength(1);
  });

  it("retries after provider acknowledgement releases the dispatch claim while the same turn remains busy", async () => {
    let reportStarted!: () => void;
    let releaseRefusal!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const refusalGate = new Promise<void>((resolve) => { releaseRefusal = resolve; });
    const refusedAfterAck: Play = async (emit) => {
      emit("turn.started");
      reportStarted();
      await refusalGate;
      emit("runtime.error", { message: CHATGPT_REFUSAL });
      emit("turn.completed", { ok: false, stopReason: CHATGPT_REFUSAL, cost: null });
    };
    const { instance, sent } = engine([refusedAfterAck, answered]);
    bus.attach([instance]);
    observeClaimAtRetry = true;

    await fallback.sendTurn(instance, input, quick(), retryOwner);
    await started;
    dispatchClaimPresent = false;
    releaseRefusal();
    await settled();

    expect(claimsAtRetry).toEqual([false]);
    expect(sent).toHaveLength(2);
    expect(sent[1].model).toBe("gpt-6-luna");
    expect(delivered.at(-1)?.event).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("does not retry when the original session is revoked after scheduling", async () => {
    const { instance, sent } = engine([(emit) => {
      emit("turn.started");
      emit("runtime.error", { message: CHATGPT_REFUSAL });
      emit("turn.completed", { ok: false, stopReason: CHATGPT_REFUSAL, cost: null });
      liveSession = "revoked-session";
    }, answered]);
    bus.attach([instance]);
    const route = quick();
    await fallback.sendTurn(instance, input, route, retryOwner);
    await settled();

    expect(sent).toHaveLength(1);
    expect(delivered.map(({ event }) => event.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(delivered.at(-1)?.event).toMatchObject({ ok: false, stopReason: CHATGPT_REFUSAL });
    expect(route.onFallback).toHaveBeenCalledTimes(1);
    expect(fallback.routedModel("t")).toBeUndefined();
  });

  it("does not let a newer live session authorize an older retry on the same thread", async () => {
    const { instance, sent } = engine([(emit) => {
      emit("turn.started");
      emit("runtime.error", { message: CHATGPT_REFUSAL });
      emit("turn.completed", { ok: false, stopReason: CHATGPT_REFUSAL, cost: null });
      activeGeneration = "generation-b";
      liveSession = "session-b";
      requestSessionId = "session-b";
    }, answered]);
    bus.attach([instance]);
    const route = quick();
    await fallback.sendTurn(instance, input, route, retryOwner);
    await settled();

    expect(sent).toHaveLength(1);
    expect(delivered.at(-1)?.event).toMatchObject({ ok: false, stopReason: CHATGPT_REFUSAL });
    expect(fallback.routedModel("t")).toBeUndefined();
  });

  it("keeps explicitly owned sessionless routine retries working", async () => {
    liveSession = undefined;
    requestSessionId = undefined;
    const { instance, sent } = engine([refusedQuickTurn, answered]);
    bus.attach([instance]);
    await fallback.sendTurn(instance, input, quick(), { botId: "bot-a", generation: "generation-a" });
    await settled();

    expect(sent).toHaveLength(2);
    expect(delivered.at(-1)?.event).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("does not retry after company shutdown even when the request session remains live", async () => {
    const { instance, sent } = engine([(emit) => {
      emit("turn.started");
      emit("runtime.error", { message: CHATGPT_REFUSAL });
      emit("turn.completed", { ok: false, stopReason: CHATGPT_REFUSAL, cost: null });
      companyShutdown = true;
    }, answered]);
    bus.attach([instance]);
    await fallback.sendTurn(instance, input, quick(), retryOwner);
    await settled();

    expect(sent).toHaveLength(1);
    expect(delivered.at(-1)?.event).toMatchObject({ ok: false, stopReason: CHATGPT_REFUSAL });
  });

  it("reports the refusal when the run on the bot's own model cannot start", async () => {
    const { instance, sent } = engine([refusedQuickTurn]);
    const send = instance.adapter.sendTurn;
    instance.adapter.sendTurn = async (turn) => {
      if (sent.length) throw new Error("engine busy");
      return send(turn);
    };
    bus.attach([instance]);
    await fallback.sendTurn(instance, input, quick(), retryOwner);
    await settled();

    expect(delivered.map(({ event }) => event.type)).toEqual(["turn.started", "session.started", "runtime.error", "turn.completed"]);
    expect(delivered.at(-1)?.event).toMatchObject({ turnId: "turn-1", ok: false });
  });

  it("leaves a turn that was not moved to a quick model untouched", async () => {
    const { instance, sent } = engine([refusedQuickTurn]);
    bus.attach([instance]);
    await fallback.sendTurn(instance, { ...input, model: "gpt-6-luna" });
    await settled();

    expect(delivered.map(({ event }) => event.type)).toEqual(["turn.started", "session.started", "runtime.error", "turn.completed"]);
    expect(sent).toHaveLength(1);
  });
});
