// Answers the trace routes: the period's roots with totals, and one root's span tree, limited to the threads a viewer may see.
import type { TraceDetail, TraceList, TraceRootSummary } from "../../shared/usage-trace.ts";
import type { WireMessage } from "../../shared/wire.ts";
import { ledgerRows } from "./ledger.ts";
import { addTotals, emptyTotals, linkTurns, summarizeRoot, subtree, traceTurn, type LiveBot, type TurnNode } from "./build.ts";
import type { TraceRecorder } from "./recorder.ts";
import { daysBetween, readSpans } from "./spans.ts";

export interface TraceServiceDeps {
  dataDir: string;
  recorder: Pick<TraceRecorder, "liveTurns">;
  liveBot(threadId: string): LiveBot | null;
  messages(threadId: string): readonly Pick<WireMessage, "id" | "role" | "kind" | "text" | "turnId" | "requestMessageId" | "at">[];
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60_000;
const TITLE_MAX = 140;
/** A child or a resumed turn can land days after the turn it belongs to. */
const LINK_SLACK_MS = 3 * DAY_MS;
export const PAGE_MAX = 100;

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
};

export function createTraceService(deps: TraceServiceDeps) {
  const now = deps.now ?? Date.now;

  function titleOf(root: TurnNode): string {
    if (root.trigger?.kind === "routine") return root.trigger.label ?? root.trigger.routineId ?? "";
    const messages = deps.messages(root.threadId);
    const request = root.turnId ? messages.find((message) => message.turnId === root.turnId && message.requestMessageId)?.requestMessageId : undefined;
    const asked = request ? messages.find((message) => message.id === request)
      : messages.findLast((message) => message.role === "user" && message.kind === "text" && message.at <= root.startedAt + 1_000);
    return asked?.text ? clip(asked.text) : "";
  }

  /** Visible roots, newest first, each limited to the turns in threads the viewer may see. */
  async function roots(from: number, to: number, visible: (threadId: string) => boolean): Promise<TurnNode[]> {
    const rows = await ledgerRows(deps.dataDir, from - LINK_SLACK_MS, to + LINK_SLACK_MS);
    const prune = (node: TurnNode) => { node.children = node.children.filter((child) => visible(child.threadId)); node.children.forEach(prune); };
    return linkTurns(rows, deps.recorder.liveTurns(), deps.liveBot)
      .filter((root) => root.startedAt >= from && root.startedAt <= to && visible(root.threadId))
      .map((root) => { prune(root); return root; })
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async function list(range: { from: Date; to: Date }, page: { offset: number; limit: number }, visible: (threadId: string) => boolean): Promise<TraceList> {
    const found = await roots(range.from.getTime(), range.to.getTime(), visible);
    const totals = emptyTotals();
    const at = now();
    const summaries: TraceRootSummary[] = [];
    found.forEach((root, index) => {
      const inPage = index >= page.offset && index < page.offset + page.limit;
      const summary = summarizeRoot(root, inPage ? titleOf(root) : "", at);
      addTotals(totals, summary);
      if (inPage) summaries.push(summary);
    });
    const next = page.offset + page.limit;
    return { from: range.from.toISOString(), to: range.to.toISOString(), totals, roots: summaries, ...(next < found.length ? { next } : {}) };
  }

  /** The tree of the root holding `id`, which names a root or any turn under one; `around` is when it ran. */
  async function detail(id: string, around: number | null, visible: (threadId: string) => boolean): Promise<TraceDetail | null> {
    const at = now();
    const center = around ?? at;
    const found = await roots(center - LINK_SLACK_MS, Math.min(at, center + DAY_MS), visible);
    const key = id.startsWith("row~") ? `row:${decodeURIComponent(id.slice(4))}` : id.split("~").map(decodeURIComponent).join(":");
    const root = found.find((candidate) => subtree(candidate).some((node) => node.key === key));
    if (!root) return null;
    const nodes = subtree(root);
    const end = Math.max(...nodes.map((node) => node.running ? at : node.endedAt ?? node.startedAt));
    const spans = await readSpans(deps.dataDir, daysBetween(Math.min(...nodes.map((node) => node.startedAt)), end),
      new Set(nodes.filter((node) => node.turnId && !node.liveSpans).map((node) => node.key)));
    return { root: summarizeRoot(root, titleOf(root), at), turns: [traceTurn(root, spans)] };
  }

  return { list, detail };
}

export type TraceService = ReturnType<typeof createTraceService>;
