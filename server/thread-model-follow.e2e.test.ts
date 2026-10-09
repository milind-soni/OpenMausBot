// A thread's own model that can't run gives way to its bot's, through the
// real server and fake Claude CLIs: the turn runs on the bot's engine, the
// thread follows the bot from then on, and exactly one line says so. A
// signed-out engine gives way only when the bot's model is on another engine
// that can run; on the same engine the turn still meets its sign-in.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const SPARE = "spare";
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
const lines = (path: string): unknown[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const notice = (message: any) => typeof message.tool?.name === "string" && message.tool.name.includes("isn't available, so it now uses");

type Engines = { spare?: "missing" | "disabled" | "signed-out"; claude?: "signed-out" };
type Fixture = {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  restart: (engines: Engines) => Promise<void>;
  prompts: (instance: "claude" | typeof SPARE) => unknown[];
};

async function withEngines(check: (fixture: Fixture) => Promise<void>) {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const promptFile = (instance: string) => join(dataDir, `${instance}-prompts.jsonl`);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  /** Stop the server, set up the engines as asked, and start it again. */
  const restart = async (engines: Engines) => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const signedOut = { FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_MODE: "not-logged-in" };
    config.instances.claude = { ...config.instances.claude, environment: {
      FAKE_CLAUDE_PROMPTS: promptFile("claude"), ...(engines.claude === "signed-out" ? signedOut : {}),
    } };
    delete config.instances[SPARE];
    if (engines.spare !== "missing") {
      const configDir = join(dataDir, "spare-claude");
      mkdirSync(configDir, { recursive: true });
      config.instances[SPARE] = {
        driver: "claudeAgent", displayName: "Spare Claude", config: { cli: FAKE_CLI, configDir },
        ...(engines.spare === "disabled" ? { enabled: false } : {}),
        environment: { FAKE_CLAUDE_PROMPTS: promptFile(SPARE), ...(engines.spare === "signed-out" ? signedOut : {}) },
      };
    }
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // Reading the engines is where the server learns who is signed in.
    await api("GET", "/api/instances");
  };
  try {
    await restart({});
    await check({ api, control, restart, prompts: (instance) => lines(promptFile(instance)) });
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath }));
  }
}

/** A bot on Claude with one thread a person moved to `own`. */
async function botWithOwnModel(fixture: Fixture, own: { instanceId: string; model: string }) {
  const { bot: created } = await fixture.control("new-bot", "--name", "Ada");
  const { task } = await fixture.api("POST", `/api/bots/${created.id}/tasks`, { title: "Own model" });
  await fixture.api("PATCH", `/api/bots/${created.id}/tasks/${task.threadId}`, { modelSelection: own });
  const profile = async () => (await fixture.api("GET", "/api/bots")).bots.find((entry: any) => entry.id === created.id);
  const thread = async () => (await profile()).tasks.find((entry: any) => entry.threadId === task.threadId);
  expect(await thread()).toMatchObject({ modelSelection: own, followsBotModel: false });
  return { bot: await profile(), threadId: task.threadId as string, thread };
}

async function sendAndSettle(fixture: Fixture, botId: string, threadId: string, text: string, status = "settled") {
  await fixture.control("send", "--bot", botId, "--task", threadId, "--text", text);
  expect((await fixture.control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe(status);
  return (await fixture.api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
}

it.each([
  ["missing", "claude-opus-5"],
  ["disabled", "Spare Claude · Claude Opus 5"],
] as const)("runs a thread whose engine is %s on its bot's model, once, and the thread follows the bot", async (state, ownName) => {
  await withEngines(async (fixture) => {
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: SPARE, model: "claude-opus-5" });
    await fixture.restart({ spare: state });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "FOLLOW_THE_BOT_4K");
    expect(fixture.prompts("claude")).toHaveLength(1);
    expect(fixture.prompts(SPARE)).toHaveLength(0);
    expect(messages.filter(notice)).toHaveLength(1);
    expect(messages.find(notice).tool.name).toBe(
      `notice: This thread's model (${ownName}) isn't available, so it now uses Ada's model (Verification fixture · Claude Sonnet 5).`,
    );
    expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ turnSucceeded: true });
    expect(bot.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    expect(await thread()).toMatchObject({ modelSelection: bot.modelSelection, followsBotModel: true });
    // From then on it is an ordinary follower: no second line.
    const again = await sendAndSettle(fixture, bot.id, threadId, "STILL_FOLLOWING_5L");
    expect(again.filter(notice)).toHaveLength(1);
    expect(fixture.prompts("claude")).toHaveLength(2);
  });
}, 120_000);

it("gives way to a signed-out engine when the bot's model is on another engine that can run", async () => {
  await withEngines(async (fixture) => {
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: SPARE, model: "claude-opus-5" });
    await fixture.restart({ spare: "signed-out" });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "SIGNED_OUT_ELSEWHERE_6M");
    expect(fixture.prompts(SPARE)).toHaveLength(0);
    expect(fixture.prompts("claude")).toHaveLength(1);
    expect(messages.filter(notice)).toHaveLength(1);
    expect(messages.find(notice).tool.name).toContain("This thread's model (Spare Claude · Claude Opus 5) isn't available");
    expect((await thread()).followsBotModel).toBe(true);
  });
}, 120_000);

it("keeps the sign-in failure when the bot's model is on the same signed-out engine", async () => {
  await withEngines(async (fixture) => {
    const { bot, threadId, thread } = await botWithOwnModel(fixture, { instanceId: "claude", model: "claude-opus-5" });
    await fixture.restart({ claude: "signed-out" });
    const messages = await sendAndSettle(fixture, bot.id, threadId, "SAME_ENGINE_SIGN_IN_7N", "failed");
    expect(messages.filter(notice)).toHaveLength(0);
    // The engine's own failure, flagged as the sign-in it is (src/lib/failed-turn.ts).
    expect(messages.findLast((message) => message.kind === "activity" && message.tool?.name?.startsWith("error:"))?.tool)
      .toMatchObject({ ok: false, setup: true });
    expect(fixture.prompts("claude")).toHaveLength(1);
    expect(await thread()).toMatchObject({ modelSelection: { instanceId: "claude", model: "claude-opus-5" }, followsBotModel: false });
  });
}, 120_000);
