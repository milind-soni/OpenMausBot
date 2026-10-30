// A bot doing work another bot handed it asks the person with a card in its own conversation: one it asks with its
// question tool, or the one a NEEDS INPUT line leaves. The person answers it there, by tap or in words, or from the copy
// in their inbox; the conversation that handed the work on hears that it waits, unless that conversation is the
// person's inbox, which has the card itself.
import { formatQuestionAnswers } from "../../shared/ask-question.ts";
import { liveCardKind } from "../../shared/live-approval.ts";
import { allowsTool, type ToolIdentity } from "../../shared/tool-scope.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { HandoffView } from "../coordinator.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { RequestAuth } from "../request-auth.ts";
import { isStopCommand } from "../room-holds.ts";
import { needsInputQuestion } from "../runtime-coordinator.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { settledWaitingChip } from "../waiting-on-person.ts";

const OPEN_QUESTION = "needs-input-";
const NEEDS_INPUT_LINE = /^needs input:/i;

export interface AskCardsDeps {
  store: Pick<Store, "bot" | "messagesFor" | "activePath" | "appendMessage" | "patchMessage" | "taskByThread" | "patchTask" | "group"
    | "groupTaskByThread" | "patchGroup" | "groupByThread">;
  node(id: string): HandoffView | undefined;
  /** The conversation that handed this one its work, while that work is live. */
  delegatorOf(threadId: string): { threadId: string; botId?: string } | undefined;
  notify(notification: Notification | null): void;
  /** On a Team Cloud: what `botId` asks in `threadId` reaches the inbox conversation `inboxThreadId` as a copy. */
  copiedInto(inboxThreadId: string, botId: string, threadId: string): boolean;
  /** The bot's turn in `threadId` waits on this card's live request. */
  live(threadId: string, requestId: string): boolean;
  /** Answers a card as a tap on it would, with the same checks on who may answer, through an inbox copy too. */
  answerCard(input: { auth: RequestAuth; threadId: string; requestId: string; behavior: "answer"; message: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** The conversation a card in `threadId` was asked in: an inbox copy's original. */
  answeredIn(threadId: string, requestId: string): string;
}

/** The name a bot's model knows its question tool by: its engine's, unless the bot's tool selection leaves it out. */
export function askToolName(bot: Pick<BotRecord, "modelSelection" | "toolScope"> | null, askToolOf: (instanceId: string) => ToolIdentity | undefined): string | undefined {
  const tool = bot ? askToolOf(bot.modelSelection.instanceId) : undefined;
  return bot && tool && allowsTool(bot.toolScope, tool) ? tool.name : undefined;
}

/** A question one line of words answers: one question, picked once. */
function answerableInWords(card: OptionCardData | undefined): card is OptionCardData & { requestId: string } {
  if (liveCardKind(card) !== "question" || card!.fixedOptions) return false;
  const questions = card!.questionRequest?.questions;
  return !questions || (questions.length === 1 && !questions[0]!.multiSelect && questions[0]!.custom !== false);
}

const typedAnswer = (card: OptionCardData, text: string): string => {
  const questions = card.questionRequest?.questions;
  return questions ? formatQuestionAnswers(questions, [[text]]) : text;
};

/** The reply up to its NEEDS INPUT line; empty when the line is the whole reply. */
function beforeQuestion(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(0, Math.max(0, lines.findLastIndex((line) => NEEDS_INPUT_LINE.test(line.trim())))).join("\n").trim();
}

export function createAskCards(deps: AskCardsDeps) {
  const { store, delegatorOf, notify } = deps;
  const waitingOnPersonChips = new Map<string, { threadId: string; messageId: string; name: string; kind: string }>();

  function showWaitingOnPersonChip(threadId: string, requestId: string, asker: BotRecord, kind: "approval" | "answer") {
    const delegator = delegatorOf(threadId);
    if (!delegator || delegator.threadId === threadId || deps.copiedInto(delegator.threadId, asker.id, threadId)) return;
    const chip = store.appendMessage(delegator.threadId, { role: "bot", kind: "activity",
      from: { botId: asker.id, name: asker.name, color: asker.color },
      tool: { name: `Waiting on your ${kind} in @${asker.name}` },
      threadRef: { botId: asker.id, threadId, title: store.taskByThread(asker.id, threadId)?.title ?? asker.name },
    });
    waitingOnPersonChips.set(`${threadId}:${requestId}`, { threadId: delegator.threadId, messageId: chip.id, name: asker.name, kind });
  }

  function settleWaitingOnPersonChips(threadId: string, resolved?: Extract<RuntimeEvent, { type: "request.resolved" }>) {
    for (const [key, chip] of waitingOnPersonChips) {
      if (resolved ? key !== `${threadId}:${resolved.requestId}` : !key.startsWith(`${threadId}:`)) continue;
      waitingOnPersonChips.delete(key);
      const existing = store.messagesFor(chip.threadId).find((message) => message.id === chip.messageId);
      if (!existing?.tool) continue;
      store.patchMessage(chip.threadId, chip.messageId, {
        tool: { ...existing.tool, ...settledWaitingChip(chip.name, chip.kind, resolved?.behavior ?? "deny", resolved?.source ?? "system") },
      });
    }
  }

  function newestQuestionChip(threadId: string, aboutThreadId: string): string | undefined {
    return store.activePath(threadId).findLast((message) =>
      message.kind === "activity" && (message.threadRef?.threadId ?? message.comm?.threadId) === aboutThreadId
      && message.tool?.name.includes(" needs your input: ") === true)?.tool?.name;
  }

  /** The card a parked teammate's NEEDS INPUT line asks with, in place of that line; false when it was there already. */
  function openQuestionCard(node: HandoffView, question: string): boolean {
    const requestId = `${OPEN_QUESTION}${node.id}-${node.executions}`;
    const rows = store.messagesFor(node.threadId);
    if (rows.some((message) => message.card?.requestId === requestId)) return false;
    const card: OptionCardData = { title: "Your bot has a question", subtitle: question, options: [], requestId, requestType: "question" };
    const since = node.startedAt ?? node.createdAt;
    const asking = rows.findLast((message) => message.role === "bot" && message.kind === "text" && message.at >= since
      && needsInputQuestion(message.text ?? "") !== undefined);
    const before = asking ? beforeQuestion(asking.text!) : "";
    if (asking && !before) {
      store.patchMessage(node.threadId, asking.id, { kind: "options", text: question, card });
      return true;
    }
    if (asking) store.patchMessage(node.threadId, asking.id, { text: before });
    store.appendMessage(node.threadId, { role: "bot", kind: "options", text: question, card });
    return true;
  }

  function park(node: HandoffView, question: string, restored?: boolean) {
    if (!node.parentId && node.cards?.length) return;
    const bot = store.bot(node.botId);
    if (!bot) return;
    const parent = node.parentId ? deps.node(node.parentId) : undefined;
    const title = store.taskByThread(bot.id, node.threadId)?.title ?? "Teammate work";
    const chip = `${bot.name} needs your input: ${question.slice(0, 180)}`;
    const group = parent?.groupId ? store.group(parent.groupId) : undefined;
    let liveParent: HandoffView | undefined;
    if (parent?.groupId) liveParent = group && store.groupTaskByThread(group.id, parent.threadId) ? parent : undefined;
    else if (parent) liveParent = store.taskByThread(parent.botId, parent.threadId) ? parent : undefined;
    const asksWithCard = Boolean(node.parentId && !node.groupId && !node.cards?.length);
    const posted = asksWithCard && openQuestionCard(node, question);
    if (restored && (asksWithCard ? !posted : !liveParent || newestQuestionChip(liveParent.threadId, node.threadId) === chip)) return;
    if (liveParent && !(asksWithCard && deps.copiedInto(liveParent.threadId, bot.id, node.threadId))) {
      store.appendMessage(liveParent.threadId, {
        role: "bot", kind: "activity",
        from: { botId: bot.id, name: bot.name, color: bot.color },
        tool: { name: chip, ok: true },
        ...(node.groupId ? { comm: { groupId: node.groupId, threadId: node.threadId, withBotId: bot.id, withName: bot.name, withColor: bot.color } }
          : { threadRef: { botId: bot.id, threadId: node.threadId, title } }),
      });
      if (group) store.patchGroup(group.id, { unread: true });
      else store.patchTask(liveParent.botId, liveParent.threadId, { unread: true });
    }
    if (node.groupId) store.patchGroup(node.groupId, { unread: true });
    else store.patchTask(bot.id, node.threadId, { unread: true });
    notify(buildNotification(asksWithCard ? "question" : "delegation-settled", bot, node.threadId, question, { avatarUrl: bot.avatarUrl }));
  }

  const openQuestionIn = (threadId: string): Message | undefined => store.messagesFor(threadId).findLast((message) =>
    message.card?.requestId?.startsWith(OPEN_QUESTION) === true && answerableInWords(message.card));

  /** The person's own words answered the teammate parked in this conversation: its card says what they answered. */
  function answeredInWords(threadId: string, text: string): void {
    const asked = openQuestionIn(threadId);
    if (asked?.card) store.patchMessage(threadId, asked.id, { card: { ...asked.card, answered: "answer", answeredText: text } });
  }

  /** A parked teammate's work ended without the person's answer: its card says why it no longer asks. */
  function closed(node: HandoffView): void {
    if (node.status === "completed" || node.groupId) return;
    for (const message of store.messagesFor(node.threadId)) {
      const card = message.card;
      if (!card?.requestId?.startsWith(`${OPEN_QUESTION}${node.id}-`) || !answerableInWords(card)) continue;
      store.patchMessage(node.threadId, message.id, { card: node.outcome === "expired" ? { ...card, expired: true }
        : { ...card, answered: "unavailable", dismissed: true, ...(node.outcome === "stopped" ? { stopped: true } : {}) } });
    }
  }

  /** A person's line answers an inbox copy it replies to, or, in work a teammate handed on, the question card the bot's
   * turn waits on, as a tap would; null leaves the line to be sent (steered or queued) as usual. */
  async function typed(auth: RequestAuth, threadId: string, text: string, target: Message | undefined,
    line: { sendId?: string; sender?: Message["sender"] }): Promise<{ status: number; message?: Message; error?: string } | null> {
    if (store.groupByThread(threadId) || isStopCommand(text)) return null;
    const delegator = delegatorOf(threadId);
    const handedOn = Boolean(delegator && delegator.threadId !== threadId);
    const asked = target
      ? answerableInWords(target.card) ? target : undefined
      : handedOn ? store.messagesFor(threadId).findLast((message) => answerableInWords(message.card) && deps.live(threadId, message.card!.requestId!)) : undefined;
    if (!asked?.card?.requestId) return null;
    const requestId = asked.card.requestId;
    const origin = deps.answeredIn(threadId, requestId);
    if (origin === threadId && !(handedOn && deps.live(threadId, requestId))) return null;
    const again = line.sendId ? store.messagesFor(threadId).find((message) => message.sendId === line.sendId) : undefined;
    if (again) return { status: 202, message: again };
    const answered = await deps.answerCard({ auth, threadId, requestId, behavior: "answer", message: typedAnswer(asked.card, text) });
    if (!answered.ok) return { status: answered.status, error: answered.error };
    const posted = store.appendMessage(threadId, { role: "user", kind: "text", text, replyToId: asked.id,
      ...(line.sendId ? { sendId: line.sendId } : {}), ...(line.sender ? { sender: line.sender } : {}) });
    return { status: 202, message: posted };
  }

  return { park, closed, answeredInWords, typed, showWaitingOnPersonChip, settleWaitingOnPersonChips };
}
