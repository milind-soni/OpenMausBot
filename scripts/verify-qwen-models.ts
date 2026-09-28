// Offline end-to-end Qwen selection, using the standard isolated OMB launcher.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { readQwenModelCatalog } from "../server/drivers/acp/qwen.ts";

const fixture = await launchVerificationServer();
const { url, dataDir } = fixture.info;
const control = (args: string[]) => runControlOmb([...args, "--url", url]);
const evidence: unknown[] = [];
try {
  mkdirSync(join(dataDir, ".qwen"));
  writeFileSync(join(dataDir, ".qwen/settings.json"), JSON.stringify({ modelProviders: {
    openai: [{ id: "same" }, { id: "same", name: "Proxy", baseUrl: "https://proxy.example/v1" }],
    anthropic: [{ id: "same" }],
  } }));
  const expected = readQwenModelCatalog({ HOME: dataDir, USERPROFILE: dataDir });
  const dump = join(dataDir, "qwen-spawn.json");
  const methods = join(dataDir, "qwen-methods.json");
  const blockSwitch = join(dataDir, "reject-switch");
  const rpcAppend = join(dataDir, "qwen-rpc-append.jsonl");
  const useAgents = join(dataDir, "use-agents");
  const cli = join(dataDir, "fixture-qwen.ts");
  const fake = pathToFileURL(fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url))).href;
  writeFileSync(cli, `#!/usr/bin/env node
import { existsSync } from "node:fs";
process.env.FAKE_ACP_MODELS = ${JSON.stringify(expected.options.map((option) => option.id).join(","))};
process.env.FAKE_ACP_DUMP = ${JSON.stringify(dump)};
process.env.FAKE_ACP_RPC_DUMP = ${JSON.stringify(methods)};
process.env.FAKE_ACP_RPC_APPEND_FILE = ${JSON.stringify(rpcAppend)};
process.env.FAKE_ACP_CACHED_LIVE_LOAD = "1";
if (existsSync(${JSON.stringify(useAgents)})) process.env.FAKE_ACP_MODE = "safe-agent-reads";
if (existsSync(${JSON.stringify(blockSwitch)})) process.env.FAKE_ACP_MODEL_STICKS = "1";
await import(${JSON.stringify(fake)});
`, { mode: 0o755 });
  const configured = await fetch(`${url}/api/instances/qwen`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli }),
  });
  assert.equal(configured.status, 200, await configured.text());
  const catalog = await control(["models"]) as { instances: Array<{ instanceId: string; models: typeof expected }> };
  assert.deepEqual(catalog.instances.find((instance) => instance.instanceId === "qwen")?.models, expected);
  for (const [name, model, rejects] of [
    ["Other provider", "same(anthropic)", false],
    ["Other endpoint", expected.options[1].id, false],
    ["Rejected switch", "same(anthropic)", true],
  ] as const) {
    if (rejects) writeFileSync(blockSwitch, "1");
    const created = await control(["new-bot", "--name", name]) as { bot: { id: string } };
    const id = created.bot.id;
    await control(["set-model", "--bot", id, "--instance", "qwen", "--model", model]);
    await control(["send", "--bot", id, "--text", "Say hello."]);
    const wait = await control(["wait", "--bot", id, "--timeout", "30"]) as { status: string };
    const messages = await control(["messages", "--bot", id]) as { messages: Array<{ text?: string }> };
    assert.equal(wait.status, rejects ? "failed" : "settled");
    assert.equal(messages.messages.some((message) => message.text === "hello from fake acp"), !rejects);
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    assert(calls.some((call: { params: { value?: string } }) => call.params.value === model));
    const rpc = JSON.parse(readFileSync(methods, "utf8")) as string[];
    assert.equal(rpc.includes("session/prompt"), !rejects);
    if (!rejects) assert(rpc.indexOf("session/set_config_option") < rpc.indexOf("session/prompt"));
    evidence.push({ name, model, wait, messages, calls, rpc });
  }
  // Qwen acknowledges a live load without replacing its MCP configuration.
  // Each new bearer must therefore resume on a fresh child. Real proxy calls
  // prove authentication on session/new and two successive session/load turns.
  unlinkSync(blockSwitch);
  writeFileSync(useAgents, "1");
  writeFileSync(rpcAppend, "");
  const created = await control(["new-bot", "--name", "Rotating credentials"]) as { bot: { id: string } };
  const id = created.bot.id;
  await control(["set-model", "--bot", id, "--instance", "qwen", "--model", expected.options[1].id]);
  const auto = await fetch(`${url}/api/bots/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalMode: "auto" }),
  });
  assert.equal(auto.status, 200, await auto.text());
  const pids = new Set<number>();
  const tokens = new Set<string>();
  for (const turn of [1, 2, 3]) {
    await control(["send", "--bot", id, "--text", `Read the team roster and search history. Turn ${turn}.`]);
    const wait = await control(["wait", "--bot", id, "--timeout", "30"]) as { status: string };
    const messages = await control(["messages", "--bot", id]) as { messages: Array<{ kind?: string; text?: string }> };
    const pid = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
    const rpc = readFileSync(rpcAppend, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; method: string });
    const revokedStatuses: number[] = [];
    evidence.push({ name: `Authenticated turn ${turn}`, wait, messages, pid, rpc, revokedStatuses });
    assert.equal(wait.status, "settled", `Turn ${turn}: ${JSON.stringify(messages)}`);
    const text = messages.messages.filter((message) => message.kind === "text").map((message) => message.text ?? "").join("\n");
    assert.equal(text.match(/^list_bots:/gm)?.length, turn * 2, "both roster calls must succeed on every turn");
    assert.equal(text.match(/^session_search:/gm)?.length, turn, "history search must succeed on every turn");
    pids.add(pid);
    assert.equal(pids.size, turn, "rotated MCP credentials require a fresh Qwen process");
    assert.equal(rpc.filter(({ method }) => method === "initialize").length, turn);
    assert.equal(rpc.filter(({ method }) => method === "session/new").length, 1);
    assert.equal(rpc.filter(({ method }) => method === "session/load").length, turn - 1);
    assert.equal(rpc.filter(({ method }) => method === "session/prompt").length, turn);
    const currentRpc = rpc.filter((call) => call.pid === pid).map((call) => call.method);
    const selection = currentRpc.indexOf("session/set_config_option");
    assert(selection >= 0 && selection < currentRpc.indexOf("session/prompt"));
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ params: { value?: string } }>;
    assert(calls.some((call) => call.params.value === expected.options[1].id), "every resumed turn must restore the chosen endpoint");
    const servers = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string; env: Array<{ name: string; value: string }> }>;
    const token = servers.find((server) => server.name === "agents")?.env.find((entry) => entry.name === "OMB_COMMS_TOKEN")?.value;
    assert(token, "the agents proxy must receive turn credentials");
    tokens.add(token);
    assert.equal(tokens.size, turn, "each turn must receive a distinct token");
    for (const expired of tokens) {
      const response = await fetch(`${url}/api/internal/agents?self=${id}`, { headers: { authorization: `Bearer ${expired}` } });
      revokedStatuses.push(response.status);
      assert.equal(response.status, 401, "settled turns must lose agents access");
    }
  }
  console.log(JSON.stringify({ ok: true, fixture: fixture.info, evidence }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, fixture: fixture.info, evidence }, null, 2));
  throw error;
} finally { await fixture.close(); }
