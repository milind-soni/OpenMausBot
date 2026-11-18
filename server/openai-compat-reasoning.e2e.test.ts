import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("retains a custom API's selected reasoning level and sends it after restart", async () => {
  const rows: Array<Record<string, unknown>> = [{ id: "fixture/future", reasoning_efforts: ["low", "high", "xhigh", "max"] }];
  const bodies: Array<Record<string, any>> = [];
  const provider = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: rows }));
      return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const part of request) body += part.toString();
    bodies.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const fixture = await launchVerificationServer().catch(async (error: unknown) => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    throw error;
  });
  const { dataDir, url, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.ok, method + " " + path + ": " + JSON.stringify(result)).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const restart = async () => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 25_000 }).toBe(true);
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.compatFixture = {
      driver: "openai-compat", displayName: "Compatible fixture",
      config: { url: "http://127.0.0.1:" + address.port + "/v1", key: "fixture-key", tools: false },
    };
    writeFileSync(configPath, JSON.stringify(config));
    await restart();
    const refreshed = await api("POST", "/api/instances/compatFixture/refresh-models", {});
    const engine = refreshed.instances.find((entry: any) => entry.instanceId === "compatFixture");
    expect(engine.capabilities.modelVariants).toBe(true);
    expect(engine.models.options.find((option: any) => option.id === "fixture/future").variants.map((variant: any) => variant.id))
      .toEqual(["low", "high", "xhigh", "max"]);
    const created = (await control("new-bot", "--name", "Compatible reasoning fixture")).bot;
    const threadId = created.activeTaskId ?? created.threadId;
    const selection = { instanceId: "compatFixture", model: "fixture/future", variant: "max" };
    await api("PATCH", "/api/bots/" + created.id + "/tasks/" + threadId, { modelSelection: selection, updateBotDefault: true, requireAvailableModel: true });
    expect((await control("send", "--bot", created.id, "--task", threadId, "--text", "Fixture selection check.")).success).toBe(true);
    expect((await control("wait", "--bot", created.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(bodies.some((body) => body.model === "fixture/future" && body.reasoning_effort === "max")).toBe(true);

    await restart();
    const saved = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === created.id);
    expect(saved.modelSelection).toEqual(selection);
    expect(saved.tasks.find((task: any) => task.threadId === threadId).modelSelection).toEqual(selection);
    rows.push({ id: "another/new-model" });
    const afterRestart = await api("POST", "/api/instances/compatFixture/refresh-models", {});
    const newModel = afterRestart.instances.find((entry: any) => entry.instanceId === "compatFixture")
      .models.options.find((option: any) => option.id === "another/new-model");
    expect(newModel.variants.map((variant: any) => variant.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const before = bodies.length;
    expect((await control("send", "--bot", created.id, "--task", threadId, "--text", "Check after restart.")).success).toBe(true);
    expect((await control("wait", "--bot", created.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(bodies.slice(before).some((body) => body.model === "fixture/future" && body.reasoning_effort === "max")).toBe(true);
  } finally {
    try {
      await waitForExit(restarted, { signal: "SIGTERM" });
      await fixture.close();
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }
}, 120_000);
