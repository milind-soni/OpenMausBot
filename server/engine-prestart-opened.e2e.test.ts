import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

it("opening a conversation whose engine has closed starts it from the bot's last launch in another conversation, resuming its own session, and the next message runs in it; an archived one starts nothing", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const launchesFile = join(dataDir, "launches.jsonl"), promptsFile = join(dataDir, "prompts.jsonl");
  const evidence: unknown[] = [{ url, dataDir }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value).slice(0, 300)}`).toBe(true);
    return value;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const jsonLines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const launches = () => (jsonLines(launchesFile) as Array<{ pid: number; argv: string[] }>).filter((launch) => launch.argv.includes("--input-format"));
  // Run as the desktop app runs its server (only there does opening a conversation start its engine): every request
  // carries the app's owner capability.
  const owner = randomBytes(32).toString("base64url");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
  try {
    // Restarted with an idle time short enough to see the engine close, and without the free-memory reading so the
    // runner's free memory does not decide the outcome.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    const env = { ...verificationServerEnvironment({ OMB_TEST_DESKTOP_OWNER_TOKEN: owner }, dataDir, Number(new URL(url).port)), OMB_SESSION_IDLE_MS: "10000",
      OMB_ENGINE_PRESTART: "unmetered", FAKE_CLAUDE_LAUNCHES: launchesFile, FAKE_CLAUDE_PROMPTS: promptsFile, FAKE_CLAUDE_MCP_RECONNECT: join(dataDir, "relists.jsonl") };
    server = spawn(process.execPath, verificationServerArgs(env), { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);

    const { bot } = await control("new-bot", "--name", "Prestart bot");
    const first = bot.activeTaskId as string;
    const second = (await api("POST", `/api/bots/${bot.id}/tasks`, { select: false })).task.threadId as string;
    const send = async (threadId: string, text: string) => {
      await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const closed = () => expect.poll(() => launches().every((launch) => !alive(launch.pid)), { timeout: 30_000, interval: 250 }).toBe(true);
    const open = (threadId: string) => api("POST", `/api/bots/${bot.id}/tasks/${threadId}?messages=0`);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 3_000));

    await send(first, "FIRST_PRESTART_1");
    // The bot's last launch is now the second conversation's.
    await send(second, "SECOND_PRESTART_1");
    await closed();
    const launched = launches().length;

    const before = await messages(first);
    await open(first);
    await expect.poll(() => launches().length, { timeout: 15_000 }).toBe(launched + 1);
    const spare = launches().at(-1)!;
    expect(spare.argv).toContain("--resume");
    expect(spare.argv.join(" ")).not.toContain(second);
    await settle();
    expect(alive(spare.pid)).toBe(true);
    // Started, and nothing said: no prompt reached the engine, nothing was written to the conversation.
    expect(jsonLines(promptsFile)).toHaveLength(2);
    expect(await messages(first)).toEqual(before);

    await send(first, "FIRST_PRESTART_2");
    expect(launches(), "the message ran in the process started on open").toHaveLength(launched + 1);
    expect(jsonLines(promptsFile)).toHaveLength(3);
    expect((await messages(first)).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["FIRST_PRESTART_1", "FIRST_PRESTART_2"]);
    expect((await messages(first)).findLast((message) => message.role === "bot" && message.kind === "text")?.turnSucceeded).toBe(true);

    await api("PATCH", `/api/bots/${bot.id}/tasks/${second}`, { archivedAt: Date.now() });
    await open(second);
    await settle();
    expect(launches(), "an archived conversation starts nothing").toHaveLength(launched + 1);
    evidence.push({ launches: launches(), first: await messages(first) });
  } finally {
    globalThis.fetch = realFetch;
    writeFileSync(`${logPath}.prestart-opened.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
