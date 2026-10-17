import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckpointGenerationOptions, ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { CLAUDE_CHECKPOINT_SYSTEM_PROMPT, ClaudeDriver } from "./claude.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { createClaudeCheckpointHelper } from "./claude-checkpoint.ts";
import { GrokDriver } from "./grok.ts";
import { anthropicBaseUrl, localHost } from "./local-inject.ts";

const options = (extra: Partial<CheckpointGenerationOptions> = {}): CheckpointGenerationOptions => ({
  signal: new AbortController().signal, maxTokens: 8_000, prefillTimeoutMs: null, idleTimeoutMs: 1_000, ...extra,
});
const frame = (res: ServerResponse, value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
const delta = (content: Record<string, unknown>) => ({ choices: [{ index: 0, delta: content }] });
const terminal = (res: ServerResponse, reason = "stop") => {
  frame(res, { choices: [{ index: 0, delta: {}, finish_reason: reason }] });
  frame(res, { model: "actual-fixture-model", choices: [], usage: { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } } });
  res.end("data: [DONE]\n\n");
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function openai(handler: (res: ServerResponse, body: any) => void, compatible = false) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.end('{"data":[]}'); return; }
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    handler(res, body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no fixture port");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const instance = await (compatible ? OpenAICompatDriver : GrokDriver).create({ instanceId: "checkpoint-fixture", displayName: "Fixture", enabled: true,
    config: { url: `http://127.0.0.1:${address.port}`, apiKeyEnv: "FIXTURE_KEY" }, environment: { FIXTURE_KEY: "fake-key" } });
  cleanups.push(() => instance.dispose());
  return { instance, requests };
}

describe("OpenAI checkpoint streaming", () => {
  it("keeps length-limited text and sends an append-only continuation without ordinary runtime events", async () => {
    const { instance, requests } = await openai(res => { frame(res, delta({ content: "checkpoint partial" })); terminal(res, "length"); });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent(event => events.push(event));
    const onUsage = vi.fn(); const onProgress = vi.fn();
    await expect(instance.generateCheckpoint!("original prompt", options({ model: "chosen-model", onUsage, onProgress })))
      .resolves.toEqual({ text: "checkpoint partial", stopReason: "length", outputTokens: 7 });
    expect(requests[0]).toMatchObject({ stream: true, model: "chosen-model", max_tokens: 8_000, stream_options: { include_usage: true } });
    expect(requests[0]).not.toHaveProperty("tools");
    expect(onProgress.mock.calls).toEqual([[{ textDelta: "checkpoint partial" }]]);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ model: "actual-fixture-model", input: 30, output: 7, cachedInput: 20, costUsd: undefined });
    await instance.generateCheckpoint!("original prompt", options({ maxTokens: 4_000, continuation: { partial: "prior text", instruction: "Wrap up now." } }));
    expect(requests[1].messages).toEqual([{ role: "user", content: "original prompt" }, { role: "assistant", content: "prior text" },
      { role: "user", content: expect.stringContaining("Wrap up now.") }]);
    expect(requests[1].messages[2].content).toContain("appending only new text");
    expect(requests[1].max_tokens).toBe(4_000);
    expect(events).toEqual([]);
  });

  it("allows unbounded prefill and treats hidden reasoning as meaningful progress", async () => {
    const { instance } = await openai(res => {
      const first = setTimeout(() => {
        frame(res, delta({ reasoning_content: "thinking" }));
        const second = setTimeout(() => { frame(res, delta({ reasoning_content: "still thinking" }));
          const third = setTimeout(() => { frame(res, delta({ content: "done" })); terminal(res); }, 50);
          res.once("close", () => clearTimeout(third));
        }, 50);
        res.once("close", () => clearTimeout(second));
      }, 150);
      res.once("close", () => clearTimeout(first));
    });
    const onProgress = vi.fn();
    await expect(instance.generateCheckpoint!("prompt", options({ prefillTimeoutMs: null, idleTimeoutMs: 100, onProgress })))
      .resolves.toMatchObject({ text: "done", stopReason: "stop" });
    expect(onProgress.mock.calls).toContainEqual([{ reasoningDelta: "thinking" }]);
    expect(onProgress.mock.calls).toContainEqual([{ reasoningDelta: "still thinking" }]);
  });

  it.each(["prefill", "idle"])("does not let empty heartbeat frames defeat the %s watchdog", async mode => {
    const { instance } = await openai(res => {
      if (mode === "idle") frame(res, delta({ content: "partial" }));
      const timer = setInterval(() => frame(res, delta({})), 10);
      res.once("close", () => clearInterval(timer));
    });
    await expect(instance.generateCheckpoint!("prompt", options({ prefillTimeoutMs: mode === "idle" ? null : 80, idleTimeoutMs: 80 })))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("obeys host Stop while prefill is unbounded", async () => {
    const { instance } = await openai(() => {});
    const controller = new AbortController();
    const request = instance.generateCheckpoint!("prompt", options({ signal: controller.signal, prefillTimeoutMs: null }));
    const reason = new DOMException("fixture host Stop", "AbortError");
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
  });

  it.each(["tool", "error"])("rejects %s output without executing any tools", async kind => {
    const { instance } = await openai(res => {
      if (kind === "tool") frame(res, delta({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "Bash", arguments: "{}" } }] }));
      else frame(res, { error: { message: "synthetic checkpoint server failure" } });
      terminal(res);
    });
    await expect(instance.generateCheckpoint!("prompt", options())).rejects.toThrow(kind === "tool" ? /tool calls/ : /synthetic checkpoint/);
  });
});

