import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { importConnectedSourceExports } from "./capture-backfill.ts";
import { CaptureMemory } from "./capture-memory.ts";

const dirs: string[] = [];
const memories: CaptureMemory[] = [];

afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("connected source backfill", () => {
  it("imports explicit connector exports, redacts content, and reruns idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-connected-backfill-"));
    dirs.push(dir);
    const file = join(dir, "gmail.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, records: [{
      sourceId: "gmail-account-1",
      accountId: "work",
      externalId: "message-1",
      kind: "email",
      title: "Vendor update",
      body: "Authorization: Bearer abcdefghijklmnop1234",
      occurredAt: 100,
      sensitivity: "sensitive",
      evidenceRef: "https://mail.google.com/message/1",
    }] }));
    const memory = new CaptureMemory({ file: join(dir, "capture.db"), now: () => 200 });
    memories.push(memory);

    const first = importConnectedSourceExports({ memory, files: [file], botId: "chief", sectionId: "ops", capturedAt: 200 });
    const second = importConnectedSourceExports({ memory, files: [file], botId: "chief", sectionId: "ops", capturedAt: 300 });
    expect(first).toMatchObject({ filesRead: 1, recordsSeen: 1, inserted: 1 });
    expect(second).toMatchObject({ filesRead: 1, recordsSeen: 1, deduplicated: 1 });
    const [result] = memory.search({ botId: "chief", includeSensitive: true });
    expect(result?.item.sourceId).toBe("gmail-account-1");
    expect(result?.item.accountId).toBe("work");
    expect(result?.item.body).toContain("«redacted");
    expect(result?.provenance.evidenceRef).toBe("https://mail.google.com/message/1");
  });

  it("supports line-delimited connector records and rejects local corpus ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-connected-ndjson-"));
    dirs.push(dir);
    const file = join(dir, "export.ndjson");
    writeFileSync(file, [
      JSON.stringify({ sourceId: "github", externalId: "issue-1", kind: "issue", title: "One", occurredAt: 1 }),
      JSON.stringify({ sourceId: "grok-corpus", externalId: "bad", kind: "message", title: "Do not import", occurredAt: 2 }),
    ].join("\n"));
    const memory = new CaptureMemory({ file: join(dir, "capture.db") });
    memories.push(memory);
    const result = importConnectedSourceExports({ memory, files: [file], botId: "chief", sectionId: "ops" });
    expect(result).toMatchObject({ recordsSeen: 2, inserted: 1, skippedRecords: 1 });
    expect(memory.search({ botId: "chief", includeSensitive: true })).toHaveLength(1);
  });

  it("is safe to dry-run without changing memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-connected-dry-run-"));
    dirs.push(dir);
    const file = join(dir, "calendar.json");
    writeFileSync(file, JSON.stringify([{ sourceId: "googlecalendar-account-1", kind: "event", title: "Planning", occurredAt: 1 }]));
    const memory = new CaptureMemory({ file: join(dir, "capture.db") });
    memories.push(memory);
    expect(importConnectedSourceExports({ memory, files: [file], botId: "chief", sectionId: "ops", dryRun: true })).toMatchObject({ recordsSeen: 1, inserted: 0 });
    expect(memory.statistics().activeItems).toBe(0);
  });
});
