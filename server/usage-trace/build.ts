// Builds trace roots and span trees from usage rows, their span lines and the turns still running. Pure: the routes read.
import {
  traceRootId, traceToolLook, type TraceGroup, type TraceNode, type TraceParent, type TraceRootSummary, type TraceSource,
  type TraceStatus, type TraceStep, type TraceTokens, type TraceTool, type TraceTotals, type TraceTurn, type TraceUsageStatus,
} from "../../shared/usage-trace.ts";
import { usageRowKey, type UsageRow, type UsageTrigger } from "../usage-ledger.ts";
import type { LiveTurnView } from "./recorder.ts";
import type { SpanRecord, StepSpan, ToolSpan } from "./spans.ts";

export interface TurnNode {
  key: string;
  threadId: string;
  turnId?: string;
  botId: string;
  botName: string;
  model: string;
  driverKind: string;
  startedAt: number;
  endedAt?: number;
  timed: boolean;
  running: boolean;
  status: TraceStatus;
  reason?: string;
  costUsd: number | null;
  costSource?: "reported" | "estimated";
  tokens: TraceTokens;
  usageStatus: TraceUsageStatus;
  contextTokens?: number;
  contextWindow?: number;
  steps: number;
  tools: number;
  toolErrors: number;
  parent?: TraceParent;
  trigger?: UsageTrigger;
  children: TurnNode[];
  /** Spans of a turn that has not been booked yet. */
  liveSpans?: Array<SpanRecord & { running?: boolean }>;
}

export interface LiveBot {
  botId: string;
  botName: string;
  model: string;
  driverKind: string;
}

/** Consecutive uses of one kind of tool fold into a group once there are this many. */
export const GROUP_MIN = 3;

const turnKey = (threadId: string, turnId: string) => `${threadId}:${turnId}`;
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const parseTime = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

function rowStatus(row: UsageRow): TraceUsageStatus {
  if (row.usageStatus) return row.usageStatus;
  if (!row.input && !row.output) return "unavailable";
  return typeof row.cachedInput === "number" ? "complete" : "partial";
}

function nodeFromRow(row: UsageRow): TurnNode {
  const at = Date.parse(row.at);
  const startedAt = parseTime(row.startedAt);
  return {
    key: row.turnId ? turnKey(row.threadId, row.turnId) : `row:${usageRowKey(row)}`,
    threadId: row.threadId,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    botId: row.botId,
    botName: row.botName || row.botId,
    model: row.model,
    driverKind: row.driverKind,
    startedAt: startedAt ?? at,
    endedAt: parseTime(row.endedAt) ?? at,
    timed: startedAt !== undefined,
    running: false,
    status: row.outcome?.status ?? "ok",
    ...(row.outcome?.reason ? { reason: row.outcome.reason } : {}),
    costUsd: finite(row.costUsd) ? row.costUsd : null,
    ...(row.costSource ? { costSource: row.costSource } : {}),
    tokens: {
      input: row.input, cachedInput: row.cachedInput ?? 0, output: row.output,
      ...(finite(row.cacheWrite) ? { cacheWrite: row.cacheWrite } : {}),
      ...(finite(row.reasoning) ? { reasoning: row.reasoning } : {}),
    },
    usageStatus: rowStatus(row),
    ...(finite(row.contextTokens) ? { contextTokens: row.contextTokens } : {}),
    ...(finite(row.contextWindow) ? { contextWindow: row.contextWindow } : {}),
    steps: row.steps ?? 1,
    tools: row.tools ?? 0,
    toolErrors: row.toolErrors ?? 0,
    ...(row.parent ? { parent: row.parent } : {}),
    trigger: row.trigger,
    children: [],
  };
}

function mergeRow(into: TurnNode, row: UsageRow): void {
  const other = nodeFromRow(row);
  into.costUsd = into.costUsd === null && other.costUsd === null ? null : (into.costUsd ?? 0) + (other.costUsd ?? 0);
  into.tokens.input += other.tokens.input;
  into.tokens.cachedInput += other.tokens.cachedInput;
  into.tokens.output += other.tokens.output;
  into.endedAt = Math.max(into.endedAt ?? 0, other.endedAt ?? 0);
}

function nodeFromLive(turn: LiveTurnView, bot: LiveBot | null): TurnNode {
  const steps = turn.spans.filter((span): span is StepSpan => span.kind === "step");
  const tools = turn.spans.filter((span): span is ToolSpan => span.kind === "tool");
  const tokens: TraceTokens = { input: 0, cachedInput: 0, output: 0 };
  for (const step of steps) {
    tokens.input += step.tokens?.input ?? 0;
    tokens.cachedInput += step.tokens?.cachedInput ?? 0;
    tokens.output += step.tokens?.output ?? 0;
  }
  return {
    key: turnKey(turn.threadId, turn.turnId),
    threadId: turn.threadId,
    turnId: turn.turnId,
    botId: bot?.botId ?? "",
    botName: bot?.botName ?? "",
    model: bot?.model ?? "",
    driverKind: bot?.driverKind ?? turn.provider,
    startedAt: turn.startedAt,
    ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
    timed: true,
    running: turn.endedAt === undefined,
    status: turn.status ?? "ok",
    costUsd: null,
    tokens,
    usageStatus: tokens.input || tokens.output ? "partial" : "unavailable",
    steps: steps.length,
    tools: tools.length,
    toolErrors: tools.filter((tool) => tool.status === "error").length,
    ...(turn.parent ? { parent: turn.parent } : {}),
    children: [],
    liveSpans: turn.spans,
  };
}

