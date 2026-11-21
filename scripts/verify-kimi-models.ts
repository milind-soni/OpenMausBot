import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["kimi"]);
const { url, dataDir } = fixture.info;
const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
const subscription = "kimi-code/kimi-for-coding";
const platform = "moonshot-cn/kimi-k2.6";
const evidence: unknown[] = [];
try {
  const root = join(dataDir, ".kimi-code");
  mkdirSync(join(root, "credentials"), { recursive: true });
  writeFileSync(join(root, "credentials/kimi-code.json"), "{}");
  writeFileSync(join(root, "config.toml"), `[models."${platform}"]\nprovider = "moonshot-cn"\nmodel = "kimi-k2.6"\n`);
  const dump = join(dataDir, "kimi-spawn.json");
  const methods = join(dataDir, "kimi-methods.json");
  const reject = join(dataDir, "reject-switch");
  const cli = join(dataDir, "fixture-kimi.ts");
  const fake = pathToFileURL(fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url))).href;
  writeFileSync(cli, `#!/usr/bin/env node
import { existsSync } from "node:fs";
process.env.FAKE_ACP_MODELS = ${JSON.stringify(`${subscription},${platform}`)};
process.env.FAKE_ACP_DUMP = ${JSON.stringify(dump)};
process.env.FAKE_ACP_RPC_DUMP = ${JSON.stringify(methods)};
if (existsSync(${JSON.stringify(reject)})) process.env.FAKE_ACP_MODEL_STICKS = "1";
await import(${JSON.stringify(fake)});
`, { mode: 0o755 });
  const configured = await fetch(`${url}/api/instances/kimi`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli }),
  });
  assert.equal(configured.status, 200, await configured.text());
  for (const blocked of [false, true]) {
    if (blocked) writeFileSync(reject, "1");
    const created = await control(["new-bot", "--name", blocked ? "Rejected Kimi switch" : "Platform Kimi"]);
    const id = created.bot.id;
    await control(["set-model", "--bot", id, "--instance", "kimi", "--model", platform]);
    await control(["send", "--bot", id, "--text", "Say hello."]);
    const result = await control(["wait", "--bot", id, "--timeout", "30"]);
    assert.equal(result.status, blocked ? "failed" : "settled");
    const rpc: string[] = JSON.parse(readFileSync(methods, "utf8"));
    assert(rpc.includes("session/set_config_option"));
    assert.equal(rpc.includes("session/prompt"), !blocked);
    if (!blocked) {
      assert(rpc.indexOf("session/set_config_option") < rpc.indexOf("session/prompt"));
      const prompts = readFileSync(`${dump}.prompts.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert(prompts.every((prompt) => prompt.model === platform));
      const messages = await control(["messages", "--bot", id]);
      assert(messages.messages.some((message: { text?: string }) => message.text === "hello from fake acp"));
    }
    evidence.push({ blocked, status: result.status, rpc });
  }
  assert(existsSync(`${dump}.config.json`));
  console.log(JSON.stringify({ passed: true, logPath: fixture.info.logPath, evidence }, null, 2));
} finally {
  await fixture.close();
}
