import { createHash } from "node:crypto";

import type { ResolvedSender } from "../shared/wire.ts";
import { cancelChannelMessage, queuedChannelMessage, queueChannelMessage } from "./channel-queue.ts";
import type { ReplyTarget } from "./replies.ts";
import type { RequestAuth } from "./request-auth.ts";
import { acceptedSendMatch, sendFingerprint, type SendSequencer } from "./send-idempotency.ts";
import { cancelSteeredMessage, queuedSteeredMessage } from "./steer-queue.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

export interface PersonReplyDeps {
  store: Pick<Store, "group" | "groupByThread" | "groupTaskByThread" | "messagesFor" | "patchMessage" | "taskByThread">;
  sendSequencer: Pick<SendSequencer, "run">;
  assertWithinBudget(): void;
  messageSender(auth: RequestAuth): ResolvedSender | undefined;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
  groupThreadIsWorking(groupId: string, threadId: string): boolean;
  startGroupTurn(groupId: string, text: string, replyTo: ReplyTarget, sendId: string, mode: "chat", queueId: undefined,
    options: { threadId: string; sender?: ResolvedSender; trigger: UsageTrigger }): unknown;
  startOrQueueDirectMessage(botId: string, threadId: string, text: string, replyTo: ReplyTarget, sendId: string,
    sender?: ResolvedSender, trigger?: UsageTrigger, via?: "call", callId?: string): Promise<{ queued?: true }>;
}

/** A person's answer to one message: it becomes their next message to the bot that wrote it, addressed to that bot by
 * name in a room. It starts the bot's turn or waits behind the running one, and a retry with the same sendId never
 * sends it twice. */
export interface PersonReply {
  auth: RequestAuth;
  threadId: string;
  owner: BotRecord;
  target: ReplyTarget;
  answer: string;
  sendId: string;
  /** What `target` is, as the refusals name it. */
  about: "question" | "message";
  via?: "call";
  callId?: string;
  /** Checked once the reply holds its send slot: why it may no longer go, or null. */
  refusal?(): string | null;
}

const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

export function createPersonReplies(deps: PersonReplyDeps) {
  const { store, sendSequencer } = deps;

  function room(threadId: string) {
    const group = store.groupByThread(threadId);
    const owned = group ? group.dm ? group.threadId === threadId : Boolean(store.groupTaskByThread(group.id, threadId)) : false;
    return { group, owned };
  }

  async function deliver(reply: PersonReply): Promise<{ queued: boolean; repeated?: true }> {
    const { auth, threadId, owner, target, answer, sendId, about, via, callId } = reply;
    const { group, owned } = room(threadId);
    if (group && (!owned || !group.memberIds.includes(owner.id))) {
      throw conflict(`the bot that ${about === "question" ? "asked this question" : "wrote this message"} is no longer in this conversation`);
    }
    if (!group && !store.taskByThread(owner.id, threadId)) throw conflict(`the ${about}'s conversation no longer exists`);

    const text = group ? `@${owner.name}: ${answer}` : answer;
    const key = group ? `group:${group.id}:${threadId}:${sendId}` : `bot:${owner.id}:${threadId}:${sendId}`;
    return sendSequencer.run(key, sendFingerprint(text, target.id, group ? "chat" : undefined), async () => {
      const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, target.id, group ? "chat" : undefined);
      if (accepted.kind === "conflict") throw conflict(`this ${about} already has a different recorded answer`);
      if (accepted.kind === "match") return { queued: false, repeated: true };

      const queuedDirect = group ? null : queuedSteeredMessage(owner.id, threadId, sendId);
      if (queuedDirect) {
        if (queuedDirect.text !== text || queuedDirect.replyToId !== target.id) throw conflict(`this ${about} already has a different queued answer`);
        return { queued: true };
      }
      const queuedRoom = group ? queuedChannelMessage(group.id, threadId, sendId) : null;
      if (queuedRoom) {
        if (queuedRoom.text !== text || queuedRoom.replyToId !== target.id || queuedRoom.mode !== "chat") {
          throw conflict(`this ${about} already has a different queued answer`);
        }
        return { queued: true };
      }

      const refused = reply.refusal?.();
      if (refused) throw conflict(refused);
      deps.assertWithinBudget();
      const sender = deps.messageSender(auth);
      const trigger = deps.usageTriggerFor(auth);
      if (group) {
        const current = store.group(group.id);
        if (!current || !owned) throw conflict(`the room switched tasks before it could receive the answer`);
        if (deps.groupThreadIsWorking(current.id, threadId)) {
          queueChannelMessage(current.id, threadId, text, { replyToId: target.id, sendId, mode: "chat", sender, trigger, reaction: target.reactedWith });
          return { queued: true };
        }
        deps.startGroupTurn(current.id, text, target, sendId, "chat", undefined, { threadId, sender, trigger });
        return { queued: false };
      }
      const direct = await deps.startOrQueueDirectMessage(owner.id, threadId, text, target, sendId, sender, trigger, via, callId);
      return { queued: Boolean(direct.queued) };
    });
  }

  function withdraw(threadId: string, owner: BotRecord, sendId: string): void {
    const group = store.groupByThread(threadId);
    if (group) {
      const queued = queuedChannelMessage(group.id, threadId, sendId);
      if (queued) cancelChannelMessage(group.id, queued.id);
      return;
    }
    const queued = queuedSteeredMessage(owner.id, threadId, sendId);
    if (queued) cancelSteeredMessage(owner.id, queued.id, threadId);
  }

  async function deliverLateQuestionAnswer(
    auth: RequestAuth, threadId: string, requestId: string, answer: string, cardMessage: Message, owner: BotRecord,
    via?: "call", callId?: string,
  ): Promise<{ queued: boolean }> {
    const latestCard = () => store.messagesFor(threadId).find((message) => message.id === cardMessage.id)?.card;
    const receipt = await deliver({
      auth, threadId, owner, target: cardMessage, answer, via, callId, about: "question",
      sendId: `late-question-${createHash("sha256").update(`${threadId}:${requestId}`).digest("hex").slice(0, 32)}`,
      refusal: () => {
        const card = latestCard();
        return !card || card.answered || card.dismissed ? "this question has already been answered" : null;
      },
    });
    const latest = latestCard();
    if (latest && !latest.answered && !latest.dismissed) {
      store.patchMessage(threadId, cardMessage.id, { card: { ...latest, answered: "answer", answeredText: answer, dismissed: false } });
    }
    return receipt;
  }

  return { deliver, withdraw, deliverLateQuestionAnswer };
}
