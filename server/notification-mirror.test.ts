import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CaptureMemory } from "./capture-memory.ts";
import {
  ingestNotificationMirror,
  readNotificationMirror,
  recordNotificationMirrorHeartbeat,
} from "./notification-mirror.ts";

const dirs: string[] = [];
const memories: CaptureMemory[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-notification-mirror-"));
  dirs.push(dir);
  const memory = new CaptureMemory({ file: join(dir, "capture.db"), now: () => 1_756_000_000_000 });
  memories.push(memory);
  return memory;
}

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "messages-1",
  packageName: "com.google.android.apps.messaging",
  postedAt: 1_756_000_000_000,
  title: "Alex",
  text: "Can you call me?",
  conversationTitle: "Alex",
  sender: "Alex",
  ...overrides,
});

afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("notification mirror ingestion", () => {
  it("rejects malformed, oversized, unknown-source, and unknown-field events", () => {
    const memory = harness();
    expect(ingestNotificationMirror(memory, "phone-1", { ...event(), text: "x".repeat(8_001) }, { botId: "chief", sectionId: "work" })).toEqual({
      ok: false,
      error: "invalid notification mirror event",
    });
    expect(ingestNotificationMirror(memory, "phone-1", { ...event(), packageName: "com.example.messages" }, { botId: "chief", sectionId: "work" })).toEqual({
      ok: false,
      error: "invalid notification mirror event",
    });
    expect(ingestNotificationMirror(memory, "phone-1", { ...event(), sourceId: "gmail" }, { botId: "chief", sectionId: "work" })).toEqual({
      ok: false,
      error: "invalid notification mirror event",
    });
    expect(ingestNotificationMirror(memory, "phone-1", { ...event(), unknown: true }, { botId: "chief", sectionId: "work" })).toEqual({
      ok: false,
      error: "invalid notification mirror event",
    });
    expect(ingestNotificationMirror(memory, "not a device", event(), { botId: "chief", sectionId: "work" })).toEqual({
      ok: false,
      error: "invalid paired device",
    });
  });

  it("deduplicates the same device event and updates its changed text", () => {
    const memory = harness();
    const first = ingestNotificationMirror(memory, "phone-1", event(), { botId: "chief", sectionId: "work" });
    const duplicate = ingestNotificationMirror(memory, "phone-1", event(), { botId: "chief", sectionId: "work" });
    const updated = ingestNotificationMirror(memory, "phone-1", event({ text: "Actually, call tomorrow." }), { botId: "chief", sectionId: "work" });
    expect(first).toEqual({ ok: true, result: { status: "inserted" } });
    expect(duplicate).toEqual({ ok: true, result: { status: "deduplicated" } });
    expect(updated).toEqual({ ok: true, result: { status: "updated" } });
    const messages = memory.search({ includeSensitive: true, kind: "message-notification" });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.item.body).toBe("Actually, call tomorrow.");
    expect(messages[0]?.item.sensitivity).toBe("sensitive");
  });

  it("accepts a text-only visible notification and supplies a stable local title", () => {
    const memory = harness();
    expect(ingestNotificationMirror(memory, "phone-1", event({ title: "" }), { botId: "chief", sectionId: "work" }))
      .toEqual({ ok: true, result: { status: "inserted" } });
    expect(memory.search({ includeSensitive: true, kind: "message-notification" })[0]?.item.title).toBe("Alex");
  });

  it("keeps identical provider ids separate for different paired devices", () => {
    const memory = harness();
    ingestNotificationMirror(memory, "phone-1", event(), { botId: "chief", sectionId: "work" });
    ingestNotificationMirror(memory, "phone-2", event(), { botId: "chief", sectionId: "work" });
    const records = memory.search({ includeSensitive: true, kind: "message-notification" });
    expect(records).toHaveLength(2);
    expect(new Set(records.map(({ item }) => item.accountId))).toEqual(new Set(["phone:phone-1", "phone:phone-2"]));
  });

  it("requires a heartbeat, then returns only message notifications delta-only", () => {
    const memory = harness();
    expect(readNotificationMirror(memory, { botId: "chief", sectionId: "work", now: 1_756_000_000_000 })).toMatchObject({
      status: "needs-auth",
      heartbeat: { status: "missing", deviceCount: 0 },
      items: [],
    });
    recordNotificationMirrorHeartbeat(memory, "phone-1", {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_000,
    });
    ingestNotificationMirror(memory, "phone-1", event(), {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_001,
    });
    ingestNotificationMirror(memory, "phone-1", event({ id: "messages-2", postedAt: 1_756_000_000_003, text: "I am on my way." }), {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_003,
    });
    // A different source-shaped row cannot leak through the source-specific
    // kind/account filters used by the mirror reader.
    memory.upsert({
      botId: "chief",
      sectionId: "work",
      sourceId: "google-messages",
      kind: "browser-receipt",
      title: "browser only",
      body: "do not return",
      occurredAt: 1_756_000_000_002,
      sensitivity: "sensitive",
    });
    const first = readNotificationMirror(memory, { botId: "chief", sectionId: "work", now: 1_756_000_000_010 });
    expect(first.status).toBe("ok");
    expect(first.items).toHaveLength(2);
    expect(first.items.map(({ item }) => item.body)).toEqual(["Can you call me?", "I am on my way."]);
    expect(first.items[0]?.provenance.sensitivity).toBe("sensitive");
    const second = readNotificationMirror(memory, {
      botId: "chief",
      sectionId: "work",
      cursor: first.cursor,
      now: 1_756_000_000_010,
    });
    expect(second.status).toBe("empty");
    expect(second.items).toEqual([]);
  });

  it("reports a stale heartbeat instead of pretending a quiet phone is empty", () => {
    const memory = harness();
    recordNotificationMirrorHeartbeat(memory, "phone-1", {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_000,
    });
    expect(readNotificationMirror(memory, {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_000 + 20 * 60_000 + 1,
    })).toMatchObject({
      status: "needs-auth",
      heartbeat: { status: "stale", deviceCount: 1 },
      items: [],
    });
  });

  it("advances a bounded cursor oldest-first without replaying newer messages", () => {
    const memory = harness();
    ingestNotificationMirror(memory, "phone-1", event({ id: "first", postedAt: 1_755_999_999_000, text: "First" }), {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_000,
    });
    ingestNotificationMirror(memory, "phone-1", event({ id: "second", postedAt: 1_755_999_999_500, text: "Second" }), {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_000,
    });
    const first = readNotificationMirror(memory, { botId: "chief", sectionId: "work", now: 1_756_000_000_010, limit: 1 });
    expect(first.items.map(({ item }) => item.body)).toEqual(["First"]);
    const second = readNotificationMirror(memory, {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_010,
      cursor: first.cursor,
      limit: 1,
    });
    expect(second.items.map(({ item }) => item.body)).toEqual(["Second"]);
    const quiet = readNotificationMirror(memory, {
      botId: "chief",
      sectionId: "work",
      now: 1_756_000_000_010,
      cursor: second.cursor,
      limit: 1,
    });
    expect(quiet).toMatchObject({ status: "empty", items: [] });
  });
});
