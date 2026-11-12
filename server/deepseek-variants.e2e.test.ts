import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("offers DeepSeek thinking before a prompt and retains catalog and chosen effort across restart", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const dump = join(dataDir, "deepseek-selection");
  const wireModels = ["deepseek-v4-flash", "deepseek-v4-pro"].map(model => JSON.stringify(["deepseek-official", model]));
  const variants = ["off", "low", "high", "max"];
  let restarted: ChildProcess | undefined;
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const restart = async () => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 25_000 }).toBe(true);
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.deepseek = {
      driver: "deepseekAgent", displayName: "DeepSeek fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: {
        DEEPSEEK_API_KEY: "fixture-only", DSH_HOME: join(dataDir, "dsh"),
        FAKE_ACP_MODELS: wireModels.join("\n"), FAKE_ACP_DUMP: dump,
        FAKE_ACP_VARIANTS: JSON.stringify(Object.fromEntries(wireModels.map(model => [model, {
          id: "reasoning_effort", currentValue: "high", options: variants.map(value => ({ value, name: value })),
        }]))),
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    await restart();
    const refreshed = await api("POST", "/api/instances/deepseek/refresh-models", {});
    const engine = refreshed.instances.find((entry: any) => entry.instanceId === "deepseek");
    expect(engine.capabilities.modelVariants).toBe(true);
    expect(engine.models.options.map((model: any) => ({ id: model.id, variants: model.variants }))).toEqual([
      { id: "deepseek-official/deepseek-v4-flash", variants: variants.map(id => ({ id, label: id })) },
      { id: "deepseek-official/deepseek-v4-pro", variants: variants.map(id => ({ id, label: id })) },
    ]);
    expect(existsSync(`${dump}.selection.json`)).toBe(false);
    evidence.push({ catalogBeforeFirstPrompt: engine.models });
    const created = (await control("new-bot", "--name", "DeepSeek Thinking Fixture")).bot;
    const threadId = created.activeTaskId ?? created.threadId;
    const selection = { instanceId: "deepseek", model: "deepseek-official/deepseek-v4-flash", variant: "low" };
    await api("PATCH", `/api/bots/${created.id}/tasks/${threadId}`, {
      modelSelection: selection, updateBotDefault: true, requireAvailableModel: true,
    });
    expect((await control("send", "--bot", created.id, "--task", threadId, "--text", "Fixture selection check.")).success).toBe(true);
    expect((await control("wait", "--bot", created.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    const receipt = JSON.parse(readFileSync(`${dump}.selection.json`, "utf8"));
    expect(receipt).toMatchObject({ model: wireModels[0], variant: "low" });
    evidence.push({ nativePromptSelection: receipt });
    await restart();
    const cached = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "deepseek");
    expect(cached.models).toEqual(engine.models);
    const saved = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === created.id);
    expect(saved.modelSelection).toEqual(selection);
    expect(saved.tasks.find((task: any) => task.threadId === threadId).modelSelection).toEqual(selection);
    evidence.push({ catalogAfterRestart: cached.models, savedSelection: saved.modelSelection });
  } finally {
    const evidencePath = `${logPath}.deepseek-variants.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);
