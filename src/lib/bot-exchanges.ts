// The bots' exchanges under the person's latest request, read from the conversation's job.
type Status = "queued" | "running" | "needs_input" | "waiting" | "resume" | "completed" | "failed" | "cancelled";

/** The fields of `GET /api/threads/:id/job` the line reads. */
export interface JobNodeRead {
  id: string;
  parentId?: string;
  botId: string;
  botName: string;
  threadId: string;
  groupId?: string;
  status: Status;
  outcome?: string;
  reply: "required" | "optional" | "none";
  createdAt: number;
  finishedAt?: number;
}

export interface JobRead {
  since: number;
  version: string;
  nodes: JobNodeRead[];
  needsInput: Array<{ id: string }>;
}

export type ExchangeState = "asking" | "working" | "needs-you" | "answered" | "stopped" | "expired" | "failed";

export interface BotExchangeEntry {
  /** The hand-off's assignment: what Stop names. */
  id: string;
  /** No bot id: the asker works in a conversation the reader may not open. */
  asker: { botId?: string; name: string };
  helper: { botId: string; name: string };
  threadId: string;
  state: ExchangeState;
  createdAt: number;
  finishedAt?: number;
}

export const exchangeEnded = (state: ExchangeState): boolean =>
  state === "answered" || state === "stopped" || state === "expired" || state === "failed";

export function exchangeState(node: Pick<JobNodeRead, "status" | "outcome">, needsYou: boolean): ExchangeState {
  switch (node.status) {
    case "queued": return "asking";
    case "needs_input": return "needs-you";
    case "running": return needsYou ? "needs-you" : "working";
    case "waiting":
    case "resume": return "working";
    case "completed": return "answered";
    case "failed":
    case "cancelled": return node.outcome === "expired" ? "expired" : node.outcome === "stopped" ? "stopped" : "failed";
  }
}

/** One per hand-off from one bot to another; a bot's own threads and room work are not exchanges. Open ones first. */
export function exchangesOf(job: JobRead, teammate: string): BotExchangeEntry[] {
  const byId = new Map(job.nodes.map((node) => [node.id, node]));
  const needsYou = new Set(job.needsInput.map((row) => row.id));
  const entries: BotExchangeEntry[] = [];
  for (const node of job.nodes) {
    if (!node.parentId || node.groupId) continue;
    const parent = byId.get(node.parentId);
    if (parent?.botId === node.botId) continue;
    const state = exchangeState(node, needsYou.has(node.id));
    entries.push({
      id: node.id,
      asker: parent ? { botId: parent.botId, name: parent.botName } : { name: teammate },
      helper: { botId: node.botId, name: node.botName },
      threadId: node.threadId,
      state,
      createdAt: node.createdAt,
      ...(node.finishedAt !== undefined ? { finishedAt: node.finishedAt } : {}),
    });
  }
  const open = (entry: BotExchangeEntry) => Number(!exchangeEnded(entry.state));
  return entries.sort((a, b) => open(b) - open(a) || a.createdAt - b.createdAt);
}

/** A helper-thread line, as far as tying it to one hand-off goes. */
type Line = { id: string; role: string; at: number; steered?: boolean; roomRequest?: { id: string; phase: "request" | "result" } };

/** An exchange's lines in the helper's thread, which can hold several: `waiting`, its turn has not started, so no line
 * is its own yet; `unknown`, its request line is not in the thread, so no line can be tied to it. */
export type ExchangeLines = { kind: "lines"; ids: ReadonlySet<string> } | { kind: "waiting" } | { kind: "unknown" };

/** The server writes one request line per hand-off when its turn starts (`roomRequest.id` is the assignment) and runs
 * one turn per thread at a time, so the hand-off's lines run from that line to the next turn's start. A line handed
 * into the running turn (`steered`) is part of it. */
export function exchangeLines(path: readonly Line[], exchange: Pick<BotExchangeEntry, "id" | "state" | "finishedAt">): ExchangeLines {
  const start = path.findIndex((line) => line.roomRequest?.phase === "request" && line.roomRequest.id === exchange.id);
  if (start < 0) return exchange.state === "asking" ? { kind: "waiting" } : { kind: "unknown" };
  const ids = new Set([path[start]!.id]);
  for (const line of path.slice(start + 1)) {
    if (line.roomRequest?.phase === "request" || (line.role === "user" && !line.steered)) break;
    if (exchange.finishedAt !== undefined && line.at > exchange.finishedAt) break;
    ids.add(line.id);
  }
  return { kind: "lines", ids };
}
