// A real OMB conversation must survive a poisoned ACP process without the
// person deleting its thread, and without replaying the failed turn's tools.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it.each([false, true])("recovers the same conversation after an ACP internal error without replay (output: %s)", async (afterOutput) => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const failureFile = join(dataDir, "rpc-failure.json");
  const rpcFile = join(dataDir, "rpc.jsonl");
  const dumpFile = join(dataDir, "acp-dump.json");
  const evidence: unknown[] = [{ url, dataDir, afterOutput }];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const calls = () => existsSync(rpcFile)
    ? readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; method: string }) : [];
  const prompts = () => calls().filter((call) => call.method === "session/prompt");
  try {
    // Add only the repository-owned synthetic provider to the launcher's
    // temporary config while stopped. Never discover the person's CLI/home.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "Recovery fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: {
        FAKE_ACP_MODELS: "fixture/recovery", FAKE_ACP_DUMP: dumpFile, FAKE_ACP_DUMP_PROMPT: "1",
        FAKE_ACP_RPC_APPEND_FILE: rpcFile, FAKE_ACP_RPC_FAILURE_FILE: failureFile,
        ...(afterOutput ? { FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT: "1" } : {}),
      },
    };
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

    const { bot } = await control("new-bot", "--name", "Recovery bot");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/recovery" } });
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const task = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)
      .tasks.find((entry: any) => entry.threadId === threadId);
    const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const wait = () => control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
    const firstText = "REMEMBER_RECOVERY_7Q";
    const failedText = "FAILED_WORK_8R";
    const retryText = "EXPLICIT_RETRY_9S";

    await send(firstText);
    expect((await wait()).status).toBe("settled");
    expect(prompts()).toHaveLength(1);
    const firstProcess = prompts()[0].pid;

    writeFileSync(failureFile, JSON.stringify({ code: -32603, message: "Internal error", data: { details: "OpenCode service failure" } }));
    await send(failedText);
    await expect.poll(async () => (await messages()).some((message) => message.tool?.ok === false &&
      /OpenCode service failure/.test(message.tool.name)), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await task()).busy, { timeout: 20_000 }).toBe(false);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1].pid).toBe(firstProcess);
    expect(calls().filter((call) => call.method === "session/prompt.error")).toHaveLength(1);
    evidence.push({ failedTask: await task(), promptCallsBeforeRetry: prompts() });

    // The fake keeps the error cached in its process even after removal.
    // Only a replacement process can answer this explicit next user message.
    rmSync(failureFile);
    await send(retryText);
    expect((await wait()).status).toBe("settled");
    expect(prompts()).toHaveLength(3);
    expect(prompts()[2].pid).not.toBe(firstProcess);
    const prompt = JSON.stringify(JSON.parse(readFileSync(`${dumpFile}.prompt.json`, "utf8")));
    expect(prompt.split(retryText).length - 1).toBe(1);
    // Native resume owns the old history; it must not receive it twice.
    expect(prompt).not.toContain(firstText);
    expect(prompt).not.toContain(failedText);
    const finalMessages = await messages();
    for (const text of [firstText, failedText, retryText]) {
      expect(finalMessages.filter((message) => message.role === "user" && message.text === text)).toHaveLength(1);
    }
    expect(finalMessages.findLast((message) => message.role === "bot" && message.kind === "text")?.turnSucceeded).toBe(true);
    expect((await task()).busy).toBe(false);
    evidence.push({ task: await task(), calls: calls(), messages: finalMessages, prompt });
  } finally {
    const evidencePath = `${logPath}.acp-recovery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
