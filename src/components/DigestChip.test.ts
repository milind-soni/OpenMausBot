import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
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
  it("does not draw a receipt for a reply with no recorded work", () => {
    for (const files of [undefined, { changed: [], added: [], deleted: [] }]) {
      const html = renderToStaticMarkup(createElement(DigestChip, { message: {
        ...message, digest: { ...message.digest!, tools: [], toolsDropped: 0, toolCalls: 0,
          files, memory: [], memoryDropped: 0 },
      } }));
      expect(html).toBe("");
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
  it("shows total counts rather than only the truncated sample", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message }));
    expect(html).toContain("Did 19 tool calls · 5 files changed");
    expect(html).toContain('title="Observed work, not a completion verdict"');
  });

  it("does not imply zero changed files when capture was unavailable", () => {
    const html = renderToStaticMarkup(createElement(DigestChip, { message: { ...message, digest: { ...message.digest!, files: undefined, toolCalls: undefined } } }));
    expect(html).toContain("Did 12+ tool calls");
    expect(html).not.toContain("files changed");
  });
});
