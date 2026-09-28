// The work digest (Phase 0, item 0.1): one durable, bounded record of what a
// turn DID — tools, files, memory edits, the gist of the reply — built from
// rows the harness already has for every engine, and rendered both as a
// transcript row (indexed by FTS) and as one bracketed line for context
// rebuilds.
import { describe, expect, it } from "vitest";

import { buildTurnDigest, digestPromptLine, renderDigest, type TurnDigest } from "./digest.ts";
import type { MemoryJournalEntry } from "./memory-journal.ts";
import type { Message } from "./store.ts";

const activity = (name: string, ok: boolean | undefined, summary?: string, turnId = "turn-1"): Message => ({
  id: `a-${Math.random().toString(36).slice(2, 8)}`,
  role: "bot",
  kind: "activity",
  at: 1,
  turnId,
  tool: { name, ok, summary, itemId: `tool-${Math.random()}` },
});

const journal = (path: string, kind: MemoryJournalEntry["kind"]): MemoryJournalEntry => ({
  id: "j1", at: 1, botId: "dev", path, actor: "bot", via: "turn", threadId: "t1", kind,
  beforeHash: null, afterHash: "x", before: null, diff: "", added: 1, removed: 0, canRevert: true,
});

const base = {
  turnId: "turn-1",
  botId: "dev",
  threadId: "t1",
  at: 1_000,
  durationMs: 4_200,
  reply: "Raised the staging retry limit to 5. Also cleaned up two log lines.\n\nDetails follow.",
  hookCoverage: "preview" as const,
};

