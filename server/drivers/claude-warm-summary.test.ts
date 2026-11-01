import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import type { KeepWarmContract } from "./claude-keepwarm.ts";
import { claudeForks, PARKED_FORK_MS, parseWarmSummaryResult, warmSummaryPrompt, type WarmSummaryRun } from "./claude-warm-summary.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

describe("warm summary shape", () => {
  it("asks Claude Code's own /compact, with the instructions on its line", () => {
    expect(warmSummaryPrompt("Keep the open questions.\n\nSay what is done.")).toBe("/compact Keep the open questions. Say what is done.");
    expect(warmSummaryPrompt("   ")).toBe("/compact");
    expect(warmSummaryPrompt("x".repeat(5_000)).length).toBe("/compact ".length + 1_500);
  });

  it("reads the fork's session and usage, and says plainly why one failed", () => {
    expect(parseWarmSummaryResult(JSON.stringify({
      type: "result", is_error: false, result: "", session_id: "fork-1", total_cost_usd: 0.2,
      usage: { input_tokens: 4, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 40, output_tokens: 2_400 },
      modelUsage: { "claude-opus-5-5": { costUSD: 0.2 } },
    }), "", 0, "live")).toEqual({
      ok: true, session: "fork-1", sessionBefore: "live", input: 4, cacheRead: 150_000, cacheWrite: 40, output: 2_400, costUsd: 0.2,
      model: "claude-opus-5-5", costTotal: 0.2, modelUsage: { "claude-opus-5-5": { costUSD: 0.2 } },
    });
    expect(parseWarmSummaryResult(JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "limit" }), "", 0, "live"))
      .toEqual({ ok: false, reason: "the account's usage limit refused the summary", limit: true });
    expect(parseWarmSummaryResult(JSON.stringify({ type: "result", is_error: true, result: "Not enough messages to compact." }), "", 0, "live"))
      .toEqual({ ok: false, reason: "the summary failed: Not enough messages to compact." });
    expect(parseWarmSummaryResult(JSON.stringify({ type: "result", is_error: false, result: "" }), "", 0, "live"))
      .toEqual({ ok: false, reason: "the summary did not say which session it wrote" });
    expect(parseWarmSummaryResult("", "error: unknown option '--fork-session'\n", 1, "live"))
      .toEqual({ ok: false, reason: "the summary failed: error: unknown option '--fork-session'" });
  });
});

describe("the driver's forks", () => {
  const contract: KeepWarmContract = { args: ["-p"], env: {}, cwd: "/w", system: null, mcpServers: null, settings: null };
  const ok = (session: string, before: string): WarmSummaryRun =>
    ({ ok: true, session, sessionBefore: before, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, costUsd: 0.1, model: "m", costTotal: 0.1 });

  function forks(live: { sessionId: string; turn: boolean; busy: boolean } | null, now = () => 1_000) {
    const contracts = new Map<string, KeepWarmContract>([["t", contract]]);
    const runSummary = vi.fn(async (opts: { sessionId: string }) => ok("fork-1", opts.sessionId));
    const summarized = vi.fn();
    const made = claudeForks({ cli: "claude", contracts, holds: new Map(), live: () => live, armIdle: () => {}, supports: () => true, summarized, now, runSummary });
    return { made, contracts, runSummary, summarized };
  }

  it("forks the live session, then hands the driver the new one", async () => {
    const { made, runSummary, summarized } = forks({ sessionId: "s-live", turn: false, busy: false });
    const result = await made.adapter.compact("t", { instructions: "keep it", session: "s-live" });
    expect(result).toEqual({ ok: true, session: "fork-1", sessionBefore: "s-live", input: 1, cacheRead: 2, cacheWrite: 3, output: 4, costUsd: 0.1, model: "m" });
    expect(runSummary).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-live", instructions: "keep it", contract }));
    expect(summarized).toHaveBeenCalledWith("t", expect.objectContaining({ session: "fork-1", costTotal: 0.1 }));
  });

  it("refuses while a turn runs, for a conversation on another session, and with no session at all", async () => {
    expect(await forks({ sessionId: "s", turn: true, busy: true }).made.adapter.compact("t", { instructions: "" })).toEqual({ ok: false, reason: "a turn is running", busy: true });
    expect(await forks({ sessionId: "s", turn: false, busy: false }).made.adapter.compact("t", { instructions: "", session: "other" }))
      .toEqual({ ok: false, reason: "the conversation moved to another session" });
    expect(await forks(null).made.adapter.compact("t", { instructions: "" })).toEqual({ ok: false, reason: "the conversation's Claude session has closed" });
  });

  it("forks a session whose process closed while idle, for as long as its cache can be warm", async () => {
    let now = 1_000;
    const { made, runSummary } = forks(null, () => now);
    made.closed("t", "idle", "s-closed");
    expect(await made.adapter.compact("t", { instructions: "", session: "s-closed" })).toMatchObject({ ok: true, sessionBefore: "s-closed" });
    expect(runSummary).toHaveBeenCalledTimes(1);
    const later = forks(null, () => now);
    later.made.closed("t", "idle", "s-closed");
    now += PARKED_FORK_MS;
    expect(await later.made.adapter.compact("t", { instructions: "" })).toEqual({ ok: false, reason: "the conversation's Claude session has closed" });
  });

  it("forgets a process closed for any other reason than idle", async () => {
    for (const why of ["interrupted", "context reset", "spawn contract changed", "authentication required"]) {
      const { made, contracts } = forks(null);
      made.closed("t", why, "s");
      expect(contracts.has("t")).toBe(false);
      expect(await made.adapter.compact("t", { instructions: "" })).toEqual({ ok: false, reason: "the conversation's Claude session has closed" });
    }
  });

  it("never applies a fork a turn overtook", async () => {
    let live = { sessionId: "s", turn: false, busy: false };
    const contracts = new Map<string, KeepWarmContract>([["t", contract]]);
    const summarized = vi.fn();
    const made = claudeForks({ cli: "claude", contracts, holds: new Map(), live: () => live, armIdle: () => {}, supports: () => true, summarized,
      runSummary: async () => { live = { sessionId: "s", turn: true, busy: true }; return ok("fork-1", "s"); } });
    expect(await made.adapter.compact("t", { instructions: "" })).toEqual({ ok: false, reason: "a turn started while summarizing", busy: true });
    expect(summarized).not.toHaveBeenCalled();
  });
});