/** Every turn as a node, linked under its parent when the parent is among them. Returns the roots. */
export function linkTurns(rows: readonly UsageRow[], live: readonly LiveTurnView[], liveBot: (threadId: string) => LiveBot | null): TurnNode[] {
  const nodes = new Map<string, TurnNode>();
  for (const row of rows) {
    const node = nodeFromRow(row);
    const existing = nodes.get(node.key);
    if (existing) mergeRow(existing, row);
    else nodes.set(node.key, node);
  }
  for (const turn of live) {
    const key = turnKey(turn.threadId, turn.turnId);
    if (!nodes.has(key)) nodes.set(key, nodeFromLive(turn, liveBot(turn.threadId)));
  }
  const parentOf = (node: TurnNode) => node.parent ? nodes.get(turnKey(node.parent.threadId, node.parent.turnId)) : undefined;
  const loops = (node: TurnNode) => {
    for (let ancestor = parentOf(node), hops = 0; ancestor; ancestor = parentOf(ancestor), hops += 1) {
      if (ancestor === node || hops > nodes.size) return true;
    }
    return false;
  };
  const roots: TurnNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node);
    if (parent && !loops(node)) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.startedAt - b.startedAt);
  return roots;
}

export function subtree(root: TurnNode): TurnNode[] {
  const out: TurnNode[] = [];
  const visit = (node: TurnNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

const SOURCES: Record<UsageTrigger["kind"], TraceSource> = { user: "person", owner: "owner", routine: "routine", bot: "bot", helper: "helper" };

export function rootIdOf(node: TurnNode): string {
  return node.turnId ? traceRootId(node.threadId, node.turnId) : `row~${encodeURIComponent(node.key.slice(4))}`;
}

export function emptyTotals(): TraceTotals {
  return { durationMs: 0, costUsd: null, tokens: 0, input: 0, cachedInput: 0, output: 0, steps: 0, tools: 0, errors: 0 };
}

export function addTotals(into: TraceTotals, add: TraceTotals): void {
  into.durationMs += add.durationMs;
  if (add.costUsd !== null) into.costUsd = (into.costUsd ?? 0) + add.costUsd;
  into.tokens += add.tokens;
  into.input += add.input;
  into.cachedInput += add.cachedInput;
  into.output += add.output;
  into.steps += add.steps;
  into.tools += add.tools;
  into.errors += add.errors;
}

export function summarizeRoot(root: TurnNode, title: string, now: number): TraceRootSummary {
  const nodes = subtree(root);
  const timed = nodes.filter((node) => node.timed);
  const startedAt = Math.min(...nodes.map((node) => node.startedAt));
  const endOf = (node: TurnNode) => node.running ? now : node.endedAt ?? node.startedAt;
  const endedAt = Math.max(...nodes.map(endOf));
  const totals = emptyTotals();
  for (const node of nodes) {
    if (node.costUsd !== null) totals.costUsd = (totals.costUsd ?? 0) + node.costUsd;
    totals.input += node.tokens.input;
    totals.cachedInput += node.tokens.cachedInput;
    totals.output += node.tokens.output;
    totals.steps += node.steps;
    totals.tools += node.tools;
    totals.errors += node.toolErrors + (node.status === "error" ? 1 : 0);
  }
  totals.tokens = totals.input + totals.output;
  totals.durationMs = timed.length ? Math.max(...timed.map(endOf)) - Math.min(...timed.map((node) => node.startedAt)) : 0;
  const statuses = new Set(nodes.map((node) => node.usageStatus));
  const bots = new Map<string, string>();
  for (const node of nodes) if (node.botId && !bots.has(node.botId)) bots.set(node.botId, node.botName);
  return {
    id: rootIdOf(root),
    title,
    source: root.trigger ? SOURCES[root.trigger.kind] : "owner",
    startedAt,
    endedAt,
    running: nodes.some((node) => node.running),
    timed: root.timed,
    bots: [...bots].map(([id, name]) => ({ id, name })),
    usageStatus: statuses.size === 1 ? [...statuses][0]! : statuses.has("unavailable") || statuses.has("partial") ? "partial" : "complete",
    ...totals,
  };
}

const stepWeight = (tokens: TraceTokens) =>
  Math.max(0, tokens.input - tokens.cachedInput - (tokens.cacheWrite ?? 0)) + 0.1 * tokens.cachedInput + 1.25 * (tokens.cacheWrite ?? 0) + 5 * tokens.output;

function stepsOf(node: TurnNode, spans: readonly (SpanRecord & { running?: boolean })[]): TraceStep[] {
  const recorded = spans.filter((span): span is StepSpan & { running?: boolean } => span.kind === "step");
  const steps: TraceStep[] = recorded.length
    ? recorded.map((span) => ({
      kind: "step", id: span.id, startedAt: span.startedAt,
      ...(span.endedAt !== undefined ? { endedAt: span.endedAt } : {}),
      ...(span.tokens ? { tokens: span.tokens } : {}),
      ...(span.contextTokens !== undefined ? { contextTokens: span.contextTokens } : {}),
      ...(span.contextWindow !== undefined ? { contextWindow: span.contextWindow } : {}),
      ...(span.running ? { running: true } : {}),
    }))
    : node.timed && !node.running
      ? [{ kind: "step", id: `${node.key}:step`, startedAt: node.startedAt, ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}), tokens: node.tokens }]
      : [];
  if (node.costUsd === null || !steps.length) return steps;
  const byTokens = steps.every((step) => step.tokens);
  const weights = steps.map((step) => byTokens ? stepWeight(step.tokens!) : Math.max(1, (step.endedAt ?? step.startedAt) - step.startedAt));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  steps.forEach((step, index) => { step.costUsd = total > 0 ? node.costUsd! * weights[index]! / total : node.costUsd! / steps.length; });
  return steps;
}

