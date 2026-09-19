// Queued follow-up chip cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceQueues below.

import type { Action } from "../action";
import type { AppState } from "../reducer";
import { rememberConsumedQueueId } from "../queue-receipts";

export type QueuesAction = Extract<Action, { type: "pendingQueued" | "consumePendingQueued" | "cancelQueued" | "cancelGroupQueued" }>;

export function reduceQueues(state: AppState, action: QueuesAction): AppState {
  switch (action.type) {
    // handled entirely by the async wrapper
    case "pendingQueued": {
      if (state.consumedQueueIds[action.queueId]) {
        const consumedQueueIds = { ...state.consumedQueueIds };
        delete consumedQueueIds[action.queueId];
        return { ...state, consumedQueueIds };
      }
      const prev = state.pendingQueued[action.threadId] ?? [];
      if (prev.some((entry) => entry.queueId === action.queueId)) return state;
      return {
        ...state,
        pendingQueued: {
          ...state.pendingQueued,
          [action.threadId]: [...prev, { queueId: action.queueId, text: action.text, ...(action.reason ? { reason: action.reason } : {}) }],
        },
      };
    }
    case "consumePendingQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const at = prev.findIndex((entry) => entry.queueId === action.queueId);
      if (at < 0) {
        return {
          ...state,
          consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId),
        };
      }
      const rest = prev.filter((_, i) => i !== at);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued, consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId) };
    }
    case "cancelQueued": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      if (!bot) return state;
      const threadId = action.threadId ?? bot.threadId;
      const prev = state.pendingQueued[threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[threadId] = rest;
      else delete pendingQueued[threadId];
      return { ...state, pendingQueued, consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId) };
    }
    case "cancelGroupQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
  }
  return action satisfies never;
}
