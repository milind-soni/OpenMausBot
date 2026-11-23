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
  /** Still working on an answer someone waits for. */
  live: boolean;
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
      live: !exchangeEnded(state) && node.reply !== "none",
      createdAt: node.createdAt,
      ...(node.finishedAt !== undefined ? { finishedAt: node.finishedAt } : {}),
    });
  }
  return entries.sort((a, b) => Number(b.live) - Number(a.live) || a.createdAt - b.createdAt);
}

/** The asker's request can be stamped a moment before the hand-off's record in the helper's thread. */
const REQUEST_LEAD_MS = 1_000;

/** Where one exchange sits in the helper's thread, which can hold several. */
export interface ExchangeWindow { from: number; to?: number }

export const exchangeWindow = (entry: Pick<BotExchangeEntry, "createdAt" | "finishedAt">): ExchangeWindow =>
  ({ from: entry.createdAt - REQUEST_LEAD_MS, ...(entry.finishedAt !== undefined ? { to: entry.finishedAt } : {}) });

export const inWindow = (at: number, window: ExchangeWindow): boolean =>
  at >= window.from && (window.to === undefined || at <= window.to);
