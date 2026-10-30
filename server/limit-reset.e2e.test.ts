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
  /** Stops the server and starts it again on the same data, as a Cloud stopped for a sleep or an update does. */
  restart: () => Promise<void>;
}

async function withLimitFixture(setup: { recovery?: unknown; secondClaude?: boolean; codex?: false; signedOut?: boolean }, check: (fixture: Fixture) => Promise<void>) {
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
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_LIMITED_FILE: limitedFile, FAKE_CLAUDE_PROMPTS: promptsFile, FAKE_CLAUDE_TOOL_CALLS: "[]",
      ...(setup.signedOut ? { FAKE_CLAUDE_MODE: "not-logged-in" } : {}) };
    if (setup.codex !== false) config.instances.codex = { driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) } };
    if (setup.secondClaude) config.instances.claudeWork = { ...config.instances.claude, displayName: "Second Claude sign-in" };
    if (setup.recovery) config.automaticRecovery = setup.recovery;
    writeFileSync(configPath, JSON.stringify(config));
    // No engine reports usage here: what the server knows of the limit comes from the refusal itself.
    writeFileSync(usageFile, JSON.stringify({ providers: [] }));
    const start = async () => {
      const log = openSync(logPath, "a", 0o600);
      server = spawn(process.execPath, [
        "--experimental-strip-types", "--import", new URL("./testing/limit-clock-hooks.mjs", import.meta.url).href, fileURLToPath(new URL("./index.ts", import.meta.url)),
      ], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_LIMIT_CLOCK: "1", OMB_TEST_PLAN_USAGE_FILE: usageFile },
        stdio: ["ignore", log, log],
      });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
      if (setup.codex !== false) await expect.poll(async () => {
        const { instances } = await api("GET", "/api/instances") as { instances: any[] };
        return instances.find((instance) => instance.instanceId === "codex")?.models.options.some((option: any) => option.id === codex.model);
      }, { timeout: 20_000 }).toBe(true);
    };
    await start();
    // Chief first makes the starter its team's Chief, which answers a teammate's failed run with a Team incidents turn
    // of its own on Claude, whose prompts these tests count. Stepped down, only the conversations under test run.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff)!;
    await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    await check({
      api, control, dataDir, evidence,
      restart: async () => {
        await waitForExit(server, { signal: "SIGTERM" });
        await start();
      },
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

it("with no other AI to carry on, the stopped turn's Continue sets up a run that continues the conversation once the limit resets", async () => {
  await withLimitFixture({ codex: false }, async ({ api, control, limit, lift, claudePrompts, evidence }) => {
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
  await withLimitFixture({ recovery: { enabled: true, backup: { instanceId: "claudeWork", model: "claude-sonnet-5" } }, secondClaude: true, codex: false },
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

it("a model out of extra-usage credits moves its turns to the backup for a while, but never holds the engine's other models", async () => {
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
    // That model is held a while: the bot's next conversation on it goes straight to the backup, without asking Claude.
    const { task: same } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", same.threadId, "--text", "And check today's commits");
    expect((await control("wait", "--bot", bot.id, "--task", same.threadId, "--timeout", "30")).status).toBe("settled");
    expect(claudePrompts()).toHaveLength(1);
    // Claude's other models still run on Claude: the engine itself is never held.
    const { instances } = await api("GET", "/api/instances") as { instances: any[] };
    const model = instances.find((instance) => instance.instanceId === "claude").models.options.map((option: any) => option.id).find((id: string) => id !== bot.modelSelection.model);
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "One more" });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${other.threadId}`, { modelSelection: { instanceId: "claude", model } });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And list today's commits");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    expect(claudePrompts()).toHaveLength(2);
    const reply = (await messagesOf(api, other.threadId)).findLast((message) => message.role === "bot" && message.kind === "text");
    expect(reply).toMatchObject({ text: "hello from fake claude" });
    evidence.push({ reply, model });
  });
}, 120_000);

it("a turn that works on the engine afterwards ends a refusal's hold long before its reset", async () => {
  await withLimitFixture({ codex: false }, async ({ api, control, limit, lift, evidence }) => {
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

it("with nothing set up for it, carries the person's request on with another AI they have, says so once, and goes back after the reset", async () => {
  await withLimitFixture({}, async ({ api, control, limit, lift, claudePrompts, evidence }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 25;
    limit(resetsAt);
    const { bot } = await control("new-bot", "--name", "Kai");
    const threadId = bot.activeTaskId;
    const claudeModel = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    const reply = async (id: string) => (await messagesOf(api, id)).findLast((message) => message.role === "bot" && message.kind === "text")?.text;
    await expect.poll(() => reply(threadId), { timeout: 40_000 }).toBe("done from fake codex");
    const first = await messagesOf(api, threadId);
    expect(first.map((message) => message.tool?.name)).toContain("notice: continuing on Codex after hitting the usage limit");
    const task = async (id: string) => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === id);
    expect((await task(threadId)).modelSelection).toEqual(codex);
    const notified = async () => (await api("GET", "/api/notifications")).notifications as any[];
    await expect.poll(async () => (await notified()).filter((entry) => entry.kind === "notice").length, { timeout: 10_000 }).toBe(1);
    expect((await notified()).find((entry) => entry.kind === "notice").body).toMatch(/^Verification fixture reached its limit until .+, so Kai is using Codex meanwhile\.$/);
    expect((await notified()).filter((entry) => entry.kind === "incident" || entry.kind === "turn-failed"), "one notice, never an incident").toEqual([]);

    // Known to be refusing: another conversation goes to Codex without spending a refused turn on Claude, and no new notice.
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And the budget");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    expect(recoveryLines(await messagesOf(api, other.threadId))).toEqual([expect.stringMatching(/so Codex took over\.$/)]);
    expect(claudePrompts()).toHaveLength(1);
    expect((await notified()).filter((entry) => entry.kind === "notice")).toHaveLength(1);

    lift();
    await expect.poll(() => Date.now() > resetsAt * 1000 + 500, { timeout: 40_000, interval: 500 }).toBe(true);
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Now polish it");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect((await task(threadId)).modelSelection).toEqual(claudeModel);
    expect(recoveryLines(await messagesOf(api, threadId))).toContain("recovery: Verification fixture's limit has reset, so this conversation is back on Verification fixture.");
    expect(await reply(threadId)).toBe("hello from fake claude");
    evidence.push({ first, notices: await notified() });
  });
}, 150_000);

it("after a restart, a new conversation still starts on the AI that carries on, and the limited Claude is not asked again", async () => {
  await withLimitFixture({}, async ({ api, control, limit, claudePrompts, restart, evidence }) => {
    limit(Math.floor(Date.now() / 1000) + 11 * 86_400);
    const { bot } = await control("new-bot", "--name", "Kai");
    const threadId = bot.activeTaskId;
    const reply = async (id: string) => (await messagesOf(api, id)).findLast((message) => message.role === "bot" && message.kind === "text")?.text;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    await expect.poll(() => reply(threadId), { timeout: 40_000 }).toBe("done from fake codex");
    expect(claudePrompts()).toHaveLength(1);

    // A Cloud stopped for a sleep, an update or a crash starts again with the limit still on.
    await restart();
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "After the restart" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And the budget");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    expect(recoveryLines(await messagesOf(api, other.threadId))).toEqual([expect.stringMatching(/so Codex took over\.$/)]);
    expect(await reply(other.threadId)).toBe("done from fake codex");
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Now the timeline");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(claudePrompts(), "no turn went to the limited Claude after the restart").toHaveLength(1);
    const notices = (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice");
    expect(notices, "the person heard it once").toHaveLength(1);
    evidence.push({ notices });
  });
}, 180_000);

it("a signed-out Claude with Automatic recovery on: its turns go to the chosen backup, and the way to sign in is said once", async () => {
  await withLimitFixture({ signedOut: true, recovery: { enabled: true, backup: codex } }, async ({ api, control, claudePrompts, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Kai");
    const threadId = bot.activeTaskId;
    const reply = async (id: string) => (await messagesOf(api, id)).findLast((message) => message.role === "bot" && message.kind === "text")?.text;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(await reply(threadId)).toBe("done from fake codex");
    const first = await messagesOf(api, threadId);
    const told = "Verification fixture is signed out on this computer, so Kai is using Codex meanwhile. Sign in again in Settings → AI to keep using Verification fixture.";
    expect(first.flatMap((message) => message.tool?.name?.match(/^(?:recovery|notice):/) ? [message.tool] : [])).toEqual([
      { name: "recovery: Verification fixture is signed out, so Codex took over.", ok: true },
      { name: `notice: ${told}`, ok: true, setup: true },
    ]);
    expect(first.some((message) => message.tool?.ok === false), "no failed turn").toBe(false);
    expect(claudePrompts()).toHaveLength(1);

    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And the budget");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("settled");
    const next = await messagesOf(api, other.threadId);
    expect(recoveryLines(next)).toEqual(["recovery: Verification fixture is signed out, so Codex took over."]);
    expect(next.some((message) => message.tool?.name?.startsWith("notice:")), "said once, not again").toBe(false);
    expect(await reply(other.threadId)).toBe("done from fake codex");
    expect(claudePrompts(), "the signed-out Claude is not asked again").toHaveLength(1);
    const notified = (await api("GET", "/api/notifications")).notifications as any[];
    expect(notified.filter((entry) => entry.kind === "notice").map((entry) => entry.body)).toEqual([told]);
    evidence.push({ first, next, notified });
  });
}, 180_000);

it.each([
  ["as its turns end", false],
  ["as Automatic recovery stops its turns before they start, with no other AI to take them", true],
])("a signed-out Claude with nothing to carry on: every refused turn fails, but the way to sign in is said once (%s)", async (_how, recovering) => {
  await withLimitFixture({ signedOut: true }, async ({ api, control, claudePrompts, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Kai");
    const threadId = bot.activeTaskId;
    if (recovering) await api("PUT", "/api/config", { automaticRecovery: { enabled: true, backup: bot.modelSelection } });
    const told = "Verification fixture is signed out on this computer. Sign in again in Settings → AI to keep using it.";
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Are you there?");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    const { task: other } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another thing" });
    await control("send", "--bot", bot.id, "--task", other.threadId, "--text", "And the budget");
    expect((await control("wait", "--bot", bot.id, "--task", other.threadId, "--timeout", "30")).status).toBe("failed");
    expect(claudePrompts()).toHaveLength(3);
    const messages = [...await messagesOf(api, threadId), ...await messagesOf(api, other.threadId)];
    expect(messages.filter((message) => message.tool?.ok === false), "each refused turn shows it failed, with the sign-in that fixes it")
      .toEqual(Array(3).fill(expect.objectContaining({ tool: { name: "error: Not logged in · Please run /login", ok: false, setup: true } })));
    expect(messages.filter((message) => message.tool?.name?.startsWith("notice:")).map((message) => message.tool))
      .toEqual([{ name: `notice: ${told}`, ok: true, setup: true }]);
    const notified = (await api("GET", "/api/notifications")).notifications as any[];
    expect(notified.filter((entry) => entry.kind === "notice").map((entry) => entry.body)).toEqual([told]);
    expect(notified.filter((entry) => entry.kind !== "notice"), "no notice a turn").toEqual([]);
    evidence.push({ messages, notified });
  });
}, 180_000);
