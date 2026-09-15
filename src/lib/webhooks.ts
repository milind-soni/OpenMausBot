import type { RoutineRunOn } from "@/lib/routines";

export interface WebhookTrigger {
  id: string;
  endpointId: string;
  name: string;
  prompt: string;
  botId: string;
  runOn: RoutineRunOn;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastReceivedAt?: number;
  lastRunId?: string;
  deliveryCount: number;
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  eventTypes?: string[];
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
}

export interface WebhookVerificationSample {
  receivedAt: number;
  eventName?: string;
  contentType?: string;
  preview: string;
}

export type WebhookAttemptOutcome = "accepted" | "captured" | "duplicate" | "ignored" | "rejected";

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  receivedAt: number;
  outcome: WebhookAttemptOutcome;
  statusCode: number;
  eventName?: string;
  preview?: string;
  deliveryId?: string;
  runId?: string;
  reason?: string;
}

export interface WebhookIngressStatus {
  available: boolean;
  baseUrl: string;
  error?: string;
}

export interface WebhookCredential {
  endpointUrl: string;
  secret: string;
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
