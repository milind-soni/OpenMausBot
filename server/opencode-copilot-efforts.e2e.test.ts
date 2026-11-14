import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

// Deliberate opt-in: never discover the user's CLI. The supplied OpenCode 2 binary reaches only an owned loopback
// stand-in for the Copilot API, through a synthetic credential imported into the disposable home.
const cli = process.env.OMB_OPENCODE2_E2E_CLI;
const test = cli ? it : it.skip;

type Receipt = { endpoint: string; model?: string; marker?: string; effort?: string };

const copilotModel = (id: string, endpoints: string[], supports: Record<string, unknown>) => ({
  id, name: id, version: `${id}-2026-09-01`, model_picker_enabled: true, supported_endpoints: endpoints,
  capabilities: {
    family: id, limits: { max_context_window_tokens: 200_000, max_output_tokens: 8_000, max_prompt_tokens: 190_000 },
    supports: { tool_calls: true, streaming: true, ...supports },
  },
});
// The shapes OpenCode 2.1.4 reads from Copilot's /models: an effort list, adaptive thinking on Messages, or neither.
const COPILOT_MODELS = { data: [
  copilotModel("gpt-fixture", ["/responses"], { reasoning_effort: ["low", "medium", "high", "xhigh"] }),
  copilotModel("claude-fixture", ["/v1/messages"], { adaptive_thinking: true, reasoning_effort: ["low", "medium", "high"] }),
  copilotModel("plain-fixture", ["/chat/completions"], {}),
] };

