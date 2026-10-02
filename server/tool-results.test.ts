import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolResults, TOOL_RESULT_DURABLE_MS, TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS, TOOL_RESULT_TTL_MS } from "./tool-results.ts";
import { shouldTriageResult } from "./tool-triage.ts";

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

describe("durable spill for triaged results", () => {
  const spillOwner = { botId: "bot", threadId: "thread/durable" };
  let durableDir: string;

  beforeEach(() => { durableDir = mkdtempSync(join(tmpdir(), "omb-tool-results-")); });
  afterEach(() => rmSync(durableDir, { recursive: true, force: true }));

  it("keeps a triaged result readable after its cache entry expires", () => {
    let now = Date.now();
    const results = new ToolResults(() => now, { durableDir });
    const saved = results.save(spillOwner, "x".repeat(30_000), false, true);
    now += TOOL_RESULT_TTL_MS + 1;
    const revived = results.read(spillOwner, saved.id, 0);
    expect(revived?.text.slice(0, 5)).toBe("xxxxx");
    expect(revived?.nextOffset).toBe(TOOL_RESULT_PREVIEW_CHARS);
    expect(revived?.truncated).toBe(false);
  });

  it("writes nothing under durableDir unless the save qualifies for triage", () => {
    const results = new ToolResults(Date.now, { durableDir });
    const qualify = (flagged: boolean, text: string) => shouldTriageResult({ triage: flagged }, text, 6_000);
    results.save(spillOwner, "x".repeat(24_000), false, qualify(true, "x".repeat(24_000)));
    results.save(spillOwner, "x".repeat(30_000), false, qualify(false, "x".repeat(30_000)));
    expect(existsSync(durableDir) ? readdirSync(durableDir) : []).toEqual([]);
    const saved = results.save(spillOwner, "x".repeat(24_001), false, qualify(true, "x".repeat(24_001)));
    expect(existsSync(join(durableDir, "thread-durable", `${saved.id}.json`))).toBe(true);
  });

  it("re-checks ownership from the spilled record, never the path", () => {
    let now = Date.now();
    const results = new ToolResults(() => now, { durableDir });
    const saved = results.save(spillOwner, "x".repeat(30_000), false, true);
    now += TOOL_RESULT_TTL_MS + 1;
    const restarted = new ToolResults(() => now, { durableDir });
    expect(restarted.read({ ...spillOwner, botId: "peer" }, saved.id, 0)).toBeNull();
    expect(restarted.read({ ...spillOwner, threadId: "thread/other" }, saved.id, 0)).toBeNull();
    expect(restarted.read(spillOwner, saved.id, 0)?.text.length).toBe(TOOL_RESULT_PREVIEW_CHARS);
  });

  it("writes the spill private and leaves the default cache pure memory", () => {
    let now = Date.now();
    const results = new ToolResults(() => now, { durableDir });
    const saved = results.save(spillOwner, "x".repeat(30_000), false, true);
    const file = join(durableDir, "thread-durable", `${saved.id}.json`);
    // Windows collapses permission bits to a read-only flag (a writable file
    // reports 0o666), so the exact 0600 contract is asserted where the
    // filesystem honors POSIX modes; there, the spill simply has to exist.
    if (process.platform === "win32") expect(() => statSync(file)).not.toThrow();
    else expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new ToolResults().save(spillOwner, "x".repeat(30_000), false, true).id).toMatch(/^r-/);
    expect(new ToolResults(() => now + TOOL_RESULT_TTL_MS + 1).read(spillOwner, saved.id, 0)).toBeNull();
  });

  it("drops spilled threads after their retention window", () => {
    // Retention compares each file's own mtime against the clock, exactly
    // as production does across real days; backdate the spill to age it out.
    let now = Date.now();
    const results = new ToolResults(() => now, { durableDir });
    const saved = results.save(spillOwner, "x".repeat(30_000), false, true);
    const stale = new Date(Date.now() - TOOL_RESULT_DURABLE_MS - 24 * 60 * 60_000);
    const threadDir = join(durableDir, "thread-durable");
    utimesSync(join(threadDir, `${saved.id}.json`), stale, stale);
    utimesSync(threadDir, stale, stale);
    now += 60 * 60_000 + 1;
    // Past retention the spilled copy is unreadable even before the sweep;
    // the live cache entry above still serves until it expires.
    expect(new ToolResults(Date.now, { durableDir }).read(spillOwner, saved.id, 0)).toBeNull();
    const kept = results.save({ botId: "bot", threadId: "fresh" }, "y".repeat(30_000), false, true);
    expect(readdirSync(durableDir)).toEqual(["fresh"]);
    expect(results.read({ botId: "bot", threadId: "fresh" }, kept.id, 0)?.text.slice(0, 5)).toBe("yyyyy");
    // The sweep only reclaims past-retention directories, never live ones.
    results.save({ botId: "bot", threadId: "newer" }, "z".repeat(30_000), false, true);
    expect(readdirSync(durableDir).sort()).toEqual(["fresh", "newer"]);
  });
});