describe("ClaudeDriver warm summary (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-warm-summary-test-"));
    process.env.FAKE_CLAUDE_COMPACT_DUMP = join(scratch, "compact.json");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "turn.json");
    instance = await ClaudeDriver.create({
      instanceId: "claude-warm-summary", displayName: "Claude", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_COMPACT_DUMP;
    delete process.env.FAKE_CLAUDE_DUMP;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("summarizes on a persisted fork of the live session with its launch contract, and the next turn resumes the fork", async () => {
    await instance.adapter.sendTurn({ threadId: "t-sum", botId: "b1", text: "hi", model: "claude-sonnet-5", system: "You are Editor." });
    await recorder.until((e) => e.type === "turn.completed");
    const sessionId = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const before = recorder.events.length;

    const result = await instance.adapter.cacheKeepWarm!.compact!("t-sum", { instructions: "Keep the open questions.", session: sessionId });
    expect(result).toMatchObject({ ok: true, sessionBefore: sessionId, cacheRead: expect.any(Number), output: 2_400, model: "claude-sonnet-5" });
    const fork = (result as { session: string }).session;
    expect(fork).not.toBe(sessionId);
    expect(recorder.events.length).toBe(before);

    const dump = JSON.parse(readFileSync(join(scratch, "compact.json"), "utf8"));
    expect(dump.prompt).toBe("/compact Keep the open questions.");
    const argv: string[] = dump.argv;
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 3)).toEqual(["--resume", sessionId, "--fork-session"]);
    expect(argv).not.toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(dump.systemPrompt).toBe("You are Editor.");
    expect(dump.mcpConfig.mcpServers.ogb.args.at(-1)).toMatch(/no-broker\.sock$/);
    expect(dump.settings.hooks).toEqual({ PreToolUse: [expect.objectContaining({ matcher: "*" })] });
    expect(dump.hookEnv).toEqual([]);

    // The old process held the unsummarized conversation: the next turn starts a new one on the fork.
    await instance.adapter.sendTurn({ threadId: "t-sum", botId: "b1", text: "next", model: "claude-sonnet-5", system: "You are Editor.", resumeCursor: fork });
    await recorder.until((e) => e.type === "turn.completed" && recorder.events.indexOf(e) > before);
    const turnArgv: string[] = JSON.parse(readFileSync(join(scratch, "turn.json"), "utf8")).argv;
    expect(turnArgv[turnArgv.indexOf("--resume") + 1]).toBe(fork);
  });

  it("refuses while a turn runs, and for a session the conversation left", async () => {
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "hi", model: "claude-sonnet-5" });
    expect(await instance.adapter.cacheKeepWarm!.compact!("t-busy", { instructions: "" })).toEqual({ ok: false, reason: "a turn is running", busy: true });
    await recorder.until((e) => e.type === "turn.completed");
    expect(await instance.adapter.cacheKeepWarm!.compact!("t-busy", { instructions: "", session: "not-this-one" }))
      .toEqual({ ok: false, reason: "the conversation moved to another session" });
    expect(existsSync(join(scratch, "compact.json"))).toBe(false);
  });
});
