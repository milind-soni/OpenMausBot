import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./db.ts";
import { LocalOwnerRegistry } from "./owner.ts";
import { evaluateOwnerPolicy, type OwnerCapability } from "./policy.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function ledger(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-owner-"));
  scratch.push(directory);
  const opened = openCollaborationLedger(directory);
  const file = opened.filePath;
  opened.close();
  return file;
}

describe("single local Owner binding", () => {
  it("allows only one bootstrap and fences competing recovery generations", () => {
    const file = ledger();
    const first = new LocalOwnerRegistry(file);
    const second = new LocalOwnerRegistry(file);
    expect(first.bootstrap({ senderCorpId: "corp-1", senderStaffId: "owner-1", now: 1_000 })).toMatchObject({
      generation: 1,
      active: true,
    });
    expect(() =>
      second.bootstrap({ senderCorpId: "corp-1", senderStaffId: "other", now: 1_001 }),
    ).toThrow("already been used");
    expect(first.recover({
      expectedGeneration: 1,
      senderCorpId: "corp-1",
      senderStaffId: "owner-2",
      now: 2_000,
    })).toMatchObject({ generation: 2, senderStaffId: "owner-2", active: true });
    expect(() =>
      second.recover({
        expectedGeneration: 1,
        senderCorpId: "corp-1",
        senderStaffId: "owner-3",
        now: 2_001,
      }),
    ).toThrow("generation changed");
    first.close();
    second.close();

    const database = new DatabaseSync(file);
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_owner_bindings WHERE active = 1").get()).toEqual({
      count: 1,
    });
    expect(database.prepare("SELECT generation, active FROM collaboration_owner_bindings ORDER BY generation").all()).toEqual([
      { generation: 1, active: 0 },
      { generation: 2, active: 1 },
    ]);
    expect(() =>
      database
        .prepare(
          "INSERT INTO collaboration_owner_bindings " +
            "(id, source, sender_corp_id, sender_staff_id, generation, active, created_at) " +
            "VALUES ('forged', 'dingtalk', 'corp-2', 'staff-2', 3, 1, 3000)",
        )
        .run(),
    ).toThrow();
    database.close();
  });

  it("authorizes admin capability only by the current stable corp+staff identity", () => {
    const file = ledger();
    const registry = new LocalOwnerRegistry(file);
    registry.bootstrap({ senderCorpId: "corp-1", senderStaffId: "owner-1", now: 1_000 });
    registry.close();
    const database = new DatabaseSync(file);
    database.exec("PRAGMA foreign_keys = ON");
    const capabilities: OwnerCapability[] = [
      "control.consume",
      "work.pause",
      "work.resume",
      "work.retry",
      "work.cancel",
      "candidate.accept",
      "candidate.reject",
      "system.admin",
    ];
    for (const capability of capabilities) {
      expect(evaluateOwnerPolicy(database, {
        sender: {
          senderCorpId: "corp-1",
          senderStaffId: "owner-1",
          senderId: "mutable-sender-id",
          displayName: "Any display name",
        },
        capability,
        now: 2_000,
      })).toMatchObject({ decision: "allow", reason: "owner_authorized", ownerGeneration: 1, capability });
    }

    const sameSenderId = evaluateOwnerPolicy(database, {
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "not-owner",
        senderId: "mutable-sender-id",
        displayName: "Owner",
      },
      capability: "system.admin",
      now: 2_001,
    });
    expect(sameSenderId).toMatchObject({ decision: "deny", reason: "not_active_owner" });

    const unresolved = evaluateOwnerPolicy(database, {
      sender: { senderId: "owner-1", displayName: "Owner" },
      capability: "system.admin",
      now: 2_002,
    });
    expect(unresolved).toMatchObject({ decision: "deny", reason: "stable_identity_required" });
    database.close();
  });
});
