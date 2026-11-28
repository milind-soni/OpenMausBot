import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TeamMemory, teamMemoryRevision, type TeamMemoryEntry } from "./team-memory.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});

function fixture(): { memory: TeamMemory; entries: TeamMemoryEntry[] } {
  const directory = mkdtempSync(join(tmpdir(), "omb-memory-search-"));
  directories.push(directory);
  const entries: TeamMemoryEntry[] = Array.from({ length: 240 }, (_, i) => ({
    id: `note-${i}`, key: `term:${i}`, kind: "term", name: `Project ${i}`,
    detail: i % 2 === 0 ? "amber exposure" : "amber missing", aliases: ["shared"],
    status: i % 5 === 0 ? "proposed" : "accepted", updatedAt: Math.floor(i / 2),
    source: { botId: "b1", botName: "Scout", threadId: "t1", at: i },
    history: [{ name: "Earlier name", detail: "Earlier detail", at: i - 1 }],
    replaces: [{ id: `old-${i}`, revision: "previous" }],
  }));
  const file = join(directory, "team-memory.json");
  writeFileSync(file, JSON.stringify({ version: 2, sections: { "": entries } }));
  return { memory: new TeamMemory(file), entries };
}

it("snapshots only the requested matching notes, with full revisions and independent results", () => {
  const { memory, entries } = fixture();
  const clones = vi.spyOn(globalThis, "structuredClone");
  const result = memory.search("", "amber exposure", 4, { since: 80, until: 100 });
  expect(result.map(entry => entry.id)).toEqual(["note-198", "note-196", "note-194", "note-192"]);
  expect(clones).toHaveBeenCalledTimes(4);
  for (const entry of result) {
    expect(entry.revision).toBe(teamMemoryRevision(entries.find(item => item.id === entry.id)!));
    expect(entry).not.toHaveProperty("history");
    expect(entry).not.toHaveProperty("replaces");
  }
  result[0].source.botName = "Changed outside the store";
  result[0].aliases.push("Changed outside the store");
  const again = memory.search("", "amber exposure", 4, { since: 80, until: 100 });
  expect(again[0].source.botName).toBe("Scout");
  expect(again[0].aliases).toEqual(["shared"]);
});

it("preserves stable time ordering, blank-query semantics and the result cap", () => {
  const { memory } = fixture();
  const result = memory.search("", "", 1000);
  expect(result).toHaveLength(25);
  expect(result.slice(0, 4).map(entry => entry.id)).toEqual(["note-238", "note-239", "note-236", "note-237"]);
  expect(memory.search("", "amber missing", 0)).toHaveLength(1);
  expect(memory.search("", "amber exposure missing")).toEqual([]);
});
