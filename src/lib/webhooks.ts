import type { WebhookTrigger, WebhookTriggerInput } from "../../shared/webhooks";

/** Webhook wire shapes — triggers and delivery attempts as they ride the REST
 * snapshot and the `webhook` / `webhook.attempt` live frames — live in
 * shared/webhooks.ts now (part of the wire model); re-exported here so
 * existing client imports keep working. */
export type {
  WebhookTrigger,
  WebhookTriggerInput,
  WebhookVerificationSample,
  WebhookAttemptOutcome,
  WebhookAttempt,
  WebhookIngressStatus,
} from "../../shared/webhooks";

export interface WebhookCredential {
  endpointUrl: string;
  secret: string;
  /** Capability URL for senders that cannot configure an Authorization header. */
  url: string;
}

/** New local webhooks are ready to execute immediately. Editing an existing
 * webhook must preserve its current pause/verification state. */
export function webhookActivationDefaults(
  webhook?: Pick<WebhookTrigger, "enabled" | "verificationPending">,
): Pick<WebhookTriggerInput, "enabled" | "verificationPending"> {
  return {
    enabled: webhook?.enabled ?? true,
    verificationPending: webhook?.verificationPending ?? false,
  };
}

/** Matches the server's DEFAULT_MAX_PENDING_RUNS and MAX_PENDING_RUNS_LIMIT. */
export const WEBHOOK_DEFAULT_MAX_PENDING_RUNS = 3;
export const WEBHOOK_MAX_PENDING_RUNS_LIMIT = 50;

/** The "Unfinished tasks at once" field: blank means the default (`null`),
 * a whole number 1–50 is that limit, and anything else is `undefined` so the
 * editor can say what is wrong instead of sending it. */
export function webhookMaxPendingRunsInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= WEBHOOK_MAX_PENDING_RUNS_LIMIT ? value : undefined;
}
