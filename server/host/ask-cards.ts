// A bot asks the person with a card in its own conversation: one it asks with its question tool, or the one a NEEDS
// INPUT line leaves, in work handed on, in a room or in its own chat. The person answers it there, by tap or in words, or
// from the copy in their inbox; the conversation that handed the work on hears that it waits, unless that conversation is
// the person's inbox, which has the card itself. At Full access a teammate's question goes to its requester instead: its
// card says who decides and what was picked, and blocks nothing. A card whose work ended, or that a newer question
// replaced, closes, so nothing stale waits on the person.
import { formatQuestionAnswers, isPersistentQuestionCard } from "../../shared/ask-question.ts";
import { liveCardKind } from "../../shared/live-approval.ts";
import { allowsTool, type ToolIdentity } from "../../shared/tool-scope.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { RuntimeEvent } from "../contracts.ts";
import type { HandoffView } from "../coordinator.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { RequestAuth } from "../request-auth.ts";
import { isStopCommand } from "../room-holds.ts";
import { needsInputQuestion } from "../runtime-coordinator.ts";
import { withDefault } from "../runtime/questions.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { conversationLanguage } from "../server-lines.ts";
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
  /** The parked node's next turn carries the person's answer. */
  answerNode(id: string, text: string): boolean;
  /** Answers a card as a tap on it would, with the same checks on who may answer, through an inbox copy too. */
  answerCard(input: { auth: RequestAuth; threadId: string; requestId: string; behavior: "answer"; message: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** The conversation a card in `threadId` was asked in: an inbox copy's original. */
  answeredIn(threadId: string, requestId: string): string;
}

/** The name a bot's model calls its question tool by: its engine's, unless the bot's tool selection leaves it out. The
 * Claude CLI names a tool of an MCP server `mcp__<server>__<tool>`. */
export function askToolName(bot: Pick<BotRecord, "modelSelection" | "toolScope"> | null, askToolOf: (instanceId: string) => ToolIdentity | undefined): string | undefined {
  const tool = bot ? askToolOf(bot.modelSelection.instanceId) : undefined;
  if (!bot || !tool || !allowsTool(bot.toolScope, tool)) return undefined;
  return tool.kind === "mcp" ? `mcp__${tool.server}__${tool.name}` : tool.name;
}

/** A question one line of words answers: one question, picked once. */
export function answerableInWords(card: OptionCardData | undefined): card is OptionCardData & { requestId: string } {
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

/** A question card's own message, not an inbox copy of one. */
const ownQuestionCard = (message: Message): boolean =>
  Boolean(message.card?.requestId && !message.inbox && !message.card.tool && isPersistentQuestionCard(message.card));

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
        tool: { ...existing.tool, ...settledWaitingChip(chip.name, chip.kind, resolved?.behavior ?? "deny", resolved?.source ?? "system", conversationLanguage(chip.threadId)) },
      });
    }
  }

  /** In a room only the asking member's own lines. */
  const askersLines = (node: Pick<HandoffView, "threadId" | "botId" | "groupId">) => store.messagesFor(node.threadId)
    .filter((message) => !node.groupId || message.from?.botId === node.botId);

  /** The card a parked question asks with, in place of its NEEDS INPUT line; `card` presets its state. False when it was
   * there already. */
  function questionCard(node: HandoffView, question: string, card: Partial<OptionCardData> = {}): boolean {
    const requestId = `${OPEN_QUESTION}${node.id}-${node.executions}`;
    if (store.messagesFor(node.threadId).some((message) => message.card?.requestId === requestId)) return false;
    const asked = withDefault(question);
    const bot = store.bot(node.botId);
    const options = asked.default && !card.answeredBy ? [asked.default] : [];
    const full: OptionCardData = { title: "Your bot has a question", subtitle: asked.question, options, requestId, requestType: "question", ...card };
    const from = node.groupId && bot ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {};
    const since = node.startedAt ?? node.createdAt;
    const asking = askersLines(node).findLast((message) => message.role === "bot" && message.kind === "text" && message.at >= since
      && needsInputQuestion(message.text ?? "") !== undefined);
    const before = asking ? beforeQuestion(asking.text!) : "";
    if (asking && !before) {
      store.patchMessage(node.threadId, asking.id, { kind: "options", text: asked.question, card: full });
      return true;
    }
    if (asking) store.patchMessage(node.threadId, asking.id, { text: before });
    store.appendMessage(node.threadId, { role: "bot", kind: "options", text: asked.question, card: full, ...from });
    return true;
  }

  /** A chip about this parked work is in the conversation that handed it on already. */
  const chipShown = (parentThreadId: string, node: HandoffView, chip: string) => store.activePath(parentThreadId).some((message) =>
    message.kind === "activity" && (message.threadRef?.threadId ?? message.comm?.threadId) === node.threadId && message.tool?.name === chip
    && message.at >= (node.startedAt ?? node.createdAt));

  /** `restored`: a restart parks it again, and nothing already shown is shown twice. */
  function park(node: HandoffView, question: string, restored?: boolean) {
    if (!node.parentId && node.cards?.length) return;
    const bot = store.bot(node.botId);
    if (!bot) return;
    if (node.decide) {
      const parent = node.parentId ? deps.node(node.parentId) : undefined;
      const decider = parent ? store.bot(parent.botId) : undefined;
      questionCard(node, question, { answered: "answer", answeredBy: { kind: "bot", name: decider?.name ?? bot.name } });
      return;
    }
    const parent = node.parentId ? deps.node(node.parentId) : undefined;
    const title = store.taskByThread(bot.id, node.threadId)?.title ?? "Teammate work";
    const chip = `${bot.name} needs your input: ${withDefault(question).question.slice(0, 180)}`;
    const group = parent?.groupId ? store.group(parent.groupId) : undefined;
    let liveParent: HandoffView | undefined;
    if (parent?.groupId) liveParent = group && store.groupTaskByThread(group.id, parent.threadId) ? parent : undefined;
    else if (parent) liveParent = store.taskByThread(parent.botId, parent.threadId) ? parent : undefined;
    const asksWithCard = Boolean(node.parentId && !node.cards?.length);
    const posted = asksWithCard && questionCard(node, question);
    if (restored && (asksWithCard ? !posted : !liveParent || chipShown(liveParent.threadId, node, chip))) return;
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
    const room = node.groupId ? store.group(node.groupId) : undefined;
    notify(buildNotification(asksWithCard ? "question" : "delegation-settled", bot, node.threadId, withDefault(question).question,
      { avatarUrl: bot.avatarUrl, ...(room ? { group: { id: room.id, name: room.name } } : {}) }));
  }

  /** A question its requester decided, or that went on with its asker's default: its card says what was picked, and by
   * whom; the person can still change it. */
  function decided(node: HandoffView, answerer: string): void {
    const card = store.messagesFor(node.threadId).find((message) => message.card?.requestId?.startsWith(`${OPEN_QUESTION}${node.id}-`)
      && message.card.answeredBy?.kind === "bot" && message.card.answeredText === undefined);
    if (!card?.card) return;
    store.patchMessage(node.threadId, card.id, { card: { ...card.card, answeredBy: { kind: "bot", name: answerer }, answeredText: node.answer?.trim() ?? "" } });
  }

  const openQuestionIn = (threadId: string): Message | undefined => store.messagesFor(threadId).findLast((message) =>
    message.card?.requestId?.startsWith(OPEN_QUESTION) === true && answerableInWords(message.card));

  /** The person's own words answered the teammate parked in this conversation: its card says what they answered. */
  function answeredInWords(threadId: string, text: string): void {
    const asked = openQuestionIn(threadId);
    if (asked?.card) store.patchMessage(threadId, asked.id, { card: { ...asked.card, answered: "answer", answeredText: text } });
  }

  /** A bot asked a new question: its earlier open questions in that conversation, which no turn waits on any more, are
   * closed. A parked teammate's own question closes with its work. */
  function askedAgain(threadId: string, requestId: string, botId: string): void {
    const group = store.groupByThread(threadId);
    for (const message of store.messagesFor(threadId)) {
      const card = message.card;
      if (!card?.requestId || card.requestId === requestId || card.requestId.startsWith(OPEN_QUESTION) || !ownQuestionCard(message)
        || liveCardKind(card) === null) continue;
      if ((group && message.from?.botId !== botId) || deps.live(threadId, card.requestId)) continue;
      store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } });
    }
  }

  /** Work handed on ended: a question it left open no longer waits, and its card says why (Stop, an expired wait, or
   * closed), a question its requester was still deciding too. */
  function closed(node: HandoffView): void {
    if (!node.parentId) return;
    for (const message of askersLines(node)) {
      const card = message.card;
      if (!card?.requestId || !(card.requestId.startsWith(`${OPEN_QUESTION}${node.id}-`) || (message.at >= node.createdAt && ownQuestionCard(message)))) continue;
      const deciding = card.answeredBy?.kind === "bot" && card.answeredText === undefined;
      if ((!deciding && liveCardKind(card) === null) || deps.live(node.threadId, card.requestId)) continue;
      const { answeredBy: _decider, ...rest } = card;
      store.patchMessage(node.threadId, message.id, { card: node.outcome === "expired" ? { ...rest, expired: true }
        : { ...rest, answered: "unavailable", dismissed: true, ...(node.outcome === "stopped" ? { stopped: true } : {}) } });
    }
  }

  /** The person answered a parked question's card, or its copy: the work it waits on carries their answer, whether it waits
   * in a room or a bot's conversation. False when no work waits on that card. */
  function answerParked(threadId: string, requestId: string, text: string): boolean {
    const id = requestId.startsWith(OPEN_QUESTION) ? requestId.slice(OPEN_QUESTION.length).replace(/-\d+$/, "") : "";
    const node = id ? deps.node(id) : undefined;
    const message = store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId && !candidate.inbox);
    if (!node || node.status !== "waiting" || node.question === undefined || node.cards?.length || !message?.card || !deps.answerNode(node.id, text)) return false;
    store.patchMessage(threadId, message.id, { card: { ...message.card, answered: "answer", answeredText: text, answeredBy: undefined } });
    return true;
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

  /** A bot's own reply in its own chat ended on a NEEDS INPUT line: the line becomes a question card the person taps or
   * answers in words, as their next message there. */
  function ownQuestion(botId: string, threadId: string, turnId: string): void {
    const reply = store.activePath(threadId).findLast((message) => message.role === "bot" && message.kind === "text" && message.turnId === turnId);
    const question = reply ? needsInputQuestion(reply.text ?? "") : undefined;
    if (!reply || question === undefined) return;
    questionCard({ id: `${botId}-${turnId}`, threadId, botId, executions: 1, createdAt: reply.at, startedAt: reply.at } as HandoffView, question);
  }

  return { park, decided, closed, askedAgain, answerParked, answeredInWords, typed, ownQuestion, showWaitingOnPersonChip, settleWaitingOnPersonChips };
}
