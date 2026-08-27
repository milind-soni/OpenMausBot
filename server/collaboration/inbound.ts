import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { decideMessageAssociation, resolveConversationAlias, type AssociationDecision } from "./association.ts";
import { resolveDingTalkPrincipal, type PrincipalResolution } from "./identity.ts";
import {
  renderAssociationChoiceCard,
  renderInvalidReferenceCard,
  renderPrimaryStatusCard,
  type InboundAcknowledgementCard,
} from "./message-renderer.ts";
import {
  enqueueInboundCard,
  listPendingOutbox,
  outboxEntryForEvent,
  type CollaborationOutboxEntry,
} from "./outbox.ts";
import { assertLedgerArmed } from "./restore-guard.ts";

type PersistedAssociationState = "created" | "associated" | "ambiguous" | "invalid_reference";

export interface InboundMessageOutcome {
  accepted: true;
  duplicate: boolean;
  sourceEventId: string;
  transportMessageId: string;
  principalId: string;
  principalResolution: PrincipalResolution;
  association: PersistedAssociationState;
  workItemId: string | null;
  card: InboundAcknowledgementCard;
  outboxId: string;
}

interface ExistingEventRow {
  transport_message_id: string;
  principal_id: string;
  resolution: PrincipalResolution;
  association_state: PersistedAssociationState;
  work_item_id: string | null;
}

function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return normalized;
}

