// A turn stopped by its engine's usage limit, end to end against a real server with fake engines: the stopped turn's
// "Continue when your limit resets" sets up an automation that continues the conversation after the reset; with a
// backup configured the conversation continues on the backup and goes back after the reset; a backup that is only
// another sign-in to the same engine is never used. The limit clock hook shortens the minute after a reset to a
// second, so each run is watched without waiting.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const codex = { instanceId: "codex", model: "gpt-fake-default" };
const jsonLines = (path: string): unknown[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

interface Fixture {
  api: (method: string, path: string, body?: unknown, expectedStatus?: number) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  /** The fake Claude refuses every turn until this reset (epoch seconds); `lift()` ends the limit. */
  limit: (resetsAt: number) => void;
  /** The fake Claude refuses every turn with exactly this rate_limit_info until `lift()`. */
  refuse: (info: Record<string, unknown>) => void;
  lift: () => void;
  claudePrompts: () => unknown[];
  dataDir: string;
  evidence: unknown[];
}

async function withLimitFixture(setup: { recovery?: unknown; secondClaude?: boolean; handoffHook?: "note" | "fail" }, check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const limitedFile = join(dataDir, "claude-limited.json");
  const promptsFile = join(dataDir, "claude-prompts.jsonl");
  const usageFile = join(dataDir, "plan-usage.json");
  const evidence: unknown[] = [{ url, setup }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_LIMITED_FILE: limitedFile, FAKE_CLAUDE_PROMPTS: promptsFile, FAKE_CLAUDE_TOOL_CALLS: "[]" };
    config.instances.codex = { driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) } };
    if (setup.secondClaude) config.instances.claudeWork = { ...config.instances.claude, displayName: "Second Claude sign-in" };
    if (setup.handoffHook) config.instances.codex.environment = { FAKE_CODEX_DUMP: join(dataDir, "codex-dump.json") };
    if (setup.recovery) config.automaticRecovery = setup.recovery;
    writeFileSync(configPath, JSON.stringify(config));
    // No engine reports usage here: what the server knows of the limit comes from the refusal itself.
    writeFileSync(usageFile, JSON.stringify({ providers: [] }));
    // A host's handoff hook: records what it was sent, then answers with a note (or exits with an error).
    const hookPath = join(dataDir, "handoff-hook.mjs");
    writeFileSync(hookPath, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dataDir, "handoff-input.json"))}, readFileSync(0, "utf8"));
${setup.handoffHook === "fail" ? "process.exit(3);" : 'process.stdout.write(JSON.stringify({ text: "HANDOFF-NOTE-FROM-HOOK: the plan lives in memory page 7" }));'}
`, { mode: 0o755 });
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, [
      "--experimental-strip-types", "--import", new URL("./testing/limit-clock-hooks.mjs", import.meta.url).href, fileURLToPath(new URL("./index.ts", import.meta.url)),
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_LIMIT_CLOCK: "1", OMB_TEST_PLAN_USAGE_FILE: usageFile,
        ...(setup.handoffHook ? { OMB_ACCOUNT_HANDOFF_COMMAND: hookPath } : {}) },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances") as { instances: any[] };
      return instances.find((instance) => instance.instanceId === "codex")?.models.options.some((option: any) => option.id === codex.model);
    }, { timeout: 20_000 }).toBe(true);
    // Chief first makes the starter its team's Chief, which answers a teammate's failed run with a Team incidents turn
    // of its own on Claude, whose prompts these tests count. Stepped down, only the conversations under test run.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff)!;
    await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    await check({
      api, control, dataDir, evidence,
      limit: (resetsAt) => writeFileSync(limitedFile, JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt })),
      refuse: (info) => writeFileSync(limitedFile, JSON.stringify(info)),
      lift: () => rmSync(limitedFile, { force: true }),
      claudePrompts: () => jsonLines(promptsFile),
    });
  } finally {
    const evidencePath = `${logPath}.limit-reset.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

