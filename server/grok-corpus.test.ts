import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CaptureMemory } from "./capture-memory.ts";
import { importGrokCorpus, recordFromMarkdown, recordsFromGrokBlob } from "./grok-corpus.ts";

const directories: string[] = [];
const memories: CaptureMemory[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-grok-corpus-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Grok corpus backfill", () => {
  it("extracts bounded messages and automation events with stable provenance", () => {
    const root = temporaryDirectory();
    const file = join(root, "history.blob");
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      value: { entries: [
        { kind: "message", id: "m1", role: "user", content: "Need this done", timestampMs: 10 },
        { kind: "send-message", id: "m2", message: { content: "Done with evidence" }, timestampMs: 20 },
        { kind: "event", id: "e1", event: { type: "automation-changed", automationName: "Daily brief" }, timestampMs: 30 },
        { kind: "event", id: "ignored", event: { type: "typing" }, timestampMs: 40 },
      ] },
    }));
    const records = recordsFromGrokBlob(file, root, 50);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.occurredAt)).toEqual([10, 20, 30]);
    expect(records.every((record) => record.evidenceRef === file)).toBe(true);
    expect(new Set(records.map((record) => record.externalId)).size).toBe(3);
  });

  it("labels current local state as sensitive and constitutions as internal", () => {
    const root = temporaryDirectory();
    const practice = join(root, "practice");
    mkdirSync(practice);
    const current = join(practice, "current.md");
    const constitution = join(root, "identity.md");
    writeFileSync(current, "# Practice state\nDone");
    writeFileSync(constitution, "# Identity\nClosest to pin");
    expect(recordFromMarkdown(current, root)?.sensitivity).toBe("sensitive");
    expect(recordFromMarkdown(constitution, root)?.sensitivity).toBe("internal");
  });

  it("is rerunnable and updates changed source files without duplicating them", () => {
    const root = temporaryDirectory();
    const file = join(root, "living-brief.md");
    const memory = new CaptureMemory({ file: join(root, "capture.db"), now: () => 100 });
    memories.push(memory);
    writeFileSync(file, "# Living brief\nFirst version");
    const first = importGrokCorpus({ memory, roots: [root], botId: "chief", sectionId: "ops", capturedAt: 100 });
    const second = importGrokCorpus({ memory, roots: [root], botId: "chief", sectionId: "ops", capturedAt: 200 });
    writeFileSync(file, "# Living brief\nSecond version");
    const third = importGrokCorpus({ memory, roots: [root], botId: "chief", sectionId: "ops", capturedAt: 300 });
    expect(first.inserted).toBe(1);
    expect(second.deduplicated).toBe(1);
    expect(third.updated).toBe(1);
    const result = memory.search({ botId: "chief", sourceId: "grok-bot-os", includeSensitive: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.item.body).toContain("Second version");
  });
});
