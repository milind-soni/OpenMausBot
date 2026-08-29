import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CaptureMemory } from "./capture-memory.ts";

const dirs: string[] = [];
const memories: CaptureMemory[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-capture-memory-"));
  dirs.push(dir);
  let now = 1_756_000_000_000;
  const file = join(dir, "capture.db");
  const memory = new CaptureMemory({ file, now: () => now });
  memories.push(memory);
  return { memory, file, setNow: (value: number) => { now = value; } };
}

afterEach(() => {
  for (const memory of memories.splice(0)) {
    try { memory.close(); } catch { /* already closed by the test */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const item = (overrides: Record<string, unknown> = {}) => ({
  botId: "chief",
  sectionId: "work",
  sourceId: "gmail-account-1",
  accountId: "shane@example.com",
  externalId: "gmail:message-1",
  kind: "email",
  title: "Project launch",
  body: "The project launch is on Friday.",
  occurredAt: 1_756_000_000_000,
  sensitivity: "internal" as const,
  evidenceRef: "https://mail.google.com/#inbox/1",
  payloadRef: "vault://capture/1",
  metadata: { label: "inbox" },
  ...overrides,
});

describe("CaptureMemory", () => {
  it("normalizes, deduplicates, updates, and preserves a stable id across restarts", () => {
    const h = harness();
    const first = h.memory.upsert(item({ title: "  Project launch  " }));
    expect(first.status).toBe("inserted");
    expect(first.item.title).toBe("Project launch");
    const duplicate = h.memory.upsert(item({ title: "Project launch" }));
    expect(duplicate.status).toBe("deduplicated");
    expect(duplicate.item.eventId).toBe(first.item.eventId);
    const updated = h.memory.upsert(item({ body: "The project launch moved to Monday." }));
    expect(updated.status).toBe("updated");
    expect(updated.item.eventId).toBe(first.item.eventId);
    expect(updated.item.body).toContain("Monday");
    h.memory.close();

    const reloaded = new CaptureMemory({ file: h.file });
    expect(reloaded.get(first.item.eventId)?.body).toContain("Monday");
    reloaded.close();
  });

  it("namespaces an explicit provider event id so another bot cannot overwrite it", () => {
    const h = harness();
    const first = h.memory.upsert(item({ eventId: "provider-event-1", botId: "capture-a", title: "A" }));
    const second = h.memory.upsert(item({ eventId: "provider-event-1", botId: "capture-b", title: "B" }));
    expect(first.item.eventId).not.toBe(second.item.eventId);
    expect(h.memory.get(first.item.eventId)?.botId).toBe("capture-a");
    expect(h.memory.get(second.item.eventId)?.botId).toBe("capture-b");
    h.memory.close();
  });

  it("searches FTS with source/account/time filters and returns provenance", () => {
    const h = harness();
    h.memory.upsert(item());
    h.memory.upsert(item({
      externalId: "gmail:message-2",
      title: "Unrelated note",
      body: "A different thing.",
      occurredAt: 1_756_100_000_000,
      accountId: "other@example.com",
    }));
    const results = h.memory.search({
      query: "launch Friday",
      sourceId: "gmail-account-1",
      accountId: "shane@example.com",
      since: 1_755_000_000_000,
      until: 1_756_050_000_000,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.item.title).toBe("Project launch");
    expect(results[0]?.provenance).toEqual(expect.objectContaining({
      sourceId: "gmail-account-1",
      accountId: "shane@example.com",
      evidenceRef: "https://mail.google.com/#inbox/1",
      payloadRef: "vault://capture/1",
    }));
    h.memory.close();
  });

  it("keeps sensitive records out of default and Chief section retrieval", () => {
    const h = harness();
    h.memory.upsert(item({ sensitivity: "sensitive", externalId: "private-1", title: "Private launch detail" }));
    h.memory.upsert(item({ sensitivity: "internal", externalId: "work-1", title: "Work launch detail" }));
    expect(h.memory.search({ query: "launch", sectionId: "work" }).map((result) => result.item.title))
      .toEqual(["Work launch detail"]);
    expect(h.memory.searchForChief("work", { query: "launch" }).map((result) => result.item.title))
      .toEqual(["Work launch detail"]);
    expect(h.memory.search({ query: "launch", includeSensitive: true }).map((result) => result.item.title))
      .toEqual(["Work launch detail", "Private launch detail"]);
    h.memory.close();
  });

  it("retains correction tombstones and hides the corrected source row", () => {
    const h = harness();
    const original = h.memory.upsert(item({ title: "Meeting on Friday" }));
    const correction = h.memory.correct(original.item.eventId, item({
      title: "Meeting on Monday",
      body: "Correction: the meeting is on Monday.",
    }), "Source calendar corrected the date");
    expect(correction.targetEventId).toBe(original.item.eventId);
    expect(h.memory.get(original.item.eventId)?.state).toBe("tombstone");
    expect(h.memory.tombstoneFor(original.item.eventId)).toEqual(expect.objectContaining({
      replacementEventId: correction.replacementEventId,
      reason: "Source calendar corrected the date",
    }));
    expect(h.memory.search({ query: "meeting", includeSensitive: true }).map((result) => result.item.title))
      .toEqual(["Meeting on Monday"]);
    const ignored = h.memory.upsert(item({ title: "Meeting on Friday" }));
    expect(ignored.status).toBe("ignored-tombstone");
    expect(ignored.item.state).toBe("tombstone");
    h.memory.close();
  });

  it("supports explicit tombstones without deleting the audit row", () => {
    const h = harness();
    const created = h.memory.upsert(item({ externalId: "remove-1", title: "Remove me" }));
    const tombstone = h.memory.tombstone(created.item.eventId, "Duplicate source record");
    expect(tombstone.replacementEventId).toBeNull();
    expect(h.memory.get(created.item.eventId)?.state).toBe("tombstone");
    expect(h.memory.search({ query: "Remove", includeSensitive: true })).toHaveLength(0);
    h.memory.close();
  });

  it("reports aggregate operational statistics without message bodies", () => {
    const h = harness();
    h.memory.upsert(item({ title: "Internal", sensitivity: "internal", sourceId: "gmail" }));
    h.memory.upsert(item({ externalId: "sensitive", title: "Private", sensitivity: "sensitive", sourceId: "messages" }));
    const stats = h.memory.statistics();
    expect(stats).toMatchObject({ activeItems: 2, tombstones: 0, sensitiveItems: 1 });
    expect(stats.bySource).toEqual(expect.arrayContaining([
      { sourceId: "gmail", count: 1 },
      { sourceId: "messages", count: 1 },
    ]));
    expect(JSON.stringify(stats)).not.toContain("Private");
    h.memory.close();
  });
});
