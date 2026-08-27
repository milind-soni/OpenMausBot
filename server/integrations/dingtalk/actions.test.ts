import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { PerformOwnerActionInput } from "../../collaboration/actions.ts";
import { OwnerCardActionBridge } from "./actions.ts";
import { DingTalkCardActionLedger } from "./action-ledger.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Owner card action bridge", () => {
  it("re-authorizes with current stable sender and does not forward card privilege claims", () => {
    let captured: PerformOwnerActionInput | undefined;
    const bridge = new OwnerCardActionBridge((input) => {
      captured = input;
      return {
        allowed: false,
        duplicate: false,
        action: null,
        workItemId: null,
        workItemVersion: null,
        controlState: null,
        candidateSha: null,
        reason: "not_owner",
        revisedSnapshotRevision: null,
        interruptRequestedRunIds: [],
      };
    });
    bridge.perform({
      transportEventId: "event-1",
      transportMessageId: "transport-1",
      actionToken: "opaque-token",
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "staff-1",
        senderId: "mutable-sender",
        displayName: "Claimed admin",
      },
      reason: "reject reason",
      receivedAt: 1_000,
    });
    expect(captured).toEqual({
      actionToken: "opaque-token",
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "staff-1",
        senderId: "mutable-sender",
        displayName: "Claimed admin",
      },
      reason: "reject reason",
      now: 1_000,
    });
    expect(captured).not.toHaveProperty("transportEventId");
    expect(captured).not.toHaveProperty("action");
    expect(captured).not.toHaveProperty("role");
  });

  it("deduplicates by durable Stream event identity without storing or trusting card claims", () => {
    const directory = mkdtempSync(join(tmpdir(), "dingtalk-action-ledger-"));
    scratch.push(directory);
    const filePath = join(directory, "actions.sqlite");
    const ledger = new DingTalkCardActionLedger(filePath);
    let calls = 0;
    const bridge = new OwnerCardActionBridge(() => {
      calls += 1;
      return {
        allowed: true,
        duplicate: false,
        action: "pause",
        workItemId: "WI-1",
        workItemVersion: 2,
        controlState: "paused",
        candidateSha: null,
        reason: "allowed",
        revisedSnapshotRevision: null,
        interruptRequestedRunIds: [],
      };
    }, ledger);
    const action = {
      transportEventId: "event-1",
      transportMessageId: "transport-1",
      actionToken: "opaque-token",
      sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1", displayName: "Owner" },
      receivedAt: 1_000,
    };
    expect(bridge.perform(action)).toMatchObject({ allowed: true, duplicate: false });
    expect(bridge.perform(action)).toMatchObject({ allowed: true, duplicate: true });
    expect(calls).toBe(1);
    expect(() => bridge.perform({ ...action, actionToken: "different-token" })).toThrow("dingtalk_action_event_conflict");
    ledger.close();
    const database = new DatabaseSync(filePath, { readOnly: true });
    const stored = database.prepare("SELECT payload_hash, outcome_json FROM dingtalk_card_action_events").get() as {
      payload_hash: string;
      outcome_json: string;
    };
    expect(stored.payload_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain("opaque-token");
    database.close();
  });
});
