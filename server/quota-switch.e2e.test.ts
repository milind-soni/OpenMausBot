// The fake CLI plays the frames Claude Code 2.1.295 sent past its weekly limit.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { freePortBlock } from "./testing/ports.ts";

const LIMITED = "Limited Claude";
const OTHER_SIGN_IN = "Second Claude sign-in";
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url));
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function withQuotaFixture(
  options: { env?: Record<string, string>; otherSignInOnly?: boolean },
  check: (fixture: {
    api: (method: string, path: string, body?: unknown) => Promise<any>;
    control: (...args: string[]) => Promise<any>;
    respond: (threadId: string, body: unknown) => Promise<{ status: number; body: any }>;
    backupPrompts: () => any[];
    dataDir: string;
  }) => Promise<void>,
) {
  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "openmausbot-quota-switch-"));
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `quota-switch-${Date.now()}-${process.pid}.log`);
  const backupFile = join(dataDir, "backup-prompts.jsonl");
  const engine = (displayName: string, environment: Record<string, string>) =>
    ({ driver: "claudeAgent", displayName, config: { cli: FAKE_CLI }, environment });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      claude: engine(LIMITED, { FAKE_CLAUDE_MODE: "usage-limit" }),
      ...(options.otherSignInOnly
        ? { backup: engine(OTHER_SIGN_IN, { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: backupFile, FAKE_CLAUDE_TOOL_CALLS: "[]" }) }
        : { codex: { driver: "codex", config: { cli: FAKE_CODEX }, environment: { FAKE_CODEX_DUMP: backupFile } } }),
    },
  }));
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  /** A card answer as a client posts it, with the status it got. */
  const respond = async (threadId: string, body: unknown) => {
    const response = await fetch(`${url}/api/threads/${threadId}/respond`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const answer = { status: response.status, body: await response.json() };
    evidence.push({ respond: body, answer });
    return answer;
  };
  try {
    const env = { ...verificationServerEnvironment({}, dataDir, port), ...options.env };
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    if (!options.otherSignInOnly) {
      await expect.poll(async () => {
        const { instances } = await api("GET", "/api/instances") as { instances: any[] };
        return instances.find((instance) => instance.instanceId === "codex")?.models.options.length > 0;
      }, { timeout: 30_000 }).toBe(true);
    }
    // What the other AI was sent: the fake Claude logs each prompt; the fake Codex keeps its calls in one dump.
    const sent = () => {
      if (options.otherSignInOnly) return jsonLines(backupFile);
      try { return (JSON.parse(readFileSync(backupFile, "utf8")).calls as any[]).filter((call) => call.method === "turn/start"); } catch { return []; }
    };
    await check({ api, control, respond, backupPrompts: sent, dataDir });
  } finally {
    evidence.push({ backupPrompts: existsSync(backupFile) ? readFileSync(backupFile, "utf8").slice(0, 20_000) : null, roots: readHandoffs(dataDir) });
    const evidencePath = `${logPath}.quota-switch.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

/** A bot whose conversation runs on the limited engine, and the turn that meets the limit. `carriedOn`: another AI may
 * already have taken the request over by the time the wait ends. */
async function meetTheLimit(api: (method: string, path: string, body?: unknown) => Promise<any>, control: (...args: string[]) => Promise<any>, text: string, carriedOn = false) {
  const { bot } = await control("new-bot", "--name", "Out of quota");
  const threadId = bot.activeTaskId as string;
  const limited = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { ...limited, instanceId: "claude" }, updateBotDefault: true });
  await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  expect(carriedOn ? ["failed", "settled"] : ["failed"]).toContain((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status);
  const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
  return { bot, threadId, messages, state };
}

it("carries the request on with another AI by itself: the exact message once more there, one notice, the failed root left settled", async () => {
  await withQuotaFixture({}, async ({ api, control, backupPrompts, dataDir }) => {
    const text = "SUMMARISE_THE_QUARTER_4K";
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, text, true);
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps its engine" });

    await expect.poll(async () => (await messages()).findLast((message) => message.role === "bot" && message.kind === "text")?.text, { timeout: 30_000 }).toBe("done from fake codex");
    const after = await messages();
    const failures = after.filter((message) => message.tool?.name?.startsWith("error:"));
    expect(failures).toHaveLength(1);
    expect(failures[0].tool.name).toMatch(/This Claude account has reached its usage limit/);
    expect(after.some((message) => message.card?.quotaSwitch), "nothing to answer").toBe(false);
    expect(after.filter((message) => message.tool?.name === "notice: continuing on Codex after hitting the usage limit")).toHaveLength(1);
    // The message whose turn failed, sent once more: twice in the conversation, once to the AI that works.
    expect(after.filter((message) => message.role === "user" && message.text === text)).toHaveLength(2);
    expect(backupPrompts()).toHaveLength(1);
    expect(JSON.stringify(backupPrompts()[0])).toContain(text);

    // This conversation moved; the bot's own engine and its other conversation did not.
    const bots = await state();
    expect(bots.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: { instanceId: "codex" }, busy: false });
    expect(bots.modelSelection.instanceId).toBe("claude");
    expect(bots.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection?.instanceId ?? bots.modelSelection.instanceId).toBe("claude");
    // No job twice: the failed turn's root stayed settled, and the resend is one new root that completed.
    expect(readHandoffs(dataDir).filter((node) => node.threadId === threadId).map((node) => [node.status, node.executions])).toEqual([["failed", 1], ["completed", 1]]);
    // One notice for this bot; the Chief, told of the incident, hears its own if its own turn meets the limit too.
    const notices = (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    expect(notices.map((entry: any) => entry.body)).toEqual([expect.stringMatching(/^Limited Claude reached its limit.*, so Out of quota is using Codex meanwhile\.$/)]);
  });
}, 240_000);

it("never moves to another sign-in of the same AI: it says once that the bot waits, and sends nothing again", async () => {
  await withQuotaFixture({ otherSignInOnly: true }, async ({ api, control, backupPrompts }) => {
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, "LEAVE_THIS_WHERE_IT_IS_7M");
    const mine = async () => (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    await expect.poll(async () => (await mine()).length, { timeout: 20_000 }).toBe(1);
    const [notice] = await mine();
    expect(notice.body).toMatch(/^Limited Claude reached its limit.*, so Out of quota waits.*: no other AI you have set up can take over\.$/);
    expect((await messages()).filter((entry) => entry.role === "user")).toHaveLength(1);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
  });
}, 240_000);

it("moves nothing when OMB_QUOTA_SWITCH=0 switches it off", async () => {
  await withQuotaFixture({ env: { OMB_QUOTA_SWITCH: "0" } }, async ({ api, control, backupPrompts }) => {
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, "NO_MOVE_WHEN_OFF_2B");
    const mine = async () => (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    await expect.poll(async () => (await mine()).length, { timeout: 20_000 }).toBe(1);
    expect((await mine())[0].body).toMatch(/, so Out of quota waits.*: no other AI you have set up can take over\.$/);
    expect((await messages()).filter((message) => message.role === "user")).toHaveLength(1);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
  });
}, 240_000);
