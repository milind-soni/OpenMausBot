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
  const rejectLiveLoad = join(dataDir, "reject-live-load");
  const cli = join(dataDir, "fixture-qwen.ts");
  const fake = pathToFileURL(fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url))).href;
  writeFileSync(cli, `#!/usr/bin/env node
import { existsSync } from "node:fs";
process.env.FAKE_ACP_MODELS = ${JSON.stringify(expected.options.map((option) => option.id).join(","))};
process.env.FAKE_ACP_DUMP = ${JSON.stringify(dump)};
process.env.FAKE_ACP_RPC_DUMP = ${JSON.stringify(methods)};
process.env.FAKE_ACP_RPC_APPEND_FILE = ${JSON.stringify(rpcAppend)};
process.env.FAKE_ACP_REJECT_LIVE_LOAD_FILE = ${JSON.stringify(rejectLiveLoad)};
if (existsSync(${JSON.stringify(blockSwitch)})) process.env.FAKE_ACP_MODEL_STICKS = "1";
await import(${JSON.stringify(fake)});
`, { mode: 0o755 });
  const configured = await fetch(`${url}/api/instances/qwen`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli }),
  });
  assert.equal(configured.status, 200, await configured.text());
  const catalog = await control(["models"]) as { instances: Array<{ instanceId: string; models: typeof expected }> };
  assert.deepEqual(catalog.instances.find((instance) => instance.instanceId === "qwen")?.models, expected);
  const evidence: unknown[] = [];
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
  // Pooled agent process (issue #1570): a second turn on the same thread
  // must ride the same CLI process — one initialize and one session/new
  // total, two prompts. The harness rotates the agents bearer token every
  // turn, so the second turn re-establishes the native session (one
  // session/load with the fresh credentials) instead of prompting a session
  // whose tool credentials were revoked at the last turn boundary. The
  // spawn dump carries the pid so a silent respawn cannot pass as reuse.
  const pooled = await control(["new-bot", "--name", "Pooled"]) as { bot: { id: string } };
  const pooledId = pooled.bot.id;
  await control(["set-model", "--bot", pooledId, "--instance", "qwen", "--model", expected.options[0].id]);
  await control(["send", "--bot", pooledId, "--text", "First."]);
  assert.equal((await control(["wait", "--bot", pooledId, "--timeout", "30"]) as { status: string }).status, "settled");
  const pidAfterFirst = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
  const rpcAfterFirst = JSON.parse(readFileSync(methods, "utf8")) as string[];
  assert.equal(rpcAfterFirst.filter((method) => method === "initialize").length, 1);
  await control(["send", "--bot", pooledId, "--text", "Second."]);
  const wait = await control(["wait", "--bot", pooledId, "--timeout", "30"]) as { status: string };
  assert.equal(wait.status, "settled");
  const messages = await control(["messages", "--bot", pooledId]) as { messages: Array<{ text?: string }> };
  assert(messages.messages.some((message) => message.text === "hello from fake acp"));
  const pidAfterSecond = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
  const rpcAfterSecond = JSON.parse(readFileSync(methods, "utf8")) as string[];
  assert.equal(pidAfterSecond, pidAfterFirst, "the agent process must stay pooled across turns");
  assert.equal(rpcAfterSecond.filter((method) => method === "initialize").length, 1);
  assert.equal(rpcAfterSecond.filter((method) => method === "session/new").length, 1);
  assert.equal(rpcAfterSecond.filter((method) => method === "session/load").length, 1);
  assert.equal(rpcAfterSecond.filter((method) => method === "session/prompt").length, 2);
  evidence.push({ name: "Pooled second turn", wait, messages, pidAfterFirst, pidAfterSecond, rpc: rpcAfterSecond });
  // Reestablish fallback (issue #1570): the pooled child refuses session/load
  // of its own live session. OMB closes that child, pays the handshake once
  // on a fresh process, and loads the conversation there — never session/new
  // for continuity. FAKE_ACP_RPC_DUMP is rewritten per process, so counts
  // come from the append log that survives the respawn.
  const readAppendedRpc = () => readFileSync(rpcAppend, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method: string }).method);
  writeFileSync(rpcAppend, "");
  const reestablish = await control(["new-bot", "--name", "Reestablish fallback"]) as { bot: { id: string } };
  const reestablishId = reestablish.bot.id;
  await control(["set-model", "--bot", reestablishId, "--instance", "qwen", "--model", expected.options[0].id]);
  await control(["send", "--bot", reestablishId, "--text", "First"]);
  assert.equal((await control(["wait", "--bot", reestablishId, "--timeout", "30"]) as { status: string }).status, "settled");
  const reestablishPidAfterFirst = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
  const reestablishRpcAfterFirst = readAppendedRpc();
  assert.equal(reestablishRpcAfterFirst.filter((method) => method === "initialize").length, 1);
  writeFileSync(rejectLiveLoad, "1");
  await control(["send", "--bot", reestablishId, "--text", "Second"]);
  const reestablishWait = await control(["wait", "--bot", reestablishId, "--timeout", "30"]) as { status: string };
  assert.equal(reestablishWait.status, "settled");
  const reestablishMessages = await control(["messages", "--bot", reestablishId]) as { messages: Array<{ text?: string }> };
  assert(reestablishMessages.messages.some((message) => message.text === "hello from fake acp"));
  const reestablishPidAfterSecond = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
  const reestablishRpc = readAppendedRpc();
  assert.notEqual(reestablishPidAfterSecond, reestablishPidAfterFirst, "the agent process must respawn when live load is refused");
  assert.equal(reestablishRpc.filter((method) => method === "initialize").length, 2);
  assert.equal(reestablishRpc.filter((method) => method === "session/new").length, 1);
  assert.equal(reestablishRpc.filter((method) => method === "session/load").length, 2);
  assert.equal(reestablishRpc.filter((method) => method === "session/prompt").length, 2);
  evidence.push({
    name: "Reestablish fallback",
    wait: reestablishWait,
    messages: reestablishMessages,
    pidAfterFirst: reestablishPidAfterFirst,
    pidAfterSecond: reestablishPidAfterSecond,
    rpc: reestablishRpc,
  });
  unlinkSync(rejectLiveLoad);
  console.log(JSON.stringify({ ok: true, fixture: fixture.info, evidence }, null, 2));
} finally { await fixture.close(); }
