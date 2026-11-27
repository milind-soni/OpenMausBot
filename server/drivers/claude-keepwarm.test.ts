import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
import {
  KEEP_WARM_DENY_HOOK,
  KEEP_WARM_PROMPT,
  keepWarmArgs,
  keepWarmMcpServers,
  keepWarmSettings,
  parseKeepWarmResult,
} from "./claude-keepwarm.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

describe("keep-warm ping shape", () => {
  it("keeps every prefix-shaping flag and swaps the session, stream and private files", () => {
    const launch = [
      "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", "acceptEdits", "--replay-user-messages", "--strict-mcp-config", "--setting-sources", "project",
      "--system-prompt-snapshot", "off", "--model", "claude-opus-5-5", "--effort", "high",
      "--permission-prompt-tool", "mcp__ogb__approve", "--mcp-config", "/tmp/old/mcp.json", "--allowedTools", "mcp__ogb,mcp__agents",
      "--settings", "/tmp/old/auth-settings.json", "--append-system-prompt-file", "/tmp/old/prompt.txt", "--resume", "live-session",
    ];
    expect(keepWarmArgs(launch, { sessionId: "live-session", mcpConfigPath: "/k/mcp.json", settingsPath: "/k/settings.json", systemPromptPath: "/k/prompt.txt" })).toEqual([
      "-p", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--setting-sources", "project",
      "--system-prompt-snapshot", "off", "--model", "claude-opus-5-5", "--effort", "high",
      "--permission-prompt-tool", "mcp__ogb__approve", "--allowedTools", "mcp__ogb,mcp__agents",
      "--output-format", "json", "--append-system-prompt-file", "/k/prompt.txt", "--mcp-config", "/k/mcp.json", "--settings", "/k/settings.json",
      "--resume", "live-session", "--fork-session", "--no-session-persistence",
    ]);
    expect(keepWarmArgs(["-p", "--session-id", "new-one"], { sessionId: "new-one", mcpConfigPath: null, settingsPath: null, systemPromptPath: null }))
      .toEqual(["-p", "--output-format", "json", "--resume", "new-one", "--fork-session", "--no-session-persistence"]);
  });

  it("points the permission proxy nowhere and leaves every other server alone", () => {
    const servers = { ogb: { command: "node", args: ["/proxy.js", "/live.sock"], alwaysLoad: true }, agents: { command: "node", args: ["/a.js"] } };
    expect(keepWarmMcpServers(servers, "/dead.sock")).toEqual({
      ogb: { command: "node", args: ["/proxy.js", "/dead.sock"], alwaysLoad: true },
      agents: { command: "node", args: ["/a.js"] },
    });
    expect(servers.ogb.args[1]).toBe("/live.sock");
  });

  it("drops the harness's hooks and denies every tool", () => {
    const settings = keepWarmSettings({ apiKeyHelper: "x", claudeMdExcludes: ["/h"], hooks: { PostToolUse: [] } }, "deny");
    expect(settings).toEqual({
      apiKeyHelper: "x",
      claudeMdExcludes: ["/h"],
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "deny", timeout: 10 }] }] },
    });
    const said = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", KEEP_WARM_DENY_HOOK], { encoding: "utf8" }));
    expect(said.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  });

  it("reads usage, API errors and the usage limit from the json result", () => {
    expect(parseKeepWarmResult(JSON.stringify({
      type: "result", is_error: false, result: "warm", total_cost_usd: 0.05, modelUsage: { "claude-opus-5-5": {} },
      usage: { input_tokens: 4, cache_read_input_tokens: 154_000, cache_creation_input_tokens: 30, output_tokens: 2 },
    }), "", 0)).toEqual({ ok: true, input: 4, cacheRead: 154_000, cacheWrite: 30, output: 2, costUsd: 0.05, model: "claude-opus-5-5" });
    expect(parseKeepWarmResult(JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "You've hit your limit" }), "", 1))
      .toEqual({ ok: false, reason: "the account's usage limit refused the ping", limit: true });
    expect(parseKeepWarmResult(JSON.stringify({ type: "result", is_error: true, result: "API Error: 529 overloaded" }), "", 1))
      .toMatchObject({ ok: false, reason: "the ping failed: API Error: 529 overloaded" });
    expect(parseKeepWarmResult("", "error: unknown option '--fork-session'\n", 1))
      .toEqual({ ok: false, reason: "the ping failed: error: unknown option '--fork-session'" });
  });
});

describe("ClaudeDriver keep-warm (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-keepwarm-test-"));
    process.env.FAKE_CLAUDE_PING_DUMP = join(scratch, "ping.json");
    instance = await ClaudeDriver.create({
      instanceId: "claude-keepwarm",
      displayName: "Claude",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_PING_DUMP;
    delete process.env.FAKE_CLAUDE_PING_USAGE;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("forks the live session with its launch contract and sends nothing to the thread", async () => {
    await instance.adapter.sendTurn({ threadId: "t-warm", botId: "b1", text: "hi", model: "claude-sonnet-5", system: "You are Editor." });
    await recorder.until((e) => e.type === "turn.completed");
    const sessionId = (recorder.events.find((e) => e.type === "session.started") as { sessionId: string }).sessionId;
    const before = recorder.events.length;

    const result = await instance.adapter.cacheKeepWarm!.ping("t-warm");
    expect(result).toEqual({ ok: true, input: 4, cacheRead: 150_000, cacheWrite: 40, output: 3, costUsd: 0.05, model: "claude-sonnet-5" });
    expect(recorder.events.length).toBe(before);

    const dump = JSON.parse(readFileSync(join(scratch, "ping.json"), "utf8"));
    expect(dump.prompt).toBe(KEEP_WARM_PROMPT);
    const argv: string[] = dump.argv;
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 4)).toEqual(["--resume", sessionId, "--fork-session", "--no-session-persistence"]);
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv).not.toContain("stream-json");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(dump.systemPrompt).toBe("You are Editor.");
    expect(dump.mcpConfig.mcpServers.ogb.args.at(-1)).toMatch(/no-broker\.sock$/);
    expect(dump.settings.hooks).toEqual({ PreToolUse: [expect.objectContaining({ matcher: "*" })] });
    expect(Object.keys(dump.env).filter((key) => key.startsWith("OMB_HOOK_"))).toEqual([]);
  });

  it("refuses without a live session, and while a turn runs", async () => {
    expect(await instance.adapter.cacheKeepWarm!.ping("t-none")).toMatchObject({ ok: false });
    expect(instance.adapter.cacheKeepWarm!.hold("t-none", Date.now() + 60_000)).toBe(false);
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "hi", model: "claude-sonnet-5" });
    expect(await instance.adapter.cacheKeepWarm!.ping("t-busy")).toEqual({ ok: false, reason: "a turn is running", busy: true });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.cacheKeepWarm!.hold("t-busy", Date.now() + 60_000)).toBe(true);
    expect(instance.adapter.cacheKeepWarm!.hold("t-busy", null)).toBe(true);
  });
});
