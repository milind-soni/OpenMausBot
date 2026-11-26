// The bot that handed work on can stop it, as the person's Stop does: its running turn is interrupted, a command still
// running included, and everything it handed on ends. Handed-off work that shows nothing for a while is reported to that
// bot, which may stop it; the runtime stops it itself at its limit (runtime Limits.handoffQuietMaxMs).
//
// Privacy: these lines land in the requester's conversation, which may be a room. Where the work's result would be
// withheld from it (access changed, or the work stays in one person's private chat), they name no title, command or
// link: only who, how long and how to stop.
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { composeQuiet } from "../runtime/envelope.ts";
import type { Store } from "../store.ts";

export interface HandoffStopDeps {
  coordinator: Pick<Coordinator, "node" | "stopHandoff">;
  store: Pick<Store, "bot" | "appendMessage" | "taskByThread">;
  /** The rule that withholds a hand-off's result from its requester's conversation; true keeps the work's details out. */
  withheld(node: HandoffView, parent: HandoffView): boolean;
}

export interface StopRequest {
  senderId: string;
  senderName: string;
  senderThreadId: string;
  /** The assignment id, from the coordinate_bots receipt. */
  id: string;
  why: string;
}

/** coordinate_bots with stop: only the bot that handed the work on, from the conversation it handed it from, stops it. */
export function stopHandedOn(deps: HandoffStopDeps, input: StopRequest): { status: number; body: Record<string, unknown> } {
  const node = deps.coordinator.node(input.id);
  const parent = node?.parentId ? deps.coordinator.node(node.parentId) : undefined;
  if (!node || !parent) {
    return { status: 404, body: { error: `No work handed on as "${input.id}": stop takes the requestId of your coordinate_bots receipt, e.g. stop "${input.id.slice(0, 8) || "a1b2c3d4"}-…".` } };
  }
  if (parent.botId !== input.senderId || parent.threadId !== input.senderThreadId) {
    return { status: 403, body: { error: `Only the bot that handed "${input.id}" on can stop it, from the conversation it handed it from. To change that work, tell whoever handed it on.` } };
  }
  const assignee = deps.store.bot(node.botId)?.name ?? "Teammate";
  const outcome = deps.coordinator.stopHandoff(input.id, { requester: input.senderName, ...(input.why.trim() ? { why: input.why.trim() } : {}) });
  if (outcome !== "stopped") {
    return { status: 409, body: { error: `${assignee}'s work "${input.id}" already ended (${node.status}): nothing to stop. Its result came back to you, or comes back now.` } };
  }
  deps.store.appendMessage(input.senderThreadId, { role: "bot", kind: "activity", from: senderFrom(deps, input.senderId),
    tool: { name: `Stopped ${assignee}'s work`, ok: true, output: input.why.slice(0, 400) }, ...workRef(deps, node, parent, assignee) });
  return { status: 200, body: { stopped: true, requestId: input.id, botId: node.botId, botName: assignee,
    detail: `${assignee}'s turn on it was interrupted now, a running command included, and what it handed on ended too. It closes as stopped by you, and that result resumes you; do not wait for anything else from it.` } };
}

/** A link to the work, titled, only where its result would reach this conversation. */
function workRef(deps: Pick<HandoffStopDeps, "store" | "withheld">, node: HandoffView, parent: HandoffView, fallback: string): { threadRef?: { botId: string; threadId: string; title: string } } {
  if (deps.withheld(node, parent)) return {};
  return { threadRef: { botId: node.botId, threadId: node.threadId, title: deps.store.taskByThread(node.botId, node.threadId)?.title ?? fallback } };
}

/** The link on the result row a requester's conversation gets when handed-off work ends (done, stopped or stalled): under the
 * same rule as the stop and quiet lines, a room reading one person's private work gets no title or link. */
export const handoffResultRef = (deps: Pick<HandoffStopDeps, "store" | "withheld">, child: HandoffView, parent: HandoffView) => workRef(deps, child, parent, "Teammate work");

function senderFrom(deps: HandoffStopDeps, botId: string): { botId: string; name: string; color: string } | undefined {
  const bot = deps.store.bot(botId);
  return bot ? { botId: bot.id, name: bot.name, color: bot.color } : undefined;
}

export interface QuietNoticeDeps extends HandoffStopDeps {
  /** The running shell command of the turn in `threadId`, scrubbed, with its minutes; null when none. */
  command(threadId: string): { command: string; minutes: number } | null;
  /** Hands `text` to the turn running in `threadId`, read at its next step; false when it cannot take it now. */
  steer(threadId: string, text: string): Promise<boolean>;
}

/** Handed-off `node` has been quiet for `quietMs`: its requester's conversation shows it, and the requester's turn, when one
 * runs, reads the note with how to stop it. */
export function noticeQuiet(deps: QuietNoticeDeps, node: HandoffView, parent: HandoffView | undefined, quietMs: number, closesInMs: number): void {
  if (!parent) return;
  const assignee = deps.store.bot(node.botId)?.name ?? "Teammate";
  const minutes = Math.max(1, Math.floor(quietMs / 60_000)), closesIn = Math.max(1, Math.ceil(closesInMs / 60_000));
  const command = deps.withheld(node, parent) ? null : deps.command(node.threadId);
  deps.store.appendMessage(parent.threadId, { role: "bot", kind: "activity", from: senderFrom(deps, node.botId),
    tool: { name: `${assignee} has shown no progress for ${minutes} min`, ok: true,
      output: `${command ? `Still running: ${command.command.slice(0, 300)} (${command.minutes} min). ` : ""}It is stopped in ${closesIn} min if nothing moves.` },
    ...workRef(deps, node, parent, assignee) });
  if (parent.status === "running") void deps.steer(parent.threadId, composeQuiet(node.id, assignee, minutes, closesIn, command)).catch(() => false);
}
