/** Webhook wire shapes: triggers and delivery attempts as they ride the REST
 * snapshot and the `webhook` / `webhook.attempt` live frames. */
import type { RoutineRunOn } from "./routines.ts";

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
  /** delivery:"post" only: the stable thread this webhook's messages land in,
   *  created on first delivery and reused after, never the bot's
   *  currently-selected thread. Unset on a room webhook (`groupId`), whose
   *  messages land in the room's own thread. */
  resultsThreadId?: string;
  /** delivery:"post" only, optional: a room id. Set, each delivery appends
   *  one bot-authored message (plus optional voice note and images) straight
   *  into that room, starting no turn and creating no task thread. The
   *  trigger's bot must be a member of the room, checked on create, on edit,
   *  and again at every delivery. */
  groupId?: string;
  deliveryCount: number;
  verificationPending?: boolean;
  verifiedAt?: number;
  verificationSample?: WebhookVerificationSample;
  eventTypes?: string[];
  /** Unfinished runs this webhook may hold before new deliveries get 429.
   * Absent means the default (3). */
  maxPendingRuns?: number;
}

export interface WebhookTriggerInput {
  name: string;
  prompt: string;
  botId: string;
  runOn?: RoutineRunOn;
  /** Requires `delivery: "post"`; a room webhook with any other delivery is refused. `null` on an edit
   *  takes the room off, so deliveries go back to the webhook's own thread. */
  groupId?: string | null;
  enabled?: boolean;
  verificationPending?: boolean;
  eventTypes?: string[];
  /** 1–50; `null` goes back to the default. */
  maxPendingRuns?: number | null;
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
  /** room post deliveries: the room whose thread received the message. */
  threadId?: string;
  reason?: string;
}

export interface WebhookIngressStatus {
  available: boolean;
  baseUrl: string;
  error?: string;
}

