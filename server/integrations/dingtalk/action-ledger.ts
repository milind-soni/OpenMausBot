import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { OwnerActionOutcome } from "../../collaboration/actions.ts";
import type { DingTalkCardAction } from "./types.ts";

interface ActionEventRow {
  payload_hash: string;
  outcome_json: string;
}

function payloadHash(action: DingTalkCardAction): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        transportEventId: action.transportEventId,
        actionTokenHash: createHash("sha256").update(action.actionToken).digest("hex"),
        senderCorpId: action.sender.senderCorpId ?? null,
        senderStaffId: action.sender.senderStaffId ?? null,
        reason: action.reason ?? null,
      }),
    )
    .digest("hex");
}

/**
 * Transport-event dedupe is deliberately separate from authorization. The
 * core action token remains the authoritative, transactional replay fence.
 */
export class DingTalkCardActionLedger {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(filePath: string) {
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS dingtalk_card_action_events (" +
        "transport_event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, outcome_json TEXT NOT NULL, processed_at INTEGER NOT NULL)",
    );
  }

  perform(action: DingTalkCardAction, operation: () => OwnerActionOutcome): OwnerActionOutcome {
    if (this.closed) throw new Error("dingtalk_action_ledger_closed");
    const hash = payloadHash(action);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT payload_hash, outcome_json FROM dingtalk_card_action_events WHERE transport_event_id = ?")
        .get(action.transportEventId) as ActionEventRow | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error("dingtalk_action_event_conflict");
        const outcome = JSON.parse(existing.outcome_json) as OwnerActionOutcome;
        this.database.exec("COMMIT");
        return { ...outcome, duplicate: true };
      }
      const outcome = operation();
      this.database
        .prepare(
          "INSERT INTO dingtalk_card_action_events " +
            "(transport_event_id, payload_hash, outcome_json, processed_at) VALUES (?, ?, ?, ?)",
        )
        .run(action.transportEventId, hash, JSON.stringify(outcome), action.receivedAt);
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
