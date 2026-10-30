// Who answers a bot's question. At Full access ("Just do it") a question asked with an ask tool in work handed on that the
// person started is not put to them: the bot takes its default, or hands a real choice to its requester.
// Otherwise a question waits for the person, and an answer counts wherever it is given, also when their Chief or another
// bot passes it on to the bot that asks, naming the question it answers.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { HandoffView } from "../coordinator.ts";
import { peerDeliveryReceipt, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { personOnly, withDefault } from "../runtime/questions.ts";
import type { Answerer } from "../runtime/types.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { answerableInWords } from "./ask-cards.ts";

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
}

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

  /** A bot's message answers a teammate's question instead of becoming new work when it says so (`answers`: the
   * assignment id the question's note names), or when the sender's own turn was resumed with that question. Undefined
   * when it answers nothing; a failed receipt when `answers` names work that no longer asks. */
  async function relay(input: { sender: BotRecord; senderThreadId: string; senderNode?: HandoffView; target: BotRecord; message: string; answers?: string }): Promise<PeerDeliveryReceipt | undefined> {
    const { sender, target, message } = input;
    const waiting = waitingOn(target);
    const pick = input.answers !== undefined ? waiting.find((one) => one.node?.id === input.answers)
      : waiting.find((one) => one.node !== undefined && input.senderNode?.carrying?.includes(one.node.id) === true);
    const refused = () => input.answers === undefined ? undefined : peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed",
      detail: `nothing of ${target.name}'s waits on an answer as ${input.answers}: it was answered or its work ended. Send it without answers if it still needs doing` });
    if (!pick) return refused();
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

  return { notAsked, relay };
}
