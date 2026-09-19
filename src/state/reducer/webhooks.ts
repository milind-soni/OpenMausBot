// Webhook and webhook-attempt cases. Case bodies moved verbatim from the reducer switch;
// reducer.ts dispatches each contiguous run to reduceWebhooks below.

import type { Action } from "../action";
import type { AppState } from "../reducer";

export type WebhooksAction = Extract<Action, { type: "webhooksHydrated" | "webhookPatched" | "webhookDeleted" | "webhookAttempted" }>;

export function reduceWebhooks(state: AppState, action: WebhooksAction): AppState {
  switch (action.type) {
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
  }
  return action satisfies never;
}
