import { describe, expect, it } from "vitest";
import { ToolResults, TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS, TOOL_RESULT_TTL_MS } from "./tool-results.ts";

const owner = { botId: "a", threadId: "chat" };

describe("temporary agent tool results", () => {
  it("pages losslessly across emoji boundaries and redacts before retaining", () => {
    const results = new ToolResults();
    const secret = `sk-test-${"s".repeat(30)}`;
    const text = `${"a".repeat(15_999)}🌱${"b".repeat(18_000)} ${secret}`;
    const saved = results.save(owner, text);
    let reconstructed = "";
    let offset = 0;
    while (offset < saved.length) {
      const page = results.read(owner, saved.id, offset)!;
      expect(Buffer.from(page.text).toString()).toBe(page.text);
      expect(page.text.length).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_CHARS);
      reconstructed += page.text;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(reconstructed).toBe(text.replace(secret, `«redacted ${secret.length} chars»`));
    expect(results.read(owner, saved.id, 16_000)?.offset).toBe(15_999);
    expect(results.read(owner, saved.id, saved.length)?.text).toBe("");
  });

  it("scopes reads to both the bot and conversation, including room speakers", () => {
    const results = new ToolResults();
    const saved = results.save(owner, "private result");
    expect(results.read({ ...owner, botId: "peer" }, saved.id, 0)).toBeNull();
    expect(results.read({ ...owner, threadId: "sibling" }, saved.id, 0)).toBeNull();
    expect(results.read(owner, saved.id, 0)?.text).toBe("private result");
    expect(results.read(owner, "../chat", 0)).toBeNull();
    for (const offset of [-1, 0.5, Infinity, NaN, 10_000]) expect(results.read(owner, saved.id, offset)).toBeNull();
  });

  it("expires without extending retention on read, and restart starts empty", () => {
    let now = 100;
    const results = new ToolResults(() => now);
    const saved = results.save(owner, "temporary");
    now += TOOL_RESULT_TTL_MS - 1;
    expect(results.read(owner, saved.id, 0)).not.toBeNull();
    now++;
    expect(results.read(owner, saved.id, 0)).toBeNull();
    expect(new ToolResults().read(owner, saved.id, 0)).toBeNull();
  });

  it("marks storage truncation rather than claiming the whole result survives", () => {
    const results = new ToolResults();
    const saved = results.save(owner, `${"x".repeat(TOOL_RESULT_MAX_CHARS - 1)}🌱tail`);
    expect(saved).toMatchObject({ truncated: true, length: TOOL_RESULT_MAX_CHARS - 1 });
    expect(results.save(owner, "already cut upstream", true).truncated).toBe(true);
    expect(results.read(owner, saved.id, 0)?.truncated).toBe(true);
  });

  it("evicts the owner's oldest entries before neighbours and bounds total count", () => {
    const results = new ToolResults();
    const other = { ...owner, botId: "other" };
    const neighbour = results.save(other, "neighbour");
    const first = results.save(owner, "first");
    for (let i = 0; i < 16; i++) results.save(owner, String(i));
    expect(results.read(owner, first.id, 0)).toBeNull();
    expect(results.read(other, neighbour.id, 0)).not.toBeNull();
    for (let i = 0; i < 128; i++) results.save({ botId: String(i), threadId: "new" }, "small");
    expect(results.read(other, neighbour.id, 0)).toBeNull();
  });

  it("bounds owner and global UTF-8 bytes, not just the number of entries", () => {
    const results = new ToolResults();
    const text = "界".repeat(TOOL_RESULT_MAX_CHARS);
    const first = results.save(owner, text);
    for (let i = 0; i < 5; i++) results.save(owner, text);
    expect(results.read(owner, first.id, 0)).toBeNull();
    const oldest = results.save({ botId: "global", threadId: "old" }, text);
    for (let i = 0; i < 43; i++) results.save({ botId: "global", threadId: String(i) }, text);
    expect(results.read({ botId: "global", threadId: "old" }, oldest.id, 0)).toBeNull();
  });
});
