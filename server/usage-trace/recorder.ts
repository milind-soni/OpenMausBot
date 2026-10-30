// Records each turn's AI steps and tool calls from the runtime events every engine emits, plus the receipts OMB's own tools
// send, and hands the turn's timing, parent and outcome to its usage row when the turn is booked.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { TOOL_NAMESPACE } from "../../shared/tool-surface.ts";
import type { TraceParent, TraceStatus, TraceTokens, TraceUsageStatus } from "../../shared/usage-trace.ts";
import { onJsonBody, parsedBodyOf } from "../harness/http.ts";
import { errorLine, pageTitle, toolDetail } from "./detail.ts";
import { appendSpans, type SpanRecord, type StepSpan, type ToolSpan } from "./spans.ts";

/** What a booked turn adds to its usage row. */
export interface TurnTraceFields {
  turnId: string;
  startedAt: string;
  endedAt: string;
  parent?: TraceParent;
  outcome: { status: TraceStatus; reason?: string };
  steps: number;
  tools: number;
  toolErrors: number;
  cacheWrite?: number;
  reasoning?: number;
  contextTokens?: number;
  contextWindow?: number;
  usageStatus: TraceUsageStatus;
}

/** A tool call OMB itself served, timed on the server whatever engine made it. */
export interface ToolReceipt {
  name: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface LiveTurnView {
  threadId: string;
  turnId: string;
  provider: string;
  startedAt: number;
  endedAt?: number;
  parent?: TraceParent;
  status?: TraceStatus;
  spans: Array<SpanRecord & { running?: boolean }>;
}

interface Tool extends ToolSpan {
  /** The engine's own item id, when the engine reported this call. */
  itemId?: string;
}

interface Turn {
  threadId: string;
  turnId: string;
  provider: string;
  startedAt: number;
  endedAt?: number;
  parent?: TraceParent;
  status?: TraceStatus;
  reason?: string;
  lastError?: string;
  lastEventAt: number;
  steps: StepSpan[];
  openStep: StepSpan | null;
  stepByCall: Map<string, StepSpan>;
  tools: Map<string, Tool>;
  byItem: Map<string, Tool>;
  openTools: Set<string>;
  receipts: Tool[];
  usage?: { cachedInput?: number };
  sawTokens: boolean;
  turnTotals?: TraceTokens;
  contextTokens?: number;
  contextWindow?: number;
  flushed: boolean;
}

type Expectation = { node: string; resumed?: boolean } | { parent: TraceParent };

/** A turn not seen to finish by then is closed as stopped: its engine went away without saying so. */
const STALE_MS = 30 * 60_000;
/** An expected start that never came (a refused dispatch, a held room member) must not adopt a later turn. */
const EXPECT_TTL_MS = 60_000;

/** Claude reports each model call; Codex a thread's running total; the OpenAI-style chat engines a turn's running total. */
const PER_CALL = new Set(["claude"]);
const THREAD_TOTALS = new Set(["codex"]);
const TURN_TOTALS = new Set(["grok", "groq", "cerebras", "mistral", "minimax", "meta", "openai-compat"]);
const MAX_LINKS = 5_000;
const ENDED_GRACE_MS = 120_000;
const RECEIPT_SLACK_MS = 3_000;
const STOPPED = /interrupt|cancel|abort|stopp?ed|user_stop/i;

const at = (event: RuntimeEvent): number => {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
};
const bare = (name: string) => name.replace(TOOL_NAMESPACE, "");
const zero = (): TraceTokens => ({ input: 0, cachedInput: 0, output: 0 });

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_LINKS) map.delete(map.keys().next().value as K);
}

