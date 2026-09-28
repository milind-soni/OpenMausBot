import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

// Deliberate opt-in: never discover the user's CLI or install a dependency.
// The supplied binary runs against synthetic config and an owned loopback API.
const cli = process.env.OMB_OPENCODE_E2E_CLI;
const test = cli ? it : it.skip;

type Receipt = { marker?: string; endpoint: string; model: string; effort?: string; effortPresent: boolean };

function responseEvents(model: string, effort: string | undefined) {
  const text = `fixture-ok:${effort ?? "omitted"}`;
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("persists per-conversation OpenCode efforts and sends them through ACP after server restart", async () => {
  expect(isAbsolute(cli!), "Supply an explicit absolute fixture CLI path").toBe(true);
  expect(existsSync(cli!)).toBe(true);
  const receipts: Receipt[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const effort = body.reasoning?.effort ?? body.reasoning_effort;
    // Retain only synthetic markers and selection metadata, never complete prompts.
    const marker = [...JSON.stringify(body.input ?? []).matchAll(/VARIANT_[AB]_\d+/g)].at(-1)?.[0];
    receipts.push({ marker, endpoint: req.url!, model: body.model, effort, effortPresent: Object.hasOwn(body.reasoning ?? {}, "effort") || Object.hasOwn(body, "reasoning_effort") });
    if (effort === "none") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic model does not support none" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responseEvents(body.model, effort));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fixture provider address missing");
  const fixture = await launchVerificationServer().catch(async (error) => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    throw error;
  });
  const { dataDir, url, logPath } = fixture.info;
  const evidence: unknown[] = [{ fixture: fixture.info, provider: "synthetic loopback Responses", cli }];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const isolatedEnv: NodeJS.ProcessEnv = {
    HOME: dataDir, USERPROFILE: dataDir, OMB_DATA_DIR: dataDir,
    APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
    XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
    TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
    OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
    PATH: dirname(process.execPath), FAKE_CLAUDE_MODE: "happy",
  };
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key]) isolatedEnv[key] = process.env[key];
  }
  const restart = async () => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: isolatedEnv, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/bots`, { signal: AbortSignal.timeout(2_000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const nativeDir = join(dataDir, "opencode-fixture");
    mkdirSync(nativeDir);
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const nativeModel = {
      id: "reasoning-fixture", name: "Reasoning fixture", reasoning: true, attachment: false, tool_call: true,
      temperature: false, release_date: "2026-09-02", last_updated: "2026-09-02",
      modalities: { input: ["text"], output: ["text"] }, limit: { context: 100_000, output: 1_000 },
      cost: { input: 0, output: 0 }, provider: { npm: "@ai-sdk/openai" },
      reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }],
    };
    const modelsPath = join(nativeDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ fixture: { id: "fixture", name: "Fixture", env: [], npm: "@ai-sdk/openai", api: baseURL, models: { "reasoning-fixture": nativeModel } } }));
    const configPath = join(nativeDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      model: "fixture/reasoning-fixture", small_model: "fixture/reasoning-fixture", enabled_providers: ["fixture"],
      provider: { fixture: { npm: "@ai-sdk/openai", options: { apiKey: "synthetic-fixture-key", baseURL } } },
      autoupdate: false, share: "disabled",
    }));
    const wrapper = join(nativeDir, "opencode.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      `const env = { ...process.env, OPENCODE_CONFIG: ${JSON.stringify(configPath)}, OPENCODE_MODELS_PATH: ${JSON.stringify(modelsPath)}, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" };`,
      `const child = spawn(${JSON.stringify(cli)}, [...process.argv.slice(2), "--pure"], { env, stdio: "inherit" });`,
      'for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));',
      'child.on("exit", code => process.exit(code ?? 1));',
      'child.on("error", error => { console.error(error.message); process.exit(1); });',
    ].join("\n"), { mode: 0o700 });
    // The shared launcher deliberately installs only Claude. Seed this owned
    // fixture's optional instance while stopped, then exercise its real API.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const ombConfigPath = join(dataDir, "config.json");
    const ombConfig = JSON.parse(readFileSync(ombConfigPath, "utf8"));
    ombConfig.instances.opencodeGo = { driver: "opencodeGo", displayName: "OpenCode fixture", config: { cli: wrapper } };
    writeFileSync(ombConfigPath, JSON.stringify(ombConfig));
    await restart();
    const instances = (await api("GET", "/api/instances")).instances;
    const instance = instances.find((entry: any) => entry.instanceId === "opencodeGo");
    expect(instance.capabilities.modelVariants).toBe(true);
    const model = instance.models.options.find((entry: any) => entry.id === "fixture/reasoning-fixture");
    expect(model.variants).toEqual(expect.arrayContaining([{ id: "low", label: expect.any(String) }]));
    expect(model.variants.some((entry: any) => entry.id === "none")).toBe(false);
    const { bot } = await control(["new-bot", "--name", "Variant fixture"]);
    const taskA = bot.activeTaskId;
    const taskB = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Variant B" }, 201)).task.threadId;
    const selection = (variant: string) => ({ instanceId: "opencodeGo", model: model.id, variant });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${taskA}`, { modelSelection: selection("low") });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${taskB}`, { modelSelection: selection("default") });
    const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    const assertSelections = async () => {
      const current = await state();
      expect(current.tasks.find((task: any) => task.threadId === taskA).modelSelection).toEqual(selection("low"));
      expect(current.tasks.find((task: any) => task.threadId === taskB).modelSelection).toEqual(selection("default"));
      evidence.push({ persistedSelections: { A: selection("low"), B: selection("default") } });
    };
    const turn = async (taskId: string, marker: string, effort: string | undefined) => {
      const before = receipts.length;
      expect((await control(["send", "--bot", bot.id, "--task", taskId, "--text", `${marker} Reply fixture-ok without using tools.`])).success).toBe(true);
      expect((await control(["wait", "--bot", bot.id, "--task", taskId, "--timeout", "45"])).status).toBe("settled");
      const captured = receipts.slice(before).filter((receipt) => receipt.marker === marker);
      expect(captured).toEqual(expect.arrayContaining([expect.objectContaining({ endpoint: "/v1/responses", model: "reasoning-fixture", effortPresent: effort !== undefined, ...(effort === undefined ? {} : { effort }) })]));
      expect(captured.some((receipt) => receipt.effort === "none")).toBe(false);
      // Auxiliary calls (for example, native title generation) must not make
      // an incorrect main-conversation effort look like a passing capture.
      const transcript = await control(["messages", "--bot", bot.id, "--task", taskId, "--limit", "20"]);
      const reply = transcript.messages.filter((message: any) => message.role === "bot" && message.kind === "text").at(-1);
      expect(reply?.text).toBe(`fixture-ok:${effort ?? "omitted"}`);
    };
    await assertSelections();
    await turn(taskA, "VARIANT_A_1", "low");
    await turn(taskB, "VARIANT_B_1", undefined);
    await assertSelections();
    // A real server restart verifies durable model choices, not just client state.
    await restart();
    await assertSelections();
    await turn(taskA, "VARIANT_A_2", "low");
    await turn(taskB, "VARIANT_B_2", undefined);
    await assertSelections();
  } finally {
    const evidencePath = `${logPath}.opencode-variants.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence, receipts }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 180_000);