async function claude(mode: string, authSettings?: Record<string, unknown>): Promise<{ instance: ProviderInstance; dump: string }> {
  const scratch = mkdtempSync(join(tmpdir(), "omb-checkpoint-test-"));
  const cli = join(scratch, "fake-cli.mjs");
  const dump = join(scratch, "dump.json");
  const configDir = join(scratch, "config");
  if (authSettings) { mkdirSync(configDir); writeFileSync(join(configDir, "settings.json"), JSON.stringify(authSettings), { mode: 0o600 }); }
  writeFileSync(cli, `#!/usr/bin/env node\nimport { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('2.1.284'); process.exit(0); }
if (process.argv.includes('--help')) { console.log(''); process.exit(0); }
let prompt = ''; for await (const part of process.stdin) prompt += part;
const settingsPath = process.argv[process.argv.indexOf("--settings") + 1];
writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ settingsPath, settingsRealPath: realpathSync(settingsPath), settings: JSON.parse(readFileSync(settingsPath, "utf8")), settingsMode: statSync(settingsPath).mode & 0o777, argv: process.argv.slice(2), prompt, cwd: process.cwd(), cap: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, apiModel: process.env.ANTHROPIC_MODEL, baseUrl: process.env.ANTHROPIC_BASE_URL }));
const out = value => console.log(JSON.stringify(value));
const mode = process.env.FAKE_CLAUDE_CHECKPOINT_MODE;
out({type:'system',subtype:'init',tools:[]});
if (mode === 'hang' || mode === 'idle') {
  if (mode === 'idle') out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}});
  setInterval(() => out({type:'system',subtype:'heartbeat'}), 10);
}
else {
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 200));
  out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'reasoning'}}});
  if (mode === 'slow') {
    await new Promise(resolve => setTimeout(resolve, 70));
    out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'more reasoning'}}});
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  if (mode === 'tool') out({type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',name:'Bash'}}});
  out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'checkpoint text'}}});
  out({type:'assistant',message:{content:[{type:'text',text:'checkpoint text'}],stop_reason:mode === 'length'?'max_tokens':'end_turn'}});
  out({type:'result',is_error:mode === 'error',result:mode === 'error'?'synthetic billed failure':'checkpoint text',stop_reason:mode === 'length'?'max_tokens':'end_turn',usage:{input_tokens:10,cache_read_input_tokens:4,output_tokens:7},modelUsage:{'actual-native-model':{}},total_cost_usd:0.001});
}
`);
  chmodSync(cli, 0o755);
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const instance = await ClaudeDriver.create({ instanceId: "native-checkpoint-fixture", enabled: true, displayName: "Fixture",
    config: { cli, configDir, permissionMode: "acceptEdits", requireApiKey: !authSettings },
    environment: { ...(!authSettings ? { ANTHROPIC_API_KEY: "fake-key" } : {}), FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_CHECKPOINT_MODE: mode } });
  cleanups.push(() => instance.dispose());
  return { instance, dump };
}

