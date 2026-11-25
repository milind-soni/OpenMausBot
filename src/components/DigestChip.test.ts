import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { EXCERPT_SUMMARY_HEADER } from "../../shared/wire";
import { CompactionChip, DigestChip } from "./DigestChip";

const message: Message = {
  id: "receipt", role: "bot", kind: "digest", at: 1, text: "Observed work, not a completion verdict",
  digest: {
    turnId: "turn", botId: "bot", threadId: "thread", at: 1, durationMs: 100,
    tools: [{ name: "Bash", count: 12, failed: 1 }], toolsDropped: 2, toolCalls: 19,
    files: { changed: ["a.ts"], added: [], deleted: [], truncated: 4 },
    memory: [], reply: "Finished this turn.", hookCoverage: "preview",
  },
};

describe("DigestChip", () => {
  it("draws only how long a reply with no recorded work took, with its trace beside it", () => {
    for (const files of [undefined, { changed: [], added: [], deleted: [] }]) {
      const quiet = { ...message.digest!, tools: [], toolsDropped: 0, toolCalls: 0, files, memory: [], memoryDropped: 0 };
      const html = renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...quiet, durationMs: 72_000 } } }));
      expect(html).toContain("Worked for 1m 12s");
      expect(html).toContain("View trace");
      expect(html).not.toContain("tool calls");
      expect(renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...quiet, durationMs: 0 } } }))).toBe("");
    }
  });

  it("keeps file, memory, and truncated work even without a sampled tool", () => {
    const quiet = { ...message.digest!, tools: [], toolsDropped: 0, toolCalls: 0,
      files: undefined, memory: [], memoryDropped: 0 };
    for (const work of [
      { files: { changed: ["notes.txt"], added: [], deleted: [] } },
      { memory: [{ kind: "updated" as const, path: "MEMORY.md" }] },
      { toolsDropped: 2 }, { toolCalls: 2 }, { memoryDropped: 2 },
      { files: { changed: [], added: [], deleted: [], truncated: 2 } },
    ]) {
      const html = renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...quiet, ...work } } }));
      expect(html).toContain('data-testid="digest-chip"');
    }
  });

  it("shows compaction as expandable historical text, never executable markup", () => {
    const html = renderToStaticMarkup(createElement(CompactionChip, { message: {
      id: "context", role: "bot", kind: "compaction", at: 1,
      compaction: { summary: "Latest correction: <script>bad()</script> x < -5", firstKeptId: "", foldedThroughId: "old", tokensBefore: 1, by: "person" },
    } }));
    expect(html).toContain("<details");
    expect(html).toContain("Earlier context summarized");
    expect(html).toContain("Your full conversation is still here");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("draws a Start fresh row as a divider, not a summary", () => {
    const html = renderToStaticMarkup(createElement(CompactionChip, { message: {
      id: "context", role: "bot", kind: "compaction", at: 1,
      compaction: { summary: "", firstKeptId: "", foldedThroughId: "old", tokensBefore: 0, by: "person", fresh: true },
    } }));
    expect(html).toContain('role="separator"');
    expect(html).toContain("Fresh start");
    expect(html).toContain("Messages above this line");
    expect(html).not.toContain("<details");
  });
  it("says one tool call and one file in the singular", () => {
    const one = { ...message.digest!, tools: [], toolsDropped: 0, toolCalls: 1, files: { changed: ["a.ts"], added: [], deleted: [] } };
    expect(renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: one } }))).toContain("Did 1 tool call · 1 file changed");
    expect(renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...one, files: undefined } } }))).toContain("Did 1 tool call<");
    expect(renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...one, toolCalls: 3 } } }))).toContain("Did 3 tool calls · 1 file changed");
    expect(renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...one, files: { ...one.files, added: ["b.ts"] } } } }))).toContain("Did 1 tool call · 2 files changed");
  });


  it("does not call an excerpt-only fallback a summary", () => {
    const chip = (summary: string) => renderToStaticMarkup(createElement(CompactionChip, { message: {
      id: "context", role: "bot", kind: "compaction", at: 1,
      compaction: { summary, firstKeptId: "", foldedThroughId: "old", tokensBefore: 1, by: "person" },
    } }));
    const excerpts = chip(`${EXCERPT_SUMMARY_HEADER}\nUser message: "hi"`);
    expect(excerpts).toContain("Earlier context shortened to recent excerpts");
    expect(excerpts).toContain("Older details may be missing");
    expect(excerpts).not.toContain("Earlier context summarized");
    const model = chip(`Model-written historical summary (may be incomplete):\nThe user wants X.\n\n${EXCERPT_SUMMARY_HEADER}`);
    expect(model).toContain("Earlier context summarized");
  });
  it("shows total counts rather than only the truncated sample", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message }));
    expect(html).toContain("Worked for 100ms · Did 19 tool calls · 5 files changed");
    expect(html).toContain('title="Observed work, not a completion verdict"');
  });

  it("does not imply zero changed files when capture was unavailable", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...message.digest!, files: undefined, toolCalls: undefined } } }));
    expect(html).toContain("Did 12+ tool calls");
    expect(html).not.toContain("files changed");
  });
});