function toolOf(span: ToolSpan & { running?: boolean }): TraceTool {
  return {
    kind: "tool", id: span.id, name: span.name, ...traceToolLook(span.name),
    ...(span.detail ? { detail: span.detail } : {}),
    startedAt: span.startedAt,
    ...(span.endedAt !== undefined ? { endedAt: span.endedAt } : {}),
    status: span.status,
    ...(span.error ? { error: span.error } : {}),
    timedBy: span.timedBy,
    ...(span.running ? { running: true } : {}),
  };
}

const groupKey = (tool: TraceTool) => `${tool.icon}:${tool.app ?? tool.server ?? (tool.icon === "tool" || tool.icon === "mcp" ? tool.name : "")}`;

/** Folds each run of GROUP_MIN or more same-kind tools, with the AI steps between them, into one group. */
export function groupRuns(items: Array<TraceTool | TraceStep>): Array<TraceTool | TraceStep | TraceGroup> {
  const out: Array<TraceTool | TraceStep | TraceGroup> = [];
  let index = 0;
  while (index < items.length) {
    const first = items[index]!;
    if (first.kind !== "tool") {
      out.push(first);
      index += 1;
      continue;
    }
    const key = groupKey(first);
    let last = index;
    let count = 1;
    for (let probe = index + 1; probe < items.length; probe += 1) {
      const item = items[probe]!;
      if (item.kind === "step") continue;
      if (groupKey(item) !== key) break;
      last = probe;
      count += 1;
    }
    if (count < GROUP_MIN) {
      out.push(first);
      index += 1;
      continue;
    }
    const children = items.slice(index, last + 1);
    const running = children.some((child) => child.running);
    const ends = children.map((child) => child.endedAt ?? child.startedAt);
    out.push({
      kind: "group", id: `group:${first.id}`, icon: first.icon, name: first.name,
      ...(first.app ? { app: first.app } : {}), ...(first.server ? { server: first.server } : {}),
      count, errors: children.filter((child) => child.kind === "tool" && child.status === "error").length,
      startedAt: first.startedAt, ...(running ? { running: true } : { endedAt: Math.max(...ends) }),
      children,
    });
    index = last + 1;
  }
  return out;
}

export function traceTurn(node: TurnNode, spans: ReadonlyMap<string, SpanRecord[]>): TraceTurn {
  const own = node.liveSpans ?? spans.get(node.key) ?? [];
  const tools = own.filter((span): span is ToolSpan & { running?: boolean } => span.kind === "tool").map(toolOf);
  const items = [...stepsOf(node, own), ...tools].sort((a, b) => a.startedAt - b.startedAt || (a.kind === "step" ? -1 : 1));
  const children: TraceNode[] = [...groupRuns(items), ...node.children.map((child) => traceTurn(child, spans))];
  children.sort((a, b) => a.startedAt - b.startedAt);
  return {
    kind: "turn", id: node.key, threadId: node.threadId, ...(node.turnId ? { turnId: node.turnId } : {}),
    botId: node.botId, botName: node.botName, model: node.model, driverKind: node.driverKind,
    startedAt: node.startedAt, ...(node.endedAt !== undefined && !node.running ? { endedAt: node.endedAt } : {}),
    timed: node.timed, ...(node.running ? { running: true } : {}),
    status: node.status, ...(node.reason ? { reason: node.reason } : {}),
    costUsd: node.costUsd, ...(node.costSource ? { costSource: node.costSource } : {}),
    tokens: node.tokens, usageStatus: node.usageStatus,
    ...(node.contextTokens !== undefined ? { contextTokens: node.contextTokens } : {}),
    ...(node.contextWindow !== undefined ? { contextWindow: node.contextWindow } : {}),
    children,
  };
}
