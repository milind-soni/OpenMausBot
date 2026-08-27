import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { appendControlAudit } from "./audit.ts";

export interface OwnerBinding {
  id: string;
  source: "dingtalk";
  senderCorpId: string;
  senderStaffId: string;
  generation: number;
  active: true;
  createdAt: number;
}

interface OwnerRow {
  id: string;
  source: "dingtalk";
  sender_corp_id: string;
  sender_staff_id: string;
  generation: number;
  active: 1;
  created_at: number;
}

function stableId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > 256) throw new Error(`${field} exceeds 256 characters`);
  return normalized;
}

function identityHash(senderCorpId: string, senderStaffId: string): string {
  return createHash("sha256").update(`${senderCorpId}\0${senderStaffId}`).digest("hex");
}

function rowToBinding(row: OwnerRow): OwnerBinding {
  return {
    id: row.id,
    source: row.source,
    senderCorpId: row.sender_corp_id,
    senderStaffId: row.sender_staff_id,
    generation: row.generation,
    active: true,
    createdAt: row.created_at,
  };
}

export class LocalOwnerRegistry {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databaseFile: string) {
    this.database = new DatabaseSync(databaseFile);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 5) throw new Error("Single Owner schema is not installed");
  }

  active(): OwnerBinding | null {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT * FROM collaboration_owner_bindings WHERE active = 1")
      .get() as OwnerRow | undefined;
    return row ? rowToBinding(row) : null;
  }

  bootstrap(input: { senderCorpId: string; senderStaffId: string; now?: number }): OwnerBinding {
    this.assertOpen();
    const senderCorpId = stableId(input.senderCorpId, "senderCorpId");
    const senderStaffId = stableId(input.senderStaffId, "senderStaffId");
    const now = input.now ?? Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const count = this.database.prepare("SELECT count(*) AS count FROM collaboration_owner_bindings").get() as {
        count: number;
      };
      if (count.count !== 0) throw new Error("Owner bootstrap has already been used; use local recovery");
      const id = randomUUID();
      this.database
        .prepare(
          "INSERT INTO collaboration_owner_bindings " +
            "(id, source, sender_corp_id, sender_staff_id, generation, active, created_at) " +
            "VALUES (?, 'dingtalk', ?, ?, 1, 1, ?)",
        )
        .run(id, senderCorpId, senderStaffId, now);
      appendControlAudit(this.database, {
        requestId: randomUUID(),
        action: "owner.bootstrap",
        outcome: "allow",
        policyRule: "local-owner-bootstrap-v1",
        resource: { identityHash: identityHash(senderCorpId, senderStaffId), generation: 1 },
        afterHash: identityHash(senderCorpId, senderStaffId),
        now,
      });
      this.database.exec("COMMIT");
      return {
        id,
        source: "dingtalk",
        senderCorpId,
        senderStaffId,
        generation: 1,
        active: true,
        createdAt: now,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recover(input: {
    expectedGeneration: number;
    senderCorpId: string;
    senderStaffId: string;
    now?: number;
  }): OwnerBinding {
    this.assertOpen();
    if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
      throw new Error("expectedGeneration must be a positive integer");
    }
    const senderCorpId = stableId(input.senderCorpId, "senderCorpId");
    const senderStaffId = stableId(input.senderStaffId, "senderStaffId");
    const now = input.now ?? Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database
        .prepare("SELECT * FROM collaboration_owner_bindings WHERE active = 1")
        .get() as OwnerRow | undefined;
      if (!current) throw new Error("No active Owner exists; local recovery cannot proceed");
      if (current.generation !== input.expectedGeneration) throw new Error("Owner generation changed during recovery");
      if (current.sender_corp_id === senderCorpId && current.sender_staff_id === senderStaffId) {
        throw new Error("Recovery must bind a different stable DingTalk identity");
      }
      const revoked = this.database
        .prepare("UPDATE collaboration_owner_bindings SET active = 0, revoked_at = ? WHERE id = ? AND active = 1")
        .run(now, current.id);
      if (Number(revoked.changes) !== 1) throw new Error("Active Owner changed during recovery");
      const generation = current.generation + 1;
      const id = randomUUID();
      this.database
        .prepare(
          "INSERT INTO collaboration_owner_bindings " +
            "(id, source, sender_corp_id, sender_staff_id, generation, active, created_at) " +
            "VALUES (?, 'dingtalk', ?, ?, ?, 1, ?)",
        )
        .run(id, senderCorpId, senderStaffId, generation, now);
      appendControlAudit(this.database, {
        requestId: randomUUID(),
        action: "owner.recover",
        outcome: "allow",
        policyRule: "local-owner-recovery-v1",
        resource: {
          previousGeneration: current.generation,
          generation,
          identityHash: identityHash(senderCorpId, senderStaffId),
        },
        beforeHash: identityHash(current.sender_corp_id, current.sender_staff_id),
        afterHash: identityHash(senderCorpId, senderStaffId),
        now,
      });
      this.database.exec("COMMIT");
      return {
        id,
        source: "dingtalk",
        senderCorpId,
        senderStaffId,
        generation,
        active: true,
        createdAt: now,
      };
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

  private assertOpen(): void {
    if (this.closed) throw new Error("Owner registry is closed");
  }
}
