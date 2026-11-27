import type { WebhookTrigger, WebhookTriggerInput } from "../../shared/webhooks";

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
  url: string;
}

export function webhookActivationDefaults(
  webhook?: Pick<WebhookTrigger, "enabled" | "verificationPending">,
): Pick<WebhookTriggerInput, "enabled" | "verificationPending"> {
  return {
    enabled: webhook?.enabled ?? true,
    verificationPending: webhook?.verificationPending ?? false,
  };
}

/** Must match the server's DEFAULT_MAX_PENDING_RUNS. */
export const WEBHOOK_DEFAULT_MAX_PENDING_RUNS = 3;
export const WEBHOOK_MAX_PENDING_RUNS_LIMIT = 50;

export function webhookMaxPendingRunsInput(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= WEBHOOK_MAX_PENDING_RUNS_LIMIT ? value : undefined;
}