function addTokens(step: StepSpan, delta: TraceTokens): void {
  const into = step.tokens ?? zero();
  into.input += delta.input;
  into.cachedInput += delta.cachedInput;
  into.output += delta.output;
  if (delta.reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + delta.reasoning;
  step.tokens = into;
}

function difference(now: TraceTokens, before: TraceTokens): TraceTokens | null {
  if (now.input < before.input || now.output < before.output) return null;
  return {
    input: now.input - before.input,
    cachedInput: Math.max(0, now.cachedInput - before.cachedInput),
    output: now.output - before.output,
    ...(now.reasoning !== undefined ? { reasoning: Math.max(0, now.reasoning - (before.reasoning ?? 0)) } : {}),
  };
}

export type TraceRecorder = ReturnType<typeof createTraceRecorder>;

export function createTraceRecorder(options: { dataDir: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const live = new Map<string, Turn>();
  const ended = new Map<string, { turn: Turn; timer: ReturnType<typeof setTimeout> }>();
  const expected = new Map<string, { expectation: Expectation; at: number }>();
  const nodeParents = new Map<string, TraceParent>();
  const nodeTurns = new Map<string, TraceParent>();
  const threadTotals = new Map<string, TraceTokens>();
  const finished = new Map<string, true>();

  const stepId = (turn: Turn) => `${turn.threadId}:${turn.turnId}:step-${turn.steps.length + 1}`;
  const openStep = (turn: Turn, startedAt: number): StepSpan => {
    const step: StepSpan = { kind: "step", id: stepId(turn), threadId: turn.threadId, turnId: turn.turnId, startedAt };
    turn.steps.push(step);
    turn.openStep = step;
    return step;
  };
  const closeStep = (turn: Turn, endedAt: number) => {
    if (!turn.openStep) return;
    turn.openStep.endedAt = Math.max(turn.openStep.startedAt, endedAt);
    turn.openStep = null;
  };

  function parentFor(threadId: string, turnId: string): TraceParent | undefined {
    const entry = expected.get(threadId);
    expected.delete(threadId);
    if (!entry || now() - entry.at > EXPECT_TTL_MS) return undefined;
    const { expectation } = entry;
    if ("parent" in expectation) return expectation.parent;
    if (expectation.resumed) return nodeTurns.get(expectation.node);
    if (!nodeTurns.has(expectation.node)) remember(nodeTurns, expectation.node, { threadId, turnId });
    return nodeParents.get(expectation.node);
  }

  function begin(event: RuntimeEvent, turnId: string): Turn {
    const startedAt = at(event);
    const turn: Turn = {
      threadId: event.threadId, turnId, provider: event.provider, startedAt,
      steps: [], openStep: null, stepByCall: new Map(), tools: new Map(), byItem: new Map(), openTools: new Set(), receipts: [],
      sawTokens: false, flushed: false, lastEventAt: startedAt,
    };
    const replaced = live.get(event.threadId);
    if (replaced) close(replaced, replaced.lastEventAt, "interrupted");
    const parent = parentFor(event.threadId, turnId);
    if (parent && !(parent.threadId === turn.threadId && parent.turnId === turnId)) turn.parent = parent;
    openStep(turn, startedAt);
    live.set(event.threadId, turn);
    return turn;
  }

  function turnFor(event: RuntimeEvent): Turn | null {
    const current = live.get(event.threadId);
    if (!event.turnId) return current ?? null;
    if (current?.turnId === event.turnId) return current;
    if (finished.has(`${event.threadId}:${event.turnId}`)) return null;
    return begin(event, event.turnId);
  }

  function toolStarted(turn: Turn, event: Extract<RuntimeEvent, { type: "item.started" }>): void {
    const itemId = event.itemId ?? event.eventId;
    const id = `${turn.threadId}:${turn.turnId}:${itemId}`;
    if (turn.tools.has(id) || turn.byItem.has(itemId)) return;
    const startedAt = at(event);
    const name = event.title ?? "tool";
    closeStep(turn, startedAt);
    const receipt = turn.receipts.find((tool) => !tool.itemId && bare(tool.name) === bare(name) && Math.abs(tool.startedAt - startedAt) <= RECEIPT_SLACK_MS);
    if (receipt) {
      receipt.itemId = itemId;
      turn.byItem.set(itemId, receipt);
    } else {
      const detail = toolDetail(name, event.input, event.summary);
      const tool: Tool = { kind: "tool", id, threadId: turn.threadId, turnId: turn.turnId, name, itemId, startedAt, status: "ok",
        timedBy: "engine", ...(detail ? { detail } : {}) };
      turn.tools.set(id, tool);
      turn.byItem.set(itemId, tool);
    }
    turn.openTools.add(itemId);
  }

  function toolCompleted(turn: Turn, event: Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>): void {
    const itemId = event.itemId ?? event.eventId;
    const endedAt = at(event);
    let tool = turn.byItem.get(itemId);
    if (!tool) {
      closeStep(turn, endedAt);
      const id = `${turn.threadId}:${turn.turnId}:${itemId}`;
      tool = { kind: "tool", id, threadId: turn.threadId, turnId: turn.turnId, name: "tool", itemId, startedAt: endedAt, status: "ok", timedBy: "engine" };
      turn.tools.set(id, tool);
      turn.byItem.set(itemId, tool);
    }
    if (tool.timedBy === "engine") tool.endedAt = Math.max(tool.startedAt, endedAt);
    if (!event.ok) {
      tool.status = "error";
      tool.error ??= errorLine(event.output);
    }
    const title = pageTitle(event.output);
    if (title && !tool.detail?.includes(title)) tool.detail = tool.detail ? `${tool.detail} · ${title}`.slice(0, 120) : title;
    turn.openTools.delete(itemId);
    if (!turn.openTools.size && !turn.openStep) openStep(turn, endedAt);
  }

  function tokens(turn: Turn, event: Extract<RuntimeEvent, { type: "thread.token-usage.updated" }>): void {
    if (event.contextTokens !== undefined) turn.contextTokens = event.contextTokens;
    if (event.contextWindow !== undefined) turn.contextWindow = event.contextWindow;
    const reported: TraceTokens = { input: event.input, cachedInput: event.cachedInput ?? 0, output: event.output,
      ...(typeof event.reasoning === "number" ? { reasoning: event.reasoning } : {}) };
    const callId = event.itemId;
    let step = callId ? turn.stepByCall.get(callId) : undefined;
    if (!step) {
      step = turn.openStep ?? turn.steps.at(-1) ?? openStep(turn, turn.startedAt);
      if (callId && PER_CALL.has(turn.provider)) {
        const owner = [...turn.stepByCall.entries()].find(([, value]) => value === step)?.[0];
        if (owner && owner !== callId) {
          const time = at(event);
          closeStep(turn, time);
          step = openStep(turn, Math.max(step.endedAt ?? time, step.startedAt));
        }
        turn.stepByCall.set(callId, step);
      }
    }
    if (event.contextTokens !== undefined) step.contextTokens = event.contextTokens;
    if (event.contextWindow !== undefined) step.contextWindow = event.contextWindow;
    if (event.input > 0 || event.output > 0) turn.sawTokens = true;
    if (PER_CALL.has(turn.provider)) {
      if (event.input <= 0 && event.output <= 0) return;
      const cacheWrite = Math.max(0, (event.contextTokens ?? event.input) - event.input);
      step.tokens = { ...reported, output: Math.max(step.tokens?.output ?? 0, reported.output), ...(cacheWrite ? { cacheWrite } : {}) };
    } else if (THREAD_TOTALS.has(turn.provider)) {
      const before = threadTotals.get(turn.threadId);
      threadTotals.set(turn.threadId, reported);
      const delta = before && difference(reported, before);
      if (delta) addTokens(step, delta);
    } else if (TURN_TOTALS.has(turn.provider)) {
      const delta = difference(reported, turn.turnTotals ?? zero());
      turn.turnTotals = reported;
      if (delta) addTokens(step, delta);
    }
  }

  function flush(turn: Turn, spans: SpanRecord[] = [...turn.steps, ...turn.tools.values()], now = true): void {
    turn.flushed = true;
    appendSpans(options.dataDir, spans.map(({ itemId: _itemId, ...span }: SpanRecord & { itemId?: string }) => span as SpanRecord), now);
  }

  /** Ends a turn's open step and tools, writes its spans and keeps it from reopening. */
  function close(turn: Turn, end: number, status: TraceStatus): number {
    const endedAt = Math.max(turn.startedAt, end);
    closeStep(turn, endedAt);
    for (const itemId of turn.openTools) {
      const tool = turn.byItem.get(itemId);
      if (tool && tool.timedBy === "engine") {
        tool.endedAt = endedAt;
        if (tool.status === "ok") tool.status = "ended";
      }
    }
    turn.openTools.clear();
    turn.endedAt = endedAt;
    turn.status = status;
    flush(turn);
    remember(finished, `${turn.threadId}:${turn.turnId}`, true);
    if (live.get(turn.threadId) === turn) live.delete(turn.threadId);
    return endedAt;
  }

  function complete(turn: Turn, event: Extract<RuntimeEvent, { type: "turn.completed" }>): void {
    if (!event.ok) turn.reason = turn.lastError ?? (event.stopReason ? errorLine(event.stopReason.replace(/_/g, " ")) : undefined);
    if (event.usage) turn.usage = typeof event.usage.cachedInput === "number" ? { cachedInput: event.usage.cachedInput } : {};
    close(turn, at(event), event.ok ? "ok" : STOPPED.test(`${event.stopReason ?? ""} ${turn.lastError ?? ""}`) ? "interrupted" : "error");
    const previous = ended.get(turn.threadId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => { if (ended.get(turn.threadId)?.turn === turn) ended.delete(turn.threadId); }, ENDED_GRACE_MS);
    timer.unref?.();
    ended.set(turn.threadId, { turn, timer });
  }

  function observe(event: RuntimeEvent): void {
    if (!event.threadId) return;
    if (event.type === "turn.started") {
      if (event.turnId && live.get(event.threadId)?.turnId !== event.turnId && !finished.has(`${event.threadId}:${event.turnId}`)) begin(event, event.turnId);
      return;
    }
    if (event.type === "session.started" || event.type === "session.exited" || event.type === "session.model-variants") return;
    const turn = turnFor(event);
    if (!turn) return;
    turn.lastEventAt = at(event);
    switch (event.type) {
      case "item.started":
        if (event.itemType === "tool") toolStarted(turn, event);
        break;
      case "item.completed":
        if (event.itemType === "tool") toolCompleted(turn, event);
        break;
      case "thread.token-usage.updated":
        tokens(turn, event);
        break;
      case "runtime.error":
        turn.lastError = errorLine(event.message);
        break;
      case "turn.completed":
        complete(turn, event);
        break;
    }
  }

  /** OMB's own record of a tool it served: its timing replaces the engine's, or it stands alone when the engine reported none. */
  function receipt(threadId: string, served: ToolReceipt): void {
    const turn = live.get(threadId) ?? ended.get(threadId)?.turn;
    if (!turn || !Number.isFinite(served.startedAt) || !Number.isFinite(served.endedAt) || served.endedAt < served.startedAt) return;
    if (served.startedAt < turn.startedAt - RECEIPT_SLACK_MS || served.endedAt > now() + RECEIPT_SLACK_MS) return;
    if (!turn.endedAt) turn.lastEventAt = Math.max(turn.lastEventAt, served.endedAt);
    const near = (tool: Tool) => tool.startedAt <= served.endedAt + RECEIPT_SLACK_MS && (tool.endedAt ?? Infinity) >= served.startedAt - RECEIPT_SLACK_MS;
    const matches = [...turn.tools.values()].filter((tool) => tool.timedBy === "engine" && bare(tool.name) === served.name && near(tool));
    const tool = matches.sort((a, b) => Math.abs(a.startedAt - served.startedAt) - Math.abs(b.startedAt - served.startedAt))[0];
    let span: Tool;
    if (tool) {
      span = tool;
      span.startedAt = served.startedAt;
      span.endedAt = served.endedAt;
      span.timedBy = "omb";
    } else {
      const id = `${turn.threadId}:${turn.turnId}:omb-${served.startedAt}-${turn.tools.size}`;
      span = { kind: "tool", id, threadId: turn.threadId, turnId: turn.turnId, name: served.name, startedAt: served.startedAt,
        endedAt: served.endedAt, status: "ok", timedBy: "omb" };
      turn.tools.set(id, span);
      turn.receipts.push(span);
      const step = turn.openStep;
      if (step && !turn.openTools.size && served.startedAt >= step.startedAt && !turn.endedAt) {
        closeStep(turn, served.startedAt);
        openStep(turn, served.endedAt);
      }
    }
    if (served.detail) span.detail = served.detail;
    if (!served.ok) {
      span.status = "error";
      if (served.error) span.error = served.error;
    }
    if (turn.flushed) flush(turn, [span], false);
  }

  function settle(threadId: string): TurnTraceFields | Record<string, never> {
    const entry = ended.get(threadId);
    if (!entry) return {};
    ended.delete(threadId);
    clearTimeout(entry.timer);
    const { turn } = entry;
    const tools = [...turn.tools.values()];
    const sum = (pick: (step: StepSpan) => number | undefined) => {
      const values = turn.steps.map(pick).filter((value): value is number => typeof value === "number");
      return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
    };
    const cacheWrite = PER_CALL.has(turn.provider) ? sum((step) => step.tokens?.cacheWrite) : undefined;
    const reasoning = sum((step) => step.tokens?.reasoning);
    return {
      turnId: turn.turnId,
      startedAt: new Date(turn.startedAt).toISOString(),
      endedAt: new Date(turn.endedAt ?? now()).toISOString(),
      ...(turn.parent ? { parent: turn.parent } : {}),
      outcome: { status: turn.status ?? "ok", ...(turn.reason ? { reason: turn.reason } : {}) },
      steps: turn.steps.length,
      tools: tools.length,
      toolErrors: tools.filter((tool) => tool.status === "error").length,
      ...(cacheWrite ? { cacheWrite } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(turn.contextTokens !== undefined ? { contextTokens: turn.contextTokens } : {}),
      ...(turn.contextWindow !== undefined ? { contextWindow: turn.contextWindow } : {}),
      usageStatus: turn.usage ? (turn.usage.cachedInput !== undefined ? "complete" : "partial") : turn.sawTokens ? "partial" : "unavailable",
    };
  }

  /** Times one MCP request OMB serves itself (browser, computer, data, connected apps): a receipt once its answer is sent. */
  function timeServed(req: IncomingMessage, res: ServerResponse, threadId: string): void {
    const startedAt = now();
    onJsonBody(res, (body) => {
      const request = parsedBodyOf(req) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | undefined;
      const name = request?.method === "tools/call" ? request.params?.name : undefined;
      if (typeof name !== "string" || !name) return body;
      const answer = (body ?? {}) as { error?: unknown; result?: { isError?: unknown; content?: Array<{ text?: unknown }> } };
      const failed = answer.error !== undefined || answer.result?.isError === true;
      const detail = toolDetail(name, request?.params?.arguments);
      const error = failed ? errorLine(typeof answer.error === "string" ? answer.error : answer.result?.content?.find((part) => typeof part.text === "string")?.text) : undefined;
      receipt(threadId, { name, startedAt, endedAt: now(), ok: !failed, ...(detail ? { detail } : {}), ...(error ? { error } : {}) });
      return body;
    });
  }

  /** Turns not yet booked, with every span so far: what a live trace draws. */
  function liveTurns(): LiveTurnView[] {
    for (const turn of live.values()) if (now() - turn.lastEventAt > STALE_MS) close(turn, turn.lastEventAt, "interrupted");
    const view = (turn: Turn, running: boolean): LiveTurnView => ({
      threadId: turn.threadId, turnId: turn.turnId, provider: turn.provider, startedAt: turn.startedAt,
      ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
      ...(turn.parent ? { parent: turn.parent } : {}),
      ...(turn.status ? { status: turn.status } : {}),
      spans: [
        ...turn.steps.map((step) => ({ ...step, ...(running && step === turn.openStep ? { running: true } : {}) })),
        ...[...turn.tools.values()].map(({ itemId, ...tool }) => ({ ...tool, ...(running && itemId && turn.openTools.has(itemId) ? { running: true } : {}) })),
      ],
    });
    return [...[...live.values()].map((turn) => view(turn, true)), ...[...ended.values()].map(({ turn }) => view(turn, false))];
  }

  return {
    observe,
    receipt,
    timeServed,
    settle,
    liveTurns,
    /** The next turn to start on `threadId` belongs to coordinator node `node`, or to an explicit parent turn. */
    expect(threadId: string, expectation: Expectation): void {
      expected.set(threadId, { expectation, at: now() });
    },
    /** Coordinator node `node` was handed off by node `parentNode`, from the turn `parent`. */
    link(node: string, parentNode: string | undefined, parent: TraceParent): void {
      if (!parent.turnId) return;
      remember(nodeParents, node, parent);
      if (parentNode && !nodeTurns.has(parentNode)) remember(nodeTurns, parentNode, parent);
    },
    liveTurnOf(threadId: string): string | undefined {
      return live.get(threadId)?.turnId;
    },
  };
}
