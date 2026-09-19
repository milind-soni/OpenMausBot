// Transcript, card, and optimistic-send cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceMessages below.

import type { Action } from "../action";
import type { AppState } from "../reducer";
import { dismissOnboardingCard, optimisticMessageId, optimisticUserMessage, patchCard, patchGroupCard, updateBot, withMascotMotion } from "./helpers";


/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;
export type MessagesAction = Extract<Action, { type: "answerCard" | "dismissCard" | "messageAdded" | "optimisticMessageRemoved" | "messagePatched" | "send" | "editMessage" }>;

export function reduceMessages(state: AppState, action: MessagesAction): AppState {
  switch (action.type) {
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard": {
      if (action.groupId) return patchGroupCard(state, action.groupId, action.messageId, { answered: action.answer });
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      const card = bot?.messages.find((message) => message.id === action.messageId)?.card;
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, {
          answered: action.answer,
          // talking past the first-run quiz hides it; live asks stay until resolved
          ...(card?.requestId ? {} : { dismissed: true }),
        }),
        action.botId,
        "working",
      );
    }
    case "dismissCard":
      if (action.groupId) return patchGroupCard(state, action.groupId, action.messageId, { dismissed: true });
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        // room thread — plain linear append, no branching/mascot machinery
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        if (group.messages.some((m) => m.id === action.message.id)) return state;
        const optimisticIndex = action.message.sendId
          ? group.messages.findIndex(
              (message) => message.id === optimisticMessageId(action.message.sendId!),
            )
          : -1;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? {
                  ...g,
                  messages: optimisticIndex >= 0
                    ? g.messages.map((message, index) =>
                        index === optimisticIndex ? action.message : message
                      )
                    : [...g.messages, action.message],
                }
              : g,
          ),
        };
      }
      // The POST response and the canonical SSE frame may arrive in either
      // order. A repeated message is already folded; moving the active leaf
      // back to it can hide a newer assistant reply that won the race.
      if (bot.messages.some((message) => message.id === action.message.id)) return state;
      const optimisticId = action.message.sendId
        ? optimisticMessageId(action.message.sendId)
        : null;
      const optimisticIndex = optimisticId
        ? bot.messages.findIndex((message) => message.id === optimisticId)
        : -1;
      if (optimisticIndex >= 0) {
        return updateBot(state, bot.id, (current) => ({
          ...current,
          messages: current.messages.map((message, index) =>
            index === optimisticIndex ? action.message : message
          ),
          activeLeafId: current.activeLeafId === optimisticId
            ? action.message.id
            : current.activeLeafId,
        }));
      }
      // every server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) => {
        // A message chains onto the leaf → it becomes the leaf (the normal
        // append). A message parented elsewhere is a chain-insert of a late
        // turn artifact (settle-time screenshot) — the leaf must stay put,
        // or the follow-up send it raced would fall off the active branch.
        const adoptsLeaf = (action.message.parentId ?? null) === (b.activeLeafId ?? null);
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: adoptsLeaf ? action.message.id : b.activeLeafId };
      });
      const motion =
        action.message.role === "user" && action.message.kind === "text" && Boolean(action.message.queueId)
          ? "working"
          : action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "optimisticMessageRemoved": {
      const id = optimisticMessageId(action.sendId);
      const bot = state.bots.find((candidate) => candidate.threadId === action.threadId);
      if (bot) {
        const optimistic = bot.messages.find((message) => message.id === id);
        if (!optimistic) return state;
        return updateBot(state, bot.id, (current) => ({
          ...current,
          messages: current.messages.filter((message) => message.id !== id),
          activeLeafId: current.activeLeafId === id
            ? (optimistic.parentId ?? null)
            : current.activeLeafId,
        }));
      }
      const group = state.groups.find((candidate) => candidate.threadId === action.threadId);
      if (!group || !group.messages.some((message) => message.id === id)) return state;
      return {
        ...state,
        groups: state.groups.map((candidate) => candidate.id === group.id
          ? { ...candidate, messages: candidate.messages.filter((message) => message.id !== id) }
          : candidate),
      };
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "send": {
      const animated = withMascotMotion(
        dismissOnboardingCard(state, action.botId),
        action.botId,
        "working",
      );
      if (!action.sendId) return animated;
      const bot = animated.bots.find((candidate) => candidate.id === action.botId);
      const threadId = action.threadId ?? bot?.threadId;
      if (!bot || threadId !== bot.threadId) return animated;
      if (bot.messages.some((message) => message.sendId === action.sendId)) return animated;
      const message = optimisticUserMessage(
        action.text,
        action.sendId,
        action.replyToId,
        bot.activeLeafId,
      );
      return updateBot(animated, bot.id, (current) => ({
        ...current,
        messages: [...current.messages, message],
        activeLeafId: message.id,
      }));
    }
    case "editMessage":
      return withMascotMotion(state, action.botId, "working");
  }
  return action satisfies never;
}