const sse = (events: Array<{ type: string; [field: string]: unknown }>) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function reply(endpoint: string, model: string, text: string): string {
  if (endpoint === "/responses") {
    const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const response = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
    return sse([
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]);
  }
  if (endpoint === "/v1/messages") {
    return sse([
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
  }
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return `${chunk({ role: "assistant", content: text })}${chunk({}, "stop")}data: [DONE]\n\n`;
}

test("offers Copilot models' efforts through OpenCode 2 and sends each turn's choice", async () => {
  expect(isAbsolute(cli!), "Supply an explicit absolute OpenCode 2 CLI path").toBe(true);
  expect(existsSync(cli!)).toBe(true);
  const receipts: Receipt[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET" && req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(COPILOT_MODELS));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    const effort = body.reasoning?.effort ?? body.output_config?.effort ?? body.reasoning_effort;
    // Retain only synthetic markers and selection metadata, never complete prompts.
    const marker = [...JSON.stringify(body.input ?? body.messages ?? []).matchAll(/EFFORT_TURN_\d+/g)].at(-1)?.[0];
    receipts.push({ endpoint: req.url!, model: body.model, marker, effort });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(reply(req.url!, body.model, `fixture-ok:${effort ?? "omitted"}`));
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
  const evidence: unknown[] = [{ fixture: fixture.info, provider: "synthetic loopback Copilot API", cli }];
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
    XDG_DATA_HOME: join(dataDir, ".local", "share"), XDG_STATE_HOME: join(dataDir, ".local", "state"),
    HERMES_HOME: join(dataDir, ".hermes"),
    TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
    OMB_PORT: new URL(url).port, OMB_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
    PATH: dirname(process.execPath), FAKE_CLAUDE_MODE: "happy",
  };
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key]) isolatedEnv[key] = process.env[key];
  }
  try {
    const nativeDir = join(dataDir, "opencode-fixture");
    mkdirSync(nativeDir);
    const modelsPath = join(nativeDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ "github-copilot": {
      id: "github-copilot", name: "GitHub Copilot", env: [], npm: "@ai-sdk/github-copilot", api: "https://api.githubcopilot.com", models: {},
    } }));
    const openCodeEnv = {
      OPENCODE_MODELS_PATH: modelsPath, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FREE_MODELS: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_FILEWATCHER: "true",
    };
    // OpenCode 2.1.4 reads the Copilot base URL from the credential's apiEndpoint.
    const credentialPath = join(nativeDir, "credential.json");
    writeFileSync(credentialPath, JSON.stringify([{
      id: "cred_fixturecopilot0001", integrationID: "github-copilot", label: "fixture", active: true,
      value: { type: "oauth", methodID: "device", refresh: "fixture-not-a-token", access: "fixture-not-a-token", expires: 0,
        metadata: { apiEndpoint: `http://127.0.0.1:${address.port}` } },
    }]));
    execFileSync(cli!, ["auth", "import", "--standalone", credentialPath], {
      cwd: nativeDir, env: { ...isolatedEnv, ...openCodeEnv }, stdio: "ignore", timeout: 60_000,
    });
    const wrapper = join(nativeDir, "opencode.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      `const env = { ...process.env, ...${JSON.stringify(openCodeEnv)} };`,
      `const child = spawn(${JSON.stringify(cli)}, process.argv.slice(2), { env, stdio: "inherit" });`,
      'for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));',
      'child.on("exit", code => process.exit(code ?? 1));',
      'child.on("error", error => { console.error(error.message); process.exit(1); });',
    ].join("\n"), { mode: 0o700 });
    // The shared launcher installs only Claude: seed this fixture's optional instance while stopped.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const ombConfigPath = join(dataDir, "config.json");
    const ombConfig = JSON.parse(readFileSync(ombConfigPath, "utf8"));
    ombConfig.instances.opencodeGo = { driver: "opencodeGo", displayName: "OpenCode fixture", config: { cli: wrapper } };
    writeFileSync(ombConfigPath, JSON.stringify(ombConfig));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: isolatedEnv, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/bots`, { signal: AbortSignal.timeout(2_000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const gpt = "github-copilot/gpt-fixture";
    const claude = "github-copilot/claude-fixture";
    const plain = "github-copilot/plain-fixture";
    const opencode = async () => (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "opencodeGo");
    await expect.poll(async () => (await opencode())?.models.options.some((option: any) => option.id === gpt), { timeout: 30_000 }).toBe(true);
    const instance = await opencode();
    expect(instance.capabilities.modelVariants).toBe(true);
    const offered = (id: string) => instance.models.options.find((option: any) => option.id === id);
    expect(offered(gpt)?.variants?.map((variant: any) => variant.id)).toEqual(["low", "medium", "high", "xhigh", "default"]);
    expect(offered(claude)?.variants?.map((variant: any) => variant.id)).toEqual(["low", "medium", "high", "default"]);
    expect(offered(plain)).not.toHaveProperty("variants");
    evidence.push({ offered: [gpt, claude, plain].map((id) => ({ id, variants: offered(id).variants ?? null })) });

    const { bot } = await control(["new-bot", "--name", "Copilot efforts"]);
    const task = bot.activeTaskId;
    let turnNumber = 0;
    const turn = async (model: string, variant: string | undefined, endpoint: string) => {
      await api("PATCH", `/api/bots/${bot.id}/tasks/${task}`, {
        modelSelection: { instanceId: "opencodeGo", model, ...(variant === undefined ? {} : { variant }) },
      });
      const marker = `EFFORT_TURN_${++turnNumber}`;
      const before = receipts.length;
      expect((await control(["send", "--bot", bot.id, "--task", task, "--text", `${marker} Reply without using tools.`])).success).toBe(true);
      expect((await control(["wait", "--bot", bot.id, "--task", task, "--timeout", "45"])).status).toBe("settled");
      expect(receipts.slice(before).filter((receipt) => receipt.marker === marker)).toEqual(expect.arrayContaining([
        { endpoint, model: model.slice(model.indexOf("/") + 1), marker, effort: variant },
      ]));
      // Native title requests carry their own effort, so the conversation's own answer is what proves the turn's.
      const transcript = await control(["messages", "--bot", bot.id, "--task", task, "--limit", "20"]);
      const answer = transcript.messages.filter((message: any) => message.role === "bot" && message.kind === "text").at(-1);
      expect(answer?.text).toBe(`fixture-ok:${variant ?? "omitted"}`);
    };
    await turn(gpt, "high", "/responses");
    await turn(gpt, "low", "/responses");
    await turn(claude, "medium", "/v1/messages");
    await turn(plain, undefined, "/chat/completions");
  } finally {
    const evidencePath = `${logPath}.opencode-copilot-efforts.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence, receipts }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 240_000);
