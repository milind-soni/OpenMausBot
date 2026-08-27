import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DingTalkSender } from "../integrations/dingtalk/types.ts";

export type PrincipalResolution = "resolved" | "unresolved";

export interface PrincipalIdentity {
  id: string;
  resolution: PrincipalResolution;
  displayName: string;
  controlCapabilities: readonly [];
}

interface PrincipalRow {
  id: string;
  resolution: PrincipalResolution;
  display_name: string;
}

function aliasPrincipal(
  database: DatabaseSync,
  aliasKind: "corp_staff" | "sender_id",
  scopeId: string,
  externalId: string,
): PrincipalRow | undefined {
  return database
    .prepare(
      "SELECT p.id, p.resolution, p.display_name " +
        "FROM collaboration_principal_aliases a " +
        "JOIN collaboration_principals p ON p.id = a.principal_id " +
        "WHERE a.source = 'dingtalk' AND a.alias_kind = ? AND a.scope_id = ? AND a.external_id = ?",
    )
    .get(aliasKind, scopeId, externalId) as PrincipalRow | undefined;
}

function identity(row: PrincipalRow): PrincipalIdentity {
  return { id: row.id, resolution: row.resolution, displayName: row.display_name, controlCapabilities: [] };
}

function insertAlias(
  database: DatabaseSync,
  principalId: string,
  aliasKind: "corp_staff" | "sender_id",
  scopeId: string,
  externalId: string,
  now: number,
): void {
  database
    .prepare(
      "INSERT INTO collaboration_principal_aliases " +
        "(source, alias_kind, scope_id, external_id, principal_id, created_at) VALUES ('dingtalk', ?, ?, ?, ?, ?)",
    )
    .run(aliasKind, scopeId, externalId, principalId, now);
}

export function resolveDingTalkPrincipal(database: DatabaseSync, sender: DingTalkSender, now: number): PrincipalIdentity {
  const corpId = sender.senderCorpId?.trim() ?? "";
  const staffId = sender.senderStaffId?.trim() ?? "";
  const senderId = sender.senderId.trim();
  const displayName = sender.displayName.trim().slice(0, 160) || "Unknown DingTalk member";
  if (!senderId) throw new Error("DingTalk senderId is required");

  const staffPrincipal = corpId && staffId ? aliasPrincipal(database, "corp_staff", corpId, staffId) : undefined;
  const senderPrincipal =
    aliasPrincipal(database, "sender_id", corpId, senderId) ??
    (corpId ? aliasPrincipal(database, "sender_id", "", senderId) : undefined);
  if (staffPrincipal && senderPrincipal && staffPrincipal.id !== senderPrincipal.id) {
    throw new Error("DingTalk identity aliases resolve to different principals");
  }

  const existing = staffPrincipal ?? senderPrincipal;
  if (existing) {
    const resolution: PrincipalResolution = corpId && staffId ? "resolved" : existing.resolution;
    database
      .prepare("UPDATE collaboration_principals SET resolution = ?, display_name = ?, updated_at = ? WHERE id = ?")
      .run(resolution, displayName, now, existing.id);
    if (corpId && staffId && !staffPrincipal) {
      insertAlias(database, existing.id, "corp_staff", corpId, staffId, now);
    }
    if (!senderPrincipal) insertAlias(database, existing.id, "sender_id", corpId, senderId, now);
    return { id: existing.id, resolution, displayName, controlCapabilities: [] };
  }

  const id = randomUUID();
  const resolution: PrincipalResolution = corpId && staffId ? "resolved" : "unresolved";
  database
    .prepare(
      "INSERT INTO collaboration_principals (id, source, resolution, display_name, created_at, updated_at) " +
        "VALUES (?, 'dingtalk', ?, ?, ?, ?)",
    )
    .run(id, resolution, displayName, now, now);
  if (corpId && staffId) insertAlias(database, id, "corp_staff", corpId, staffId, now);
  insertAlias(database, id, "sender_id", corpId, senderId, now);
  return identity({ id, resolution, display_name: displayName });
}

/** Ticket 005 adds the sole Owner capability. Ingress principals are never privileged. */
export function canControlWorkItem(principal: PrincipalIdentity): boolean {
  return principal.controlCapabilities.length > 0;
}