const messagesOf = async (api: Fixture["api"], threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const recoveryLines = (messages: any[]) => messages.filter((message) => message.tool?.name?.startsWith("recovery:")).map((message) => message.tool.name as string);

it("the stopped turn's Continue sets up a run that continues the conversation once the limit resets", async () => {
  await withLimitFixture({}, async ({ api, control, limit, lift, claudePrompts, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 10;
    limit(resetsAt);
    const { bot } = await control("new-bot", "--name", "Scout");
    const threadId = bot.activeTaskId;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Write the quarterly report");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const stopped = await messagesOf(api, threadId);
    const failure = stopped.find((message) => message.tool?.name?.startsWith("error:"));
    expect(failure.tool).toMatchObject({ ok: false, limitResetsAt: resetsAt * 1000 });
    expect(recoveryLines(stopped)).toEqual([]);
    expect((await api("GET", "/api/limit-resets")).engines).toContainEqual(expect.objectContaining({ engine: "claude", blocked: true, resetsAt: resetsAt * 1000 }));

    const { routine } = await api("POST", "/api/limit-resets/continue", { botId: bot.id, threadId }, 201);
    expect(routine).toMatchObject({ sourceThreadId: threadId, enabled: true, nextRunAt: resetsAt * 1000 + 1_000, schedule: { type: "limit_reset", engine: "claude", repeat: "once" } });
    expect(routine.prompt).toContain("cut off because Verification fixture's usage limit was reached");
    const card = (await messagesOf(api, threadId)).find((message) => message.card?.routineRequest?.resultId === routine.id);
    expect(card.card).toMatchObject({ autoApplied: true, answered: "allow" });
    expect(claudePrompts()).toHaveLength(1);

    lift();
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === routine.id)?.status, { timeout: 40_000 }).toBe("completed");
    const { runs, routines } = await api("GET", "/api/routines");
    const run = runs.find((candidate: any) => candidate.routineId === routine.id);
    expect(run.threadId).toBe(threadId);
    expect(run.startedAt).toBeGreaterThanOrEqual(resetsAt * 1000 + 1_000);
    expect(routines.find((candidate: any) => candidate.id === routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
    const prompts = claudePrompts();
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("Your previous turn here was cut off because Verification fixture's usage limit was reached");
    const after = await messagesOf(api, threadId);
    expect(after.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "hello from fake claude" });
    evidence.push({ stopped, routine, run, after });
  });
}, 120_000);

it("continues on the backup engine with one line, and goes back to its own engine after the reset", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: codex } }, async ({ api, control, limit, lift, claudePrompts, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 25;
    limit(resetsAt);
    const { bot } = await control("new-bot", "--name", "Planner");
    const threadId = bot.activeTaskId;
    const claudeModel = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection;
    expect(claudeModel.instanceId).toBe("claude");
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const first = await messagesOf(api, threadId);
    expect(recoveryLines(first)).toEqual([expect.stringMatching(/^recovery: Verification fixture hit its limit \(resets .+\), so Codex took over\.$/)]);
    expect(first.some((message) => message.tool?.ok === false)).toBe(false);
    expect(first.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "done from fake codex", turnSucceeded: true });
    const task = async (id: string) => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === id);
    expect((await task(threadId)).modelSelection).toEqual(codex);
    expect(claudePrompts()).toHaveLength(1);

    // Known to be refusing: a new conversation goes to the backup without spending a refused turn on Claude.
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And the budget");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    expect(recoveryLines(await messagesOf(api, other.threadId))).toHaveLength(1);
    expect(claudePrompts()).toHaveLength(1);

    lift();
    await expect.poll(() => Date.now() > resetsAt * 1000 + 500, { timeout: 40_000, interval: 500 }).toBe(true);
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Now polish it");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const back = await messagesOf(api, threadId);
    expect(recoveryLines(back)).toEqual([
      expect.stringContaining("so Codex took over"),
      "recovery: Verification fixture's limit has reset, so this conversation is back on Verification fixture.",
    ]);
    expect((await task(threadId)).modelSelection).toEqual(claudeModel);
    expect(claudePrompts()).toHaveLength(2);
    expect(JSON.stringify(claudePrompts()[1])).toContain("Now polish it");
    expect(back.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "hello from fake claude" });
    evidence.push({ first, back });
  });
}, 150_000);

