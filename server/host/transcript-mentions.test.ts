import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { threadsMentioning, transcriptThreads } from "./transcript-mentions.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcripts(rows: Array<[string, unknown]>): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-mentions-"));
  made.push(dir);
  const file = join(dir, "messages.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL, json TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO messages(thread_id, json) VALUES (?, ?)");
  for (const [thread, message] of rows) insert.run(thread, JSON.stringify(message));
  db.close();
  return file;
}

describe("which conversations mention a word", () => {
  it("answers for every word in one read, off the event loop", async () => {
    const file = transcripts([
      ["live", { text: "see task-workspaces/scout/gone1/app" }],
      ["other", { text: "nothing here" }],
      ["gone1", { text: "my own folder gone1" }],
    ]);
    const found = await threadsMentioning(file, ["gone1", "gone2", "gone1"]);
    expect([...found.get("gone1")!].sort()).toEqual(["gone1", "live"]);
    expect([...found.get("gone2")!]).toEqual([]);
  });

  it("rejects when the transcripts are missing or cannot be read, so a caller keeps", async () => {
    await expect(threadsMentioning(join(tmpdir(), "no-such-folder-omb", "messages.db"), ["x"])).rejects.toThrow(/missing/);
    const file = transcripts([]);
    const db = new DatabaseSync(file);
    db.exec("DROP TABLE messages");
    db.close();
    await expect(threadsMentioning(file, ["x"])).rejects.toThrow(/no such table/);
  });

  it("reads nothing for no words", async () => {
    expect((await threadsMentioning("/nowhere", [])).size).toBe(0);
  });

  it("lists every conversation the transcripts hold, and rejects when they cannot be read", async () => {
    const file = transcripts([["a", { text: "x" }], ["b", { text: "y" }], ["a", { text: "z" }]]);
    expect([...await transcriptThreads(file)].sort()).toEqual(["a", "b"]);
    await expect(transcriptThreads(join(tmpdir(), "no-such-folder-omb", "messages.db"))).rejects.toThrow(/missing/);
  });
});
