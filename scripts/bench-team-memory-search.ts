import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const directory = mkdtempSync(join(tmpdir(), "omb-memory-search-bench-"));
process.env.OMB_BENCH = "1";
process.env.OMB_DATA_DIR = directory;
const { TeamMemory } = await import("../server/team-memory.ts");
try {
  const entries = Array.from({ length: 2_000 }, (_, i) => ({
    id: `note-${i}`, key: `term:${i}`, kind: "term", name: `Project ${i}`,
    detail: i % 2 === 0 ? "amber exposure" : "amber logistics", aliases: ["shared"],
    status: i % 5 === 0 ? "proposed" : "accepted", updatedAt: i,
    source: { botId: "b1", botName: "Scout", threadId: "t1", at: i },
    history: Array.from({ length: 20 }, (_, n) => ({ name: `Old project ${n}`, detail: "Earlier shared project detail", at: n })),
  }));
  const file = join(directory, "team-memory.json");
  writeFileSync(file, JSON.stringify({ version: 2, sections: { "": entries } }));
  const memory = new TeamMemory(file);
  const queries = ["", "amber", "amber exposure"];
  const search = () => queries.map(query => memory.search("", query, 12));
  const output = JSON.stringify(search());
  const milliseconds: number[] = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    if (JSON.stringify(search()) !== output) throw new Error("Search results changed between runs");
    milliseconds.push(performance.now() - start);
  }
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = (value, options) => {
    clones++;
    return originalClone(value, options);
  };
  try { search(); } finally { globalThis.structuredClone = originalClone; }
  console.log(JSON.stringify({
    notes: entries.length, historyPerNote: 20, queries, limit: 12,
    milliseconds, medianMilliseconds: [...milliseconds].sort((a, b) => a - b)[2],
    snapshotsPerThreeQueries: clones,
    sha256: createHash("sha256").update(output).digest("hex"),
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
