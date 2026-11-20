import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const engineId = "cursor-fixture";
// cursor-agent 2026.10.22 sends a failed model call as this one chunk, then waits on a backgrounded shell, then end_turn.
const FAILED_CALL = [
  { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nError: RetriableError: [unavailable] HTTP 503" } } },
  { update: { sessionUpdate: "tool_call", toolCallId: "watch-1", title: "Watching: wait until 06:15", kind: "other" } },
  { update: { sessionUpdate: "tool_call_update", toolCallId: "watch-1", status: "completed" } },
];

it("fails a Cursor turn and retries its routine run when Cursor reports a failed model call as its reply", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const updatesFile = join(dataDir, "cursor-updates.json");
  const evidence: unknown[] = [{ fixture: fixture.info, provider: "fake cursor-agent ACP, no network" }];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
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
    config.instances[engineId] = { driver: "cursorAgent", displayName: "Cursor fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FAKE_ACP_VERSION: "2026.10.22-27dcf5f", FAKE_ACP_MODELS_LIST: "auto-only", FAKE_ACP_UPDATES_FILE: updatesFile } };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(updatesFile, JSON.stringify(FAILED_CALL));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 25_000 }).toBe(true);

    for (const starter of (await api("GET", "/api/bots")).bots.filter((bot: any) => bot.chiefOfStaff)) {
      await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    }
    const bot = (await control("new-bot", "--name", "Cursor routine")).bot;
    const threadId: string = bot.activeTaskId ?? bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, {
      modelSelection: { instanceId: engineId, model: "auto" }, updateBotDefault: true,
    });

    expect((await control("send", "--bot", bot.id, "--task", threadId, "--text", "Post the queue.")).success).toBe(true);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).state).toBe("failed");
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    expect(messages.some((message: any) => JSON.stringify(message).includes("RetriableError"))).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({ kind: "activity", tool: expect.objectContaining({
      ok: false, name: expect.stringContaining("Cursor had a temporary server problem (HTTP 503)") }) }));

    const { routine } = await api("POST", "/api/routines", { name: "Morning post", prompt: "Post the queue.", botId: bot.id,
      schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {}, 201);
    const current = async () => {
      const found = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
      evidence.push({ at: Date.now(), run: found });
      return found;
    };
    await expect.poll(async () => { const { status, retried } = await current(); return { status, retried }; }, { timeout: 30_000, interval: 500 })
      .toEqual({ status: "queued", retried: "provider" });
    writeFileSync(updatesFile, "[]");
    await expect.poll(async () => (await current()).status, { timeout: 60_000, interval: 1_000 }).toBe("completed");
  } finally {
    writeFileSync(`${logPath}.cursor-reply-failure.json`, JSON.stringify({ evidence }, null, 2));
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
  }
}, 120_000);
