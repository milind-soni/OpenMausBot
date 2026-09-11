// Offline end-to-end Qwen selection, using the standard isolated OMB launcher.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const cli = join(dataDir, "fixture-qwen.ts");
  const fake = pathToFileURL(fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url))).href;
  writeFileSync(cli, `#!/usr/bin/env node
import { existsSync } from "node:fs";
process.env.FAKE_ACP_MODELS = ${JSON.stringify(expected.options.map((option) => option.id).join(","))};
process.env.FAKE_ACP_DUMP = ${JSON.stringify(dump)};
process.env.FAKE_ACP_RPC_DUMP = ${JSON.stringify(methods)};
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
  console.log(JSON.stringify({ ok: true, fixture: fixture.info, evidence }, null, 2));
} finally { await fixture.close(); }
