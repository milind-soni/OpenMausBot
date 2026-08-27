import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDingTalkAdapter } from "../integrations/dingtalk/fake-adapter.ts";
import type { DingTalkInboundMessage } from "../integrations/dingtalk/types.ts";
import { canControlWorkItem } from "./identity.ts";
import { startCollaborationService } from "./service.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-inbound-"));
  scratch.push(directory);
  return directory;
}

function message(overrides: Partial<DingTalkInboundMessage> = {}): DingTalkInboundMessage {
  return {
    sourceEventId: "event-1",
    transportMessageId: "transport-1",
    conversationId: "conversation-1",
    addressedToBot: true,
    text: "修复登录失败提示",
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "staff-1",
      senderId: "sender-1",
      displayName: "Contributor One",
    },
    receivedAt: 1_000,
    ...overrides,
  };
}

function database(directory: string): DatabaseSync {
  return new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
}

function scalar(db: DatabaseSync, table: string): number {
  const allowed = new Set([
    "collaboration_principals",
    "collaboration_external_events",
    "collaboration_work_items",
    "collaboration_work_item_events",
    "collaboration_association_options",
    "collaboration_outbox",
  ]);
  if (!allowed.has(table)) throw new Error("Unexpected test table");
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("fake DingTalk Work Item ingress", () => {
  it("creates one durable Work Item and received-only primary status acknowledgement", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));

    const result = adapter.receive(message());
    expect(result).toMatchObject({
      accepted: true,
      duplicate: false,
      sourceEventId: "event-1",
      transportMessageId: "transport-1",
      principalResolution: "resolved",
      association: "created",
      card: { type: "primary_status_card", headline: "已接收", association: "created", workItemVersion: 1 },
    });
    if (!result.accepted) throw new Error("Expected accepted result");
    expect(result.workItemId).toMatch(/^WI-[A-F0-9]{12}$/u);
    expect(result.card.acknowledgement).toContain("不表示系统已经理解、执行或完成任务");
    expect(service.pendingOutbox()).toHaveLength(1);
    expect(service.pendingOutbox()[0]).toMatchObject({
      id: result.outboxId,
      sourceEventId: "event-1",
      aggregateType: "work_item",
      aggregateId: result.workItemId,
      aggregateVersion: 1,
      kind: "primary_status_card",
    });
    service.close();

    const db = database(directory);
    expect(scalar(db, "collaboration_principals")).toBe(1);
    expect(scalar(db, "collaboration_external_events")).toBe(1);
    expect(scalar(db, "collaboration_work_items")).toBe(1);
    expect(scalar(db, "collaboration_work_item_events")).toBe(1);
    expect(scalar(db, "collaboration_outbox")).toBe(1);
    db.close();
  });

  it("deduplicates business event IDs independently from transport delivery IDs", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    const first = adapter.receive(message());
    const replay = adapter.receive(message({ transportMessageId: "transport-redelivery", receivedAt: 2_000 }));
    expect(replay).toMatchObject({
      accepted: true,
      duplicate: true,
      transportMessageId: "transport-1",
      workItemId: first.accepted ? first.workItemId : null,
      outboxId: first.accepted ? first.outboxId : "",
    });
    expect(service.pendingOutbox()).toHaveLength(1);
    service.close();

    const db = database(directory);
    expect(scalar(db, "collaboration_external_events")).toBe(1);
    expect(scalar(db, "collaboration_work_items")).toBe(1);
    expect(scalar(db, "collaboration_work_item_events")).toBe(1);
    expect(scalar(db, "collaboration_outbox")).toBe(1);
    db.close();
  });

  it("deterministically supplements an explicitly referenced Work Item", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    const first = adapter.receive(message());
    if (!first.accepted || !first.workItemId) throw new Error("Expected created Work Item");

    const second = adapter.receive(
      message({
        sourceEventId: "event-2",
        transportMessageId: "transport-2",
        text: `${first.workItemId} 补充验收条件：错误信息可操作`,
        receivedAt: 2_000,
      }),
    );
    expect(second).toMatchObject({
      accepted: true,
      duplicate: false,
      association: "associated",
      workItemId: first.workItemId,
      card: { type: "primary_status_card", association: "associated", workItemVersion: 2 },
    });
    service.close();

    const db = database(directory);
    expect(scalar(db, "collaboration_work_items")).toBe(1);
    expect(scalar(db, "collaboration_work_item_events")).toBe(2);
    expect(db.prepare("SELECT version FROM collaboration_work_items WHERE id = ?").get(first.workItemId)).toEqual({
      version: 2,
    });
    db.close();
  });

  it("uses an unambiguous reply chain to supplement the original Work Item", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    const first = adapter.receive(message());
    if (!first.accepted) throw new Error("Expected accepted message");
    const reply = adapter.receive(
      message({
        sourceEventId: "event-reply",
        transportMessageId: "transport-reply",
        replyToSourceEventId: "event-1",
        text: "补充复现：空 token 时发生",
      }),
    );
    expect(reply).toMatchObject({ accepted: true, association: "associated", workItemId: first.workItemId });
    service.close();
  });

  it("persists ambiguity and choices without guessing or mutating candidate Work Items", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    const first = adapter.receive(message());
    const second = adapter.receive(
      message({ sourceEventId: "event-2", transportMessageId: "transport-2", text: "另一个独立问题" }),
    );
    if (!first.accepted || !second.accepted || !first.workItemId || !second.workItemId) {
      throw new Error("Expected two Work Items");
    }
    const ambiguous = adapter.receive(
      message({
        sourceEventId: "event-3",
        transportMessageId: "transport-3",
        replyToSourceEventId: "missing-parent",
        text: "这个还需要增加一条验收条件",
      }),
    );
    expect(ambiguous).toMatchObject({
      accepted: true,
      association: "ambiguous",
      workItemId: null,
      card: { type: "association_choice_card" },
    });
    if (!ambiguous.accepted || ambiguous.card.type !== "association_choice_card") {
      throw new Error("Expected association choice card");
    }
    expect(new Set(ambiguous.card.candidateWorkItemIds)).toEqual(new Set([first.workItemId, second.workItemId]));
    service.close();

    const db = database(directory);
    expect(scalar(db, "collaboration_work_items")).toBe(2);
    expect(scalar(db, "collaboration_work_item_events")).toBe(2);
    expect(scalar(db, "collaboration_association_options")).toBe(2);
    expect(db.prepare("SELECT id, version FROM collaboration_work_items ORDER BY id").all()).toEqual(
      [first.workItemId, second.workItemId].sort().map((id) => ({ id, version: 1 })),
    );
    db.close();
  });

  it("keeps unresolved contributors unprivileged and upgrades aliases deterministically", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    const unresolved = adapter.receive(
      message({ sender: { senderCorpId: "corp-1", senderId: "external-1", displayName: "External" } }),
    );
    expect(unresolved).toMatchObject({ accepted: true, principalResolution: "unresolved" });
    if (!unresolved.accepted) throw new Error("Expected accepted message");
    expect(
      canControlWorkItem({
        id: unresolved.principalId,
        resolution: "unresolved",
        displayName: "External",
        controlCapabilities: [],
      }),
    ).toBe(false);

    const upgraded = adapter.receive(
      message({
        sourceEventId: "event-2",
        transportMessageId: "transport-2",
        text: `${unresolved.workItemId} 补充身份后信息`,
        sender: {
          senderCorpId: "corp-1",
          senderStaffId: "staff-external-1",
          senderId: "external-1",
          displayName: "External Resolved",
        },
      }),
    );
    expect(upgraded).toMatchObject({
      accepted: true,
      principalId: unresolved.principalId,
      principalResolution: "resolved",
    });
    service.close();
  });

  it("does not persist anything when the fake transport message is not explicitly addressed", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    expect(adapter.receive(message({ addressedToBot: false }))).toEqual({ accepted: false, reason: "not_addressed" });
    expect(service.pendingOutbox()).toEqual([]);
    service.close();
    const db = database(directory);
    expect(scalar(db, "collaboration_external_events")).toBe(0);
    expect(scalar(db, "collaboration_work_items")).toBe(0);
    db.close();
  });

  it("rolls back identity, Work Item, event and state when outbox persistence fails", () => {
    const directory = temporaryDirectory();
    const service = startCollaborationService({ dataDirectory: directory });
    const db = database(directory);
    db.exec(`
      CREATE TRIGGER reject_test_outbox
      BEFORE INSERT ON collaboration_outbox
      BEGIN
        SELECT RAISE(ABORT, 'test outbox unavailable');
      END;
    `);
    db.close();
    const adapter = new FakeDingTalkAdapter((event) => service.ingestDingTalkMessage(event));
    expect(() => adapter.receive(message())).toThrow("test outbox unavailable");
    service.close();

    const after = database(directory);
    expect(scalar(after, "collaboration_principals")).toBe(0);
    expect(scalar(after, "collaboration_external_events")).toBe(0);
    expect(scalar(after, "collaboration_work_items")).toBe(0);
    expect(scalar(after, "collaboration_work_item_events")).toBe(0);
    expect(scalar(after, "collaboration_outbox")).toBe(0);
    after.close();
  });
});
