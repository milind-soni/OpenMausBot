// Who answers a bot's question. At Full access ("Just do it") a question asked with an ask tool in work handed on that the
// person started is not put to them: the bot takes its default, or hands a real choice to its requester.
// Otherwise a question waits for the person, and an answer counts wherever it is given, also when their Chief or another
// bot passes it on to the bot that asks, naming the question it answers. What the bot that handed work on sends to the
// thread that work runs in goes into that work: it answers the question the work waits on, or reaches its running turn.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { HandoffView } from "../coordinator.ts";
import { peerDeliveryReceipt, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { composeAddition } from "../runtime/envelope.ts";
import { personOnly, withDefault } from "../runtime/questions.ts";
import type { Answerer } from "../runtime/types.ts";
import { conversationLanguage } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { answerableInWords } from "./ask-cards.ts";
import { sentRow } from "./handoff-sent.ts";

export interface QuestionRoutingDeps {
  store: Pick<Store, "bot" | "tasks" | "messagesFor" | "patchMessage" | "appendMessage" | "taskByThread">;
  active(): HandoffView[];
  node(id: string): HandoffView | undefined;
  parkedFor(botId: string): HandoffView[];
  answerNode(id: string, text: string, by: Answerer): boolean;
  /** The bot's turn in `threadId` waits on this card's live request. */
  live(threadId: string, requestId: string): boolean;
  /** Answers the live question request a turn waits on; true when the turn took the answer. */
  answerLive(threadId: string, requestId: string, text: string): Promise<boolean>;
  /** The open sign-in cards this work waits on were answered elsewhere: they settle, and the place goes back to its bot. */
  settleSignIns(node: HandoffView): void;
  /** The work runs in one person's private chat and its requester's chat is not that one: its questions stay theirs. */
  keptPrivate(node: HandoffView, requester: HandoffView): boolean;
  /** Hands `text` to the turn running in `threadId`, read at its next step as a person's line sent mid-turn is; false when
   * its engine cannot take it now. */
  steer(threadId: string, text: string): Promise<boolean>;
}

const ENDED: ReadonlySet<HandoffView["status"]> = new Set(["completed", "failed", "cancelled"]);

/** A question a bot waits on: parked work (its own question, or only sign-ins), or a turn waiting on its question card. */
interface Waiting {
  threadId: string;
  question: string;
  node?: HandoffView;
  card?: Message;
}

export function createQuestionRouting(deps: QuestionRoutingDeps) {
  const { store } = deps;

  /** At Full access a question asked with an ask tool in work handed on, which the person started, is answered at once
   * with this instead of a card; undefined shows the card. What only the person can give still reaches them, and so
   * does every question in work an outside event started or in work that runs in their private chat. */
  function notAsked(input: { botId: string; threadId: string; level: ApprovalMode; question: string }): string | undefined {
    if (input.level !== "full" || personOnly(input.question)) return undefined;
    const node = deps.active().find((n) => n.threadId === input.threadId && n.botId === input.botId && n.status === "running" && n.parentId !== undefined);
    const requester = node?.parentId ? deps.node(node.parentId) : undefined;
    if (!node || !requester || node.origin?.kind === "outside" || deps.keptPrivate(node, requester)) return undefined;
    return `Not asked: at this level nobody is interrupted. Take the sensible default yourself, carry on, and say in one plain line what you chose. If you truly cannot choose, end your turn with NEEDS INPUT:, the question and Default: your pick, and @${store.bot(requester.botId)?.name ?? "your requester"} decides.`;
  }

  const signInsOnly = (node: HandoffView): boolean => {
    const rows = store.messagesFor(node.threadId);
    return Boolean(node.cards?.length) && node.cards!.every((id) => rows.some((row) => row.id === id && row.signIn));
  };

  function waitingOn(target: BotRecord): Waiting[] {
    const parked = deps.parkedFor(target.id).filter((node) => node.parentId && !node.groupId && (!node.cards?.length || signInsOnly(node)))
      .map((node) => ({ threadId: node.threadId, question: withDefault(node.question ?? "").question, node }));
    const live = store.tasks(target.id).flatMap((task) => {
      const card = store.messagesFor(task.threadId).findLast((row) => !row.inbox && answerableInWords(row.card) && deps.live(task.threadId, row.card!.requestId!));
      if (!card) return [];
      const node = deps.active().find((n) => n.threadId === task.threadId && n.botId === target.id && n.status === "running");
      return [{ threadId: task.threadId, question: card.card!.subtitle || card.card!.title, card, ...(node ? { node } : {}) }];
    });
    return [...parked, ...live];
  }

  /** `sender` handed this work on: its requester is a turn of that bot outside a room, still waiting for it. */
  const handedOnBy = (node: HandoffView, senderId: string): boolean => {
    const requester = node.parentId ? deps.node(node.parentId) : undefined;
    return requester?.botId === senderId && !requester.groupId && !ENDED.has(requester.status);
  };

  /** A bot's message goes into work the target already has instead of becoming new work. It answers a teammate's question
   * when it says so (`answers`: the assignment id the question's note names), when the sender's own turn was resumed with
   * that question, or when it goes to the thread (`threadId`) where work the sender handed on in an earlier turn waits on
   * a question (not on a sign-in only the person can do). Otherwise, to the thread where such work is running, it is
   * handed to that running turn. Work handed out in this very turn (`sentThisTurn`) stays apart: a second assignment is its
   * own. Undefined when it goes into no work; a failed receipt when `answers` names work that no longer asks. */
  async function relay(input: { sender: BotRecord; senderThreadId: string; senderNode?: HandoffView; target: BotRecord; message: string; answers?: string;
    threadId?: string; sentThisTurn?: ReadonlySet<string> }): Promise<PeerDeliveryReceipt | undefined> {
    const { sender, target, message } = input;
    const waiting = waitingOn(target);
    const ownWork = (node: HandoffView | undefined): node is HandoffView => node !== undefined && node.threadId === input.threadId
      && !input.sentThisTurn?.has(node.id) && handedOnBy(node, sender.id);
    const pick = input.answers !== undefined ? waiting.find((one) => one.node?.id === input.answers)
      : waiting.find((one) => one.node !== undefined && input.senderNode?.carrying?.includes(one.node.id) === true)
        ?? waiting.find((one) => ownWork(one.node) && (one.card !== undefined || !one.node.cards?.length));
    const refused = () => input.answers === undefined ? undefined : peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed",
      detail: `nothing of ${target.name}'s waits on an answer as ${input.answers}: it was answered or its work ended. Send it without answers if it still needs doing` });
    if (!pick) return refused() ?? await handOn(input, deps.active().find((node) => node.botId === target.id && node.status === "running" && ownWork(node)));
    const by: Answerer = { kind: "bot", botId: sender.id };
    if (pick.card) {
      if (!(await deps.answerLive(pick.threadId, pick.card.card!.requestId!, `@${sender.name} answered: ${message}`))) return refused();
      const card = store.messagesFor(pick.threadId).find((row) => row.id === pick.card!.id)?.card;
      if (card) store.patchMessage(pick.threadId, pick.card.id, { card: { ...card, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
    } else {
      const node = pick.node!;
      if (!deps.answerNode(node.id, message, by)) return refused();
      if (node.cards?.length) deps.settleSignIns(node);
      const asked = store.messagesFor(node.threadId).find((row) => row.card?.requestId?.startsWith(`needs-input-${node.id}-`) && !row.inbox
        && (!row.card.answered || (row.card.answeredBy?.kind === "bot" && row.card.answeredText === undefined)));
      if (asked?.card) store.patchMessage(node.threadId, asked.id, { card: { ...asked.card, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
    }
    store.appendMessage(input.senderThreadId, { role: "bot", kind: "activity", from: { botId: sender.id, name: sender.name, color: sender.color },
      tool: { name: `Answered ${target.name}'s question`, ok: true, output: pick.question.slice(0, 400) },
      threadRef: { botId: target.id, threadId: pick.threadId, title: store.taskByThread(target.id, pick.threadId)?.title ?? target.name } });
    return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId: pick.threadId, ...(pick.node ? { requestId: pick.node.id } : {}),
      detail: `answered its question "${pick.question}"; it carries on with your answer, and its result returns to whoever handed it that work` });
  }

  /** The sender's message, to the turn running the work it handed on: the turn reads it at its next step, and that work's one
   * result still returns once. Undefined when no such turn runs or its engine cannot take it now. */
  async function handOn(input: { sender: BotRecord; senderThreadId: string; target: BotRecord; message: string }, running: HandoffView | undefined): Promise<PeerDeliveryReceipt | undefined> {
    const { sender, target, message } = input;
    if (!running || !(await deps.steer(running.threadId, composeAddition(running.id, sender.name, message)))) return undefined;
    store.appendMessage(running.threadId, { role: "user", kind: "text", text: message, peerAsk: { botId: sender.id, name: sender.name }, aside: true, steered: true });
    const title = store.taskByThread(target.id, running.threadId)?.title;
    store.appendMessage(input.senderThreadId, sentRow({ sender, recipient: target, threadId: running.threadId, via: "direct", language: conversationLanguage(input.senderThreadId),
      ...(title ? { title } : {}) }));
    return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId: running.threadId, requestId: running.id,
      detail: "handed to the turn it is running on the work you gave it, which reads it at its next step; that work's one result still returns to you" });
  }

  return { notAsked, relay };
}
