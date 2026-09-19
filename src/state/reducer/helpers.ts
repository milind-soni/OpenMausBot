// Pure helpers shared by the reducer's domain case modules and the few
// cases that stay inline in reducer.ts: bot-list updates, mascot motion,
// card patching, optimistic message shaping, and model-variant session
// reconciliation. Moved verbatim from the reducer.

import type { MausMotion } from "@/lib/mascot";
import { currentTaskBot } from "../model";
import type { Bot, Message, OptionCardData } from "../model";
import type { AppState } from "../reducer";

/** Discard discoveries when their model/account is replaced or their thread disappears. */
export function reconcileModelVariantSessions(state: AppState): AppState {
  const sessions = Object.entries(state.modelVariantSessions);
  const kept = sessions.filter(([threadId, session]) => {
    const owner = state.bots.find((bot) => bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId));
    if (!owner) return false;
    const selection = currentTaskBot(owner, threadId).modelSelection;
    return selection.instanceId === session.instanceId && selection.model === session.model;
  });
  return kept.length === sessions.length ? state : { ...state, modelVariantSessions: Object.fromEntries(kept) };
}


export function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

export function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function withPatchedCard(messages: Message[], messageId: string, patch: Partial<OptionCardData>): Message[] {
  return messages.map((m) => (m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m));
}

export function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({ ...b, messages: withPatchedCard(b.messages, messageId, patch) }));
}

export function patchGroupCard(state: AppState, groupId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return {
    ...state,
    groups: state.groups.map((g) =>
      g.id === groupId ? { ...g, messages: withPatchedCard(g.messages, messageId, patch) } : g,
    ),
  };
}

/** First-run quiz still sitting on this bot's thread. */
export function openOnboardingCard(bot: Bot): Message | undefined {
  return bot.messages.find(
    (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
  );
}

export function dismissOnboardingCard(state: AppState, botId: string): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const quiz = bot ? openOnboardingCard(bot) : undefined;
  return quiz ? patchCard(state, botId, quiz.id, { dismissed: true }) : state;
}

export const optimisticMessageId = (sendId: string): string => `optimistic-${sendId}`;

export function optimisticUserMessage(
  text: string,
  sendId: string,
  at: number,
  replyToId?: string,
  parentId?: string | null,
  channelMode?: "chat" | "goal",
): Message {
  return {
    id: optimisticMessageId(sendId),
    role: "user",
    kind: "text",
    text,
    at,
    parentId: parentId ?? null,
    replyToId,
    sendId,
    channelMode,
  };
}