it("never moves to another sign-in of the same engine; the stopped turn offers Continue instead", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true },
    async ({ api, control, limit, claudePrompts }) => {
      const resetsAt = Math.floor(Date.now() / 1000) + 600;
      limit(resetsAt);
      const { bot } = await control("new-bot", "--name", "One account");
      const threadId = bot.activeTaskId;
      await control("send", "--bot", bot.id, "--task", threadId, "--text", "Summarize the inbox");
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
      const messages = await messagesOf(api, threadId);
      expect(recoveryLines(messages)).toEqual([]);
      expect(messages.find((message) => message.tool?.name?.startsWith("error:")).tool).toMatchObject({ ok: false, limitResetsAt: resetsAt * 1000 });
      expect(claudePrompts()).toHaveLength(1);
      expect((await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    });
}, 120_000);

it.each(["note", "fail"] as const)("a limit switch sends the conversation to the host's handoff hook; the backup gets its note only when it answers (%s)", async (handoffHook) => {
  await withLimitFixture({ recovery: { enabled: true, backup: codex }, handoffHook }, async ({ api, control, limit, lift, dataDir }) => {
    const { bot } = await control("new-bot", "--name", "Planner");
    const threadId = bot.activeTaskId;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "First question");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    limit(Math.floor(Date.now() / 1000) + 600);
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Second question");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(recoveryLines(await messagesOf(api, threadId))).toEqual([expect.stringContaining("so Codex took over")]);
    const sent = JSON.parse(readFileSync(join(dataDir, "handoff-input.json"), "utf8"));
    expect(sent).toMatchObject({ schemaVersion: 1, event: "engine-switch", reason: "usage_limit", conversationId: `${bot.id}:${threadId}`, to: "Codex" });
    expect(sent.summary).toContain("First question");
    expect(sent.summary).not.toContain("Second question");
    // The switch happens either way; a hook that fails only means no note.
    const note = "HANDOFF-NOTE-FROM-HOOK: the plan lives in memory page 7";
    expect(readFileSync(join(dataDir, "codex-dump.json"), "utf8").includes(note)).toBe(handoffHook === "note");
    lift();
  });
}, 120_000);

it("a model out of extra-usage credits moves that turn to the backup, but never holds the engine", async () => {
  await withLimitFixture({ recovery: { enabled: true, backup: codex } }, async ({ api, control, refuse, lift, claudePrompts, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 11 * 86_400;
    refuse({ status: "rejected", resetsAt, overageDisabledReason: "out_of_credits", isUsingOverage: false, errorCode: "credits_required" });
    const { bot } = await control("new-bot", "--name", "Hazel");
    const threadId = bot.activeTaskId;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Remind me to commit");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(claudePrompts()).toHaveLength(1);
    expect((await api("GET", "/api/limit-resets")).engines).not.toContainEqual(expect.objectContaining({ engine: "claude", blocked: true }));

    lift();
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And check today's commits");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    expect(claudePrompts()).toHaveLength(2);
    const reply = (await messagesOf(api, other.threadId)).findLast((message) => message.role === "bot" && message.kind === "text");
    expect(reply).toMatchObject({ text: "hello from fake claude" });
    evidence.push({ reply });
  });
}, 120_000);

it("a turn that works on the engine afterwards ends a refusal's hold long before its reset", async () => {
  await withLimitFixture({}, async ({ api, control, limit, lift, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 11 * 86_400;
    limit(resetsAt);
    const { bot } = await control("new-bot", "--name", "Scout");
    const threadId = bot.activeTaskId;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Write the report");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    expect((await api("GET", "/api/limit-resets")).engines).toContainEqual(expect.objectContaining({ engine: "claude", blocked: true, resetsAt: resetsAt * 1000 }));

    lift();
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Continue");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const after = await api("GET", "/api/limit-resets");
    expect(after.engines).not.toContainEqual(expect.objectContaining({ engine: "claude", blocked: true }));
    evidence.push({ after });
  });
}, 120_000);