describe("buildTurnDigest", () => {
  it("counts tool calls by name with failures, keeping one sample per tool", () => {
    const d = buildTurnDigest({
      ...base,
      activities: [
        activity("Bash", true, "pnpm test"),
        activity("Bash", false, "pnpm test --filter x"),
        activity("Read", true, "src/a.ts"),
        activity("Edit", true, "src/a.ts"),
      ],
      memory: [],
    });
    expect(d.tools).toEqual([
      { name: "Bash", count: 2, failed: 1, sample: "pnpm test" },
      { name: "Read", count: 1, failed: 0, sample: "src/a.ts" },
      { name: "Edit", count: 1, failed: 0, sample: "src/a.ts" },
    ]);
  });

  it("ignores activity rows from other turns and rows that are not tool calls", () => {
    const d = buildTurnDigest({
      ...base,
      activities: [activity("Bash", true, "ls", "turn-0"), { ...activity("Bash", true, "pwd"), tool: undefined }, { ...activity("status", true), tool: { name: "context compacted", ok: true } }],
      memory: [],
    });
    expect(d.tools).toEqual([]);
  });

  it("keeps the eight busiest tools and says how many were dropped", () => {
    const activities = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: i + 1 }, () => activity(`tool${i}`, true)),
    ).flat();
    const d = buildTurnDigest({ ...base, activities, memory: [] });
    expect(d.tools).toHaveLength(8);
    expect(d.tools[0]).toMatchObject({ name: "tool9", count: 10 });
    expect(d.toolsDropped).toBe(2);
    expect(d.toolCalls).toBe(55);
  });

  it("maps memory journal rows to path + kind and carries files from the checkpoint diff", () => {
    const d = buildTurnDigest({
      ...base,
      activities: [],
      memory: [journal("MEMORY.md", "edited"), journal("memory/clients.md", "created")],
      files: { changed: ["src/retry.ts"], added: ["docs/notes.md"], deleted: [] },
    });
    expect(d.memory).toEqual([
      { path: "MEMORY.md", kind: "updated" },
      { path: "memory/clients.md", kind: "created" },
    ]);
    expect(d.files).toEqual({ changed: ["src/retry.ts"], added: ["docs/notes.md"], deleted: [] });
  });

  it("keeps only the first sentence of the reply, capped at 200 characters", () => {
    const d = buildTurnDigest({ ...base, activities: [], memory: [] });
    expect(d.reply).toBe("Raised the staging retry limit to 5.");
    const long = buildTurnDigest({ ...base, reply: "x".repeat(500), activities: [], memory: [] });
    expect(long.reply).toHaveLength(200);
  });

  it("caps the file lists at 20 entries and records the overflow", () => {
    const changed = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`);
    const d = buildTurnDigest({ ...base, activities: [], memory: [], files: { changed, added: [], deleted: [] } });
    expect(d.files?.changed).toHaveLength(20);
    expect(d.files?.truncated).toBe(10);
  });

  it("bounds stored metadata as well as the rendered paragraph without splitting emoji", () => {
    const path = "🧵".repeat(1000);
    const d = buildTurnDigest({ ...base, activities: [activity(path, true, path)], memory: Array.from({ length: 100 }, () => journal(path, "edited")), files: { changed: [path], added: [], deleted: [] } });
    expect(d.memory).toHaveLength(20);
    expect(d.memoryDropped).toBe(80);
    expect(Buffer.byteLength(d.tools[0]!.name)).toBeLessThanOrEqual(160);
    expect(Buffer.byteLength(d.tools[0]!.sample!)).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(d.memory[0]!.path)).toBeLessThanOrEqual(512);
    for (const text of [d.memory[0]!.path, d.files!.changed[0]!, renderDigest(d)]) {
      expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
    }
  });
});

describe("renderDigest", () => {
  const digest: TurnDigest = {
    ...base,
    tools: [
      { name: "Bash", count: 12, failed: 1, sample: "pnpm test" },
      { name: "Edit", count: 3, failed: 0, sample: "src/retry.ts" },
    ],
    files: { changed: ["src/retry.ts"], added: [], deleted: ["src/old.ts"] },
    memory: [{ path: "MEMORY.md", kind: "updated" }],
    reply: "Raised the staging retry limit to 5.",
    usage: { input: 20_000, output: 900, cachedInput: 18_000 },
  };

  it("renders one compact paragraph that names tools, files, memory and the reply", () => {
    const text = renderDigest(digest);
    expect(text).toContain("[digest]");
    expect(text).toContain("Bash ×12 (1 failed)");
    expect(text).toContain("changed src/retry.ts");
    expect(text).toContain("deleted src/old.ts");
    expect(text).toContain("memory: updated MEMORY.md");
    expect(text).toContain("Raised the staging retry limit to 5.");
  });

  it("never exceeds 1,500 bytes even with many long file names", () => {
    const huge: TurnDigest = {
      ...digest,
      tools: Array.from({ length: 8 }, (_, i) => ({ name: `a-very-long-tool-name-${i}`, count: 99, failed: 9, sample: "z".repeat(200) })),
      files: { changed: Array.from({ length: 20 }, (_, i) => `packages/some/deeply/nested/directory/structure/file-number-${i}.ts`), added: [], deleted: [], truncated: 40 },
    };
    expect(Buffer.byteLength(renderDigest(huge), "utf8")).toBeLessThanOrEqual(1_500);
  });

  it("says when the record is from previews or absent, so a reader never over-trusts it", () => {
    expect(renderDigest({ ...digest, hookCoverage: "preview" })).toContain("from tool previews");
    expect(renderDigest({ ...digest, hookCoverage: "none", tools: [] })).toContain("no tool activity observed");
    expect(renderDigest({ ...digest, hookCoverage: "full" })).not.toContain("from tool previews");
  });
});

describe("digestPromptLine", () => {
  it("is one bracketed line attributed to the bot, for context rebuilds", () => {
    const line = digestPromptLine({ ...base, tools: [{ name: "Bash", count: 2, failed: 0 }], memory: [], reply: "Done." }, "Dev");
    expect(line.startsWith("[What Dev did in an earlier turn:")).toBe(true);
    expect(line.endsWith("]")).toBe(true);
    expect(line).not.toContain("\n");
  });
});

describe("coverageForDriver", () => {
  it("reports observed evidence regardless of engine family", async () => {
    const { coverageForDriver } = await import("./digest.ts");
    expect(coverageForDriver("openai-compat", false, true)).toBe("preview");
    expect(coverageForDriver("grok", false, true)).toBe("preview");
    expect(coverageForDriver("minimax", false, true)).toBe("preview");
    expect(coverageForDriver("boxAgent")).toBe("none");
    expect(coverageForDriver("claudeAgent", false, true)).toBe("preview");
    expect(coverageForDriver("codex", false, true)).toBe("preview");
    expect(coverageForDriver("grokAgent", false, true)).toBe("preview");
    expect(coverageForDriver("piAgent", false, true)).toBe("preview");
    expect(coverageForDriver("claudeAgent", true)).toBe("full");
    expect(coverageForDriver("grok", true)).toBe("full");
    expect(coverageForDriver("boxAgent", false, true)).toBe("preview");
    expect(coverageForDriver(undefined)).toBe("none");
  });
});

describe("toolEvidence", () => {
  it("is full only when every tool row of the turn carries a delivered result", async () => {
    const { toolEvidence } = await import("./digest.ts");
    const full = { ...activity("Bash", true, "ls"), tool: { name: "Bash", itemId: "bash-1", ok: true, fullResult: true } };
    const preview = activity("Read", true, "a.ts");
    expect(toolEvidence([full, { ...full, id: "b" }], "turn-1")).toBe(true);
    expect(toolEvidence([full, preview], "turn-1")).toBe(false);
    expect(toolEvidence([], "turn-1")).toBe(false);
    expect(toolEvidence([{ ...full, turnId: "turn-0" }], "turn-1")).toBe(false);
  });
});
