/**
 * Durable payload of a webhook trigger change a bot made from chat. Every change applies at once (there is no
 * confirmation), so the card is a receipt: what changed, and what Undo needs to put it back.
 */

export interface WebhookRequestDefinition {
  name: string;
  /** Instructions for every call; empty means each call's own task is used. */
  instructions: string;
  runOn: "maus" | "cloud";
  eventTypes?: string[];
}

export type WebhookRequestOperation =
  | { action: "create"; webhook: WebhookRequestDefinition; forBot?: { botId: string; name: string } }
  | { action: "update"; webhookId: string; changes: Partial<WebhookRequestDefinition>; forBot?: { botId: string; name: string } }
  | { action: "pause" | "resume" | "run_now" | "delete"; webhookId: string; forBot?: { botId: string; name: string } };

/** The webhook as it stood before an update, so Undo can restore it. */
export interface WebhookRequestSnapshot extends WebhookRequestDefinition {
  enabled: boolean;
}

export interface WebhookRequestUndo {
  name: string;
  /** The webhook's revision right after the change; Undo refuses once it moved. */
  appliedUpdatedAt?: number;
  before?: WebhookRequestSnapshot;
}

export interface WebhookRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  createdAt: number;
  operation: WebhookRequestOperation;
  /** The webhook the change applied to (the new one for a create). */
  resultId?: string;
  undo?: WebhookRequestUndo;
}
