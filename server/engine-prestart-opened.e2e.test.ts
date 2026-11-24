import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

it("opening a conversation whose engine has closed starts it again, resuming its session, and the next message runs in it", async () => {
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
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(200);
    return value;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const jsonLines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const launches = () => (jsonLines(launchesFile) as Array<{ pid: number; argv: string[] }>).filter((launch) => launch.argv.includes("--input-format"));
  try {
    // Restarted with an idle time short enough to see the engine close, and without the free-memory reading so the
    // runner's free memory does not decide the outcome.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_SESSION_IDLE_MS: "10000", OMB_ENGINE_PRESTART: "unmetered",
        FAKE_CLAUDE_LAUNCHES: launchesFile, FAKE_CLAUDE_PROMPTS: promptsFile, FAKE_CLAUDE_MCP_RECONNECT: join(dataDir, "relists.jsonl") },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);

    const { bot } = await control("new-bot", "--name", "Prestart bot");
    const threadId = bot.activeTaskId as string;
    const send = async (text: string) => {
      await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const closed = () => expect.poll(() => launches().every((launch) => !alive(launch.pid)), { timeout: 30_000, interval: 250 }).toBe(true);

    await send("FIRST_PRESTART_1");
    expect(launches(), JSON.stringify(launches())).toHaveLength(1);
    await closed();

    const before = await messages();
    await api("POST", `/api/bots/${bot.id}/tasks/${threadId}?messages=0`);
    await expect.poll(() => launches().length, { timeout: 15_000 }).toBe(2);
    const spare = launches()[1]!;
    expect(spare.argv).toContain("--resume");
    expect(alive(spare.pid)).toBe(true);
    // Started, and nothing said: no prompt reached the engine, nothing was written to the conversation.
    expect(jsonLines(promptsFile)).toHaveLength(1);
    expect(await messages()).toEqual(before);

    await send("SECOND_PRESTART_2");
    expect(launches()).toHaveLength(2);
    expect(jsonLines(promptsFile)).toHaveLength(2);
    expect((await messages()).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["FIRST_PRESTART_1", "SECOND_PRESTART_2"]);
    expect((await messages()).findLast((message) => message.role === "bot" && message.kind === "text")?.turnSucceeded).toBe(true);
    evidence.push({ launches: launches(), messages: await messages() });
  } finally {
    writeFileSync(`${logPath}.prestart-opened.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
