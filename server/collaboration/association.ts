import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const WORK_ITEM_REFERENCE = /\bWI-[A-Z0-9][A-Z0-9-]{2,63}\b/giu;

export type AssociationDecision =
  | { kind: "create" }
  | { kind: "associate"; workItemId: string }
  | { kind: "ambiguous"; workItemIds: string[] }
  | { kind: "invalid_reference"; reference: string };

function activeWorkItems(database: DatabaseSync, conversationId: string): string[] {
  return (
    database
      .prepare(
        "SELECT id FROM collaboration_work_items " +
          "WHERE conversation_id = ? AND status NOT IN ('cancelled', 'accepted') ORDER BY updated_at DESC, id",
      )
      .all(conversationId) as Array<{ id: string }>
  ).map((row) => row.id);
}

function validReference(database: DatabaseSync, conversationId: string, reference: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM collaboration_work_items WHERE id = ? AND conversation_id = ?")
      .get(reference, conversationId),
  );
}

export function decideMessageAssociation(
  database: DatabaseSync,
  input: { source: "dingtalk"; conversationId: string; text: string; replyToSourceEventId?: string },
): AssociationDecision {
  const references = [...new Set((input.text.match(WORK_ITEM_REFERENCE) ?? []).map((value) => value.toUpperCase()))];
  if (references.length) {
    const valid = references.filter((reference) => validReference(database, input.conversationId, reference));
    if (valid.length > 1) return { kind: "ambiguous", workItemIds: valid.sort() };
    if (valid.length === 1 && references.length === 1) return { kind: "associate", workItemId: valid[0] };
    return { kind: "invalid_reference", reference: references.find((reference) => !valid.includes(reference))! };
  }

  if (!input.replyToSourceEventId) return { kind: "create" };
  const reply = database
    .prepare(
      "SELECT work_item_id FROM collaboration_external_events " +
        "WHERE source = ? AND source_event_id = ? AND conversation_id = ?",
    )
    .get(input.source, input.replyToSourceEventId, input.conversationId) as { work_item_id: string | null } | undefined;
  if (reply?.work_item_id) return { kind: "associate", workItemId: reply.work_item_id };

  const candidates = activeWorkItems(database, input.conversationId);
  if (candidates.length === 1) return { kind: "associate", workItemId: candidates[0] };
  if (candidates.length > 1) return { kind: "ambiguous", workItemIds: candidates };
  return { kind: "create" };
}

export function resolveConversationAlias(
  database: DatabaseSync,
  source: "dingtalk",
  externalConversationId: string,
  now: number,
): string {
  const existing = database
    .prepare("SELECT conversation_id FROM collaboration_conversation_aliases WHERE source = ? AND external_id = ?")
    .get(source, externalConversationId) as { conversation_id: string } | undefined;
  if (existing) return existing.conversation_id;
  const id = randomUUID();
  database.prepare("INSERT INTO collaboration_conversations (id, created_at) VALUES (?, ?)").run(id, now);
  database
    .prepare(
      "INSERT INTO collaboration_conversation_aliases (source, external_id, conversation_id, created_at) " +
        "VALUES (?, ?, ?, ?)",
    )
    .run(source, externalConversationId, id, now);
  return id;
}
