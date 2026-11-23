import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

// The engine starts every session on its default; the bot runs on the other model.
const ENGINE_DEFAULT = "fixture/default";
const BOT_MODEL = "fixture/bot";

const jsonLines = <T>(path: string): T[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)
  : [];

it("runs a bot's memory capture on the bot's own model when the engine picks the model in the session", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  const dump = join(dataDir, "fake-acp-dump.json");
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  let server: ChildProcess | undefined;
  try {
    // Never discover the person's own CLI or home.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "Memory model fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FAKE_ACP_MODELS: `${ENGINE_DEFAULT},${BOT_MODEL}`, FAKE_ACP_DUMP: dump, FAKE_ACP_TEXT_REPLY: "[]" },
    };
    config.memory = { ...config.memory, captureQuietMs: 1_000 };
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

    const { bot } = await control("new-bot", "--name", "Local model");
    await control("set-model", "--bot", bot.id, "--instance", "opencodeGo", "--model", BOT_MODEL);
    await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "I keep the garden shed key under the blue pot.");
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

    const prompts = () => jsonLines<{ pid: number; model: string }>(`${dump}.prompts.jsonl`);
    await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(2);
    const [turn, capture] = prompts();
    expect(capture.pid).not.toBe(turn.pid);
    expect(turn.model).toBe(BOT_MODEL);
    expect(capture.model).toBe(BOT_MODEL);
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