describe("native Claude checkpoint streaming", () => {
  it("streams without duplicate assistant snapshots, caps the isolated request, and retains length-limited text", async () => {
    const { instance, dump } = await claude("length");
    const onProgress = vi.fn(); const onUsage = vi.fn(); const events: RuntimeEvent[] = [];
    instance.adapter.onEvent(event => events.push(event));
    await expect(instance.generateCheckpoint!("original", options({ model: "chosen-native-model", onProgress, onUsage,
      continuation: { partial: "existing partial", instruction: "Wrap up." } })))
      .resolves.toEqual({ text: "checkpoint text", stopReason: "length", outputTokens: 7 });
    expect(onProgress.mock.calls).toEqual([[{ reasoningDelta: "reasoning" }], [{ textDelta: "checkpoint text" }]]);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ model: "actual-native-model", input: 14, output: 7, cachedInput: 4, costUsd: 0.001 });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.cap).toBe("8000");
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("chosen-native-model");
    expect(seen.argv[seen.argv.indexOf("--tools") + 1]).toBe("");
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.argv).toContain("--include-partial-messages");
    expect(seen.argv).toContain("--no-session-persistence");
    expect(seen.argv[seen.argv.indexOf("--system-prompt") + 1]).toBe(CLAUDE_CHECKPOINT_SYSTEM_PROMPT);
    expect(seen.settings).toMatchObject({ disableAllHooks: true });
    expect(seen.settingsMode).toBe(0o600);
    expect(seen.prompt).toContain("original"); expect(seen.prompt).toContain("existing partial"); expect(seen.prompt).toContain("Wrap up.");
    expect(seen.prompt).toContain("Append only new text");
    expect(events).toEqual([]);
  });

  it.each(["tool", "error"])("rejects native %s output", async mode => {
    const { instance } = await claude(mode); const onUsage = vi.fn();
    await expect(instance.generateCheckpoint!("prompt", options({ onUsage }))).rejects.toThrow(mode === "tool" ? /tool call/ : /synthetic billed failure/);
    if (mode === "error") expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("keeps authentication settings out of argv in a private helper file", async () => {
    const secret = "synthetic-native-auth-secret";
    const { instance, dump } = await claude("length", { env: { ANTHROPIC_API_KEY: secret } });
    await instance.generateCheckpoint!("prompt", options());
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain(secret);
    expect(seen.settings.env.ANTHROPIC_API_KEY).toBe(secret);
    expect(seen.settingsMode).toBe(0o600);
    expect(seen.settingsRealPath).toBe(join(seen.cwd, "settings.json"));
    expect(existsSync(seen.settingsPath)).toBe(false);
  });

  it("retains an explicitly selected local-model route while passing its API model to the CLI", async () => {
    const { instance, dump } = await claude("length");
    await instance.generateCheckpoint!("prompt", options({ model: "lmstudio::fixture-model" }));
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("fixture-model");
    expect(seen.apiModel).toBe("fixture-model");
    expect(seen.baseUrl).toBe(anthropicBaseUrl(localHost("lmstudio")!));
  });

  it("allows slow native prefill and renews idle time on reasoning", async () => {
    const { instance } = await claude("slow");
    const onProgress = vi.fn();
    await expect(instance.generateCheckpoint!("prompt", options({ prefillTimeoutMs: null, idleTimeoutMs: 120, onProgress })))
      .resolves.toMatchObject({ text: "checkpoint text", stopReason: "stop" });
    expect(onProgress.mock.calls).toContainEqual([{ reasoningDelta: "more reasoning" }]);
  });

  it("does not let native heartbeat events renew the output idle watchdog", async () => {
    const { instance } = await claude("idle");
    await expect(instance.generateCheckpoint!("prompt", options({ prefillTimeoutMs: null, idleTimeoutMs: 100 })))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out heartbeat-only prefill and obeys Stop during unbounded prefill", async () => {
    const { instance } = await claude("hang");
    await expect(instance.generateCheckpoint!("prompt", options({ prefillTimeoutMs: 100 }))).rejects.toMatchObject({ name: "AbortError" });
    const controller = new AbortController();
    const request = instance.generateCheckpoint!("prompt", options({ prefillTimeoutMs: null, signal: controller.signal }));
    const reason = new DOMException("host Stop", "AbortError"); controller.abort(reason);
    await expect(request).rejects.toBe(reason);
  });
});

describe("checkpoint provider contracts", () => {
  it.each(["gpt-5", "gpt-6.1", "o3", "openai/o4-mini", "local-model"])("uses the token-limit parameter for %s", async model => {
    const { instance, requests } = await openai(res => { frame(res, delta({ content: "done" })); terminal(res); }, true);
    await instance.generateCheckpoint!("prompt", options({ model }));
    const field = model === "local-model" ? "max_tokens" : "max_completion_tokens";
    expect(requests[0][field]).toBe(options().maxTokens);
    expect(requests[0]).not.toHaveProperty(field === "max_tokens" ? "max_completion_tokens" : "max_tokens");
  });

  it.each(["configDir", "key", "url", "injectedModel"])("refuses managed checkpoint billing without valid %s", async missing => {
    const environment = vi.fn(() => ({}));
    const helper = createClaudeCheckpointHelper({
      config: { cli: "must-not-run", managed: true, configDir: missing === "configDir" ? undefined : "/fixture/managed" },
      inputEnvironment: { ...(missing === "key" ? {} : { ANTHROPIC_API_KEY: "fake" }),
        ...(missing === "url" ? {} : { ANTHROPIC_BASE_URL: "https://company.example.invalid" }) },
      environment, readClaudeAuthSettings: () => ({}), noKeyMessage: "Missing key",
    });
    await expect(helper.generateCheckpoint("prompt", options({ model: missing === "injectedModel" ? "route::personal" : "company-model" })))
      .rejects.toThrow(/personal billing will not be used/);
    expect(environment).not.toHaveBeenCalled();
    helper.close();
  });
});