function workItemId(): string {
  return `WI-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function eventHash(message: DingTalkInboundMessage, text: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceEventId: message.sourceEventId,
        transportMessageId: message.transportMessageId,
        conversationId: message.conversationId,
        replyToSourceEventId: message.replyToSourceEventId ?? null,
        senderCorpId: message.sender.senderCorpId ?? null,
        senderStaffId: message.sender.senderStaffId ?? null,
        senderId: message.sender.senderId,
        text,
      }),
    )
    .digest("hex");
}

function titleFrom(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? text).replace(/\s+/g, " ").slice(0, 120);
}

export class InboundMessageProcessor {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databaseFile: string) {
    this.database = new DatabaseSync(databaseFile);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 2) throw new Error("Collaboration ingress schema is not installed");
  }

  processDingTalkMessage(message: DingTalkInboundMessage): InboundMessageOutcome {
    if (this.closed) throw new Error("Inbound message processor is closed");
    if (!message.addressedToBot) throw new Error("Inbound message was not explicitly addressed to the bot");
    const sourceEventId = requiredText(message.sourceEventId, "sourceEventId", 256);
    const transportMessageId = requiredText(message.transportMessageId, "transportMessageId", 256);
    const externalConversationId = requiredText(message.conversationId, "conversationId", 256);
    const text = requiredText(message.text, "message text", 8_000);
    const now = message.receivedAt ?? Date.now();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertLedgerArmed(this.database);
      const existing = this.database
        .prepare(
          "SELECT e.transport_message_id, e.principal_id, p.resolution, e.association_state, e.work_item_id " +
            "FROM collaboration_external_events e " +
            "JOIN collaboration_principals p ON p.id = e.principal_id " +
            "WHERE e.source = 'dingtalk' AND e.source_event_id = ?",
        )
        .get(sourceEventId) as ExistingEventRow | undefined;
      if (existing) {
        const outbox = outboxEntryForEvent(this.database, sourceEventId);
        if (outbox.card.type === "clarification_card" || outbox.card.type === "plan_status_card") {
          throw new Error(`Inbound acknowledgement ${sourceEventId} has an invalid card type`);
        }
        this.database.exec("COMMIT");
        return {
          accepted: true,
          duplicate: true,
          sourceEventId,
          transportMessageId: existing.transport_message_id,
          principalId: existing.principal_id,
          principalResolution: existing.resolution,
          association: existing.association_state,
          workItemId: existing.work_item_id,
          card: outbox.card,
          outboxId: outbox.id,
        };
      }

      const principal = resolveDingTalkPrincipal(this.database, message.sender, now);
      const conversationId = resolveConversationAlias(this.database, "dingtalk", externalConversationId, now);
      const association = decideMessageAssociation(this.database, {
        source: "dingtalk",
        conversationId,
        text,
        ...(message.replyToSourceEventId ? { replyToSourceEventId: message.replyToSourceEventId } : {}),
      });
      const outcome = this.persistNewEvent({
        message,
        sourceEventId,
        transportMessageId,
        conversationId,
        text,
        now,
        principal,
        association,
      });
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  pendingOutbox(): CollaborationOutboxEntry[] {
    if (this.closed) throw new Error("Inbound message processor is closed");
    return listPendingOutbox(this.database);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private persistNewEvent(input: {
    message: DingTalkInboundMessage;
    sourceEventId: string;
    transportMessageId: string;
    conversationId: string;
    text: string;
    now: number;
    principal: { id: string; resolution: PrincipalResolution };
    association: AssociationDecision;
  }): InboundMessageOutcome {
    const externalEventId = randomUUID();
    let state: PersistedAssociationState;
    let selectedWorkItemId: string | null = null;
    let card: InboundAcknowledgementCard;
    let aggregateVersion = 1;

    if (input.association.kind === "create") {
      state = "created";
      selectedWorkItemId = workItemId();
      this.database
        .prepare(
          "INSERT INTO collaboration_work_items " +
            "(id, conversation_id, title, status, version, created_by, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'collecting', 1, ?, ?, ?)",
        )
        .run(selectedWorkItemId, input.conversationId, titleFrom(input.text), input.principal.id, input.now, input.now);
      card = renderPrimaryStatusCard({
        workItemId: selectedWorkItemId,
        status: "collecting",
        version: 1,
        association: "created",
      });
    } else if (input.association.kind === "associate") {
      state = "associated";
      selectedWorkItemId = input.association.workItemId;
      this.database
        .prepare("UPDATE collaboration_work_items SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(input.now, selectedWorkItemId);
      const item = this.database
        .prepare("SELECT status, version FROM collaboration_work_items WHERE id = ?")
        .get(selectedWorkItemId) as { status: string; version: number };
      aggregateVersion = item.version;
      card = renderPrimaryStatusCard({
        workItemId: selectedWorkItemId,
        status: item.status,
        version: item.version,
        association: "associated",
      });
    } else if (input.association.kind === "ambiguous") {
      state = "ambiguous";
      card = renderAssociationChoiceCard(input.association.workItemIds);
    } else {
      state = "invalid_reference";
      card = renderInvalidReferenceCard(input.association.reference);
    }

    this.database
      .prepare(
        "INSERT INTO collaboration_external_events " +
          "(id, source, source_event_id, transport_message_id, conversation_id, principal_id, kind, normalized_json, raw_hash, association_state, work_item_id, received_at) " +
          "VALUES (?, 'dingtalk', ?, ?, ?, ?, 'message', ?, ?, ?, ?, ?)",
      )
      .run(
        externalEventId,
        input.sourceEventId,
        input.transportMessageId,
        input.conversationId,
        input.principal.id,
        JSON.stringify({ text: input.text, replyToSourceEventId: input.message.replyToSourceEventId ?? null }),
        eventHash(input.message, input.text),
        state,
        selectedWorkItemId,
        input.now,
      );

    if (selectedWorkItemId) {
      this.database
        .prepare(
          "INSERT INTO collaboration_work_item_events " +
            "(id, work_item_id, external_event_id, event_type, payload_json, principal_id, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          selectedWorkItemId,
          externalEventId,
          state === "created" ? "problem.reported" : "contribution.added",
          JSON.stringify({ text: input.text }),
          input.principal.id,
          input.now,
        );
    } else if (input.association.kind === "ambiguous") {
      const insertOption = this.database.prepare(
        "INSERT INTO collaboration_association_options (external_event_id, work_item_id) VALUES (?, ?)",
      );
      for (const candidate of input.association.workItemIds) insertOption.run(externalEventId, candidate);
    }

    const outbox = enqueueInboundCard(this.database, {
      sourceEventId: input.sourceEventId,
      aggregateType: selectedWorkItemId ? "work_item" : "association",
      aggregateId: selectedWorkItemId ?? externalEventId,
      aggregateVersion,
      card,
      now: input.now,
    });
    return {
      accepted: true,
      duplicate: false,
      sourceEventId: input.sourceEventId,
      transportMessageId: input.transportMessageId,
      principalId: input.principal.id,
      principalResolution: input.principal.resolution,
      association: state,
      workItemId: selectedWorkItemId,
      card,
      outboxId: outbox.id,
    };
  }
}
