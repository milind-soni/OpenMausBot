import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { botBox } from "../bot-box/box.ts";
import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { brokerSocketCandidates, ClaudeDriver, hookTokenFile } from "../drivers/claude.ts";
import { PiDriver } from "../drivers/pi.ts";

const engine = process.argv[2], fallback = process.argv[3] === "true";
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
const cli = fileURLToPath(new URL("./boxed-turn-cli.ts", import.meta.url));
ensureDirs();
mkdirSync(tmpdir(), { recursive: true });
writeFileSync(join(DATA_DIR, "messages.db"), "private fixture");
const otherToken = hookTokenFile("other-thread", "other-bot");
mkdirSync(dirname(otherToken), { recursive: true });
writeFileSync(otherToken, "other fixture");
const cwd = join(DATA_DIR, "task-workspaces", "bot-a", "thread");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(DATA_DIR, "workspaces", "bot-a"), { recursive: true });
if (fallback) mkdirSync(brokerSocketCandidates("thread", "bot-a")[0]!);

let instance: ProviderInstance | undefined;
let asks = 0, socket: string | undefined, probe: unknown;
const errors: string[] = [];
const probes: unknown[] = [];
try {
  await botBox.start({ dataDir: DATA_DIR, home: homedir(), port: 8799, denyEnv: new Set(), log: () => {} });
  const environment = { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OMB_BOX_TEST_ENGINE: engine!, OMB_BOX_TEST_DATA: DATA_DIR, OMB_BOX_TEST_OTHER_TOKEN: otherToken };
  instance = engine === "claude"
    ? await ClaudeDriver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true, environment, config: { cli, permissionMode: "acceptEdits" } })
    : await PiDriver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true, environment, config: { cli, fullAuto: false } });
  let completed!: (event: RuntimeEvent) => void;
  let done = new Promise<RuntimeEvent>((resolve) => { completed = resolve; });
  instance.adapter.onEvent((event) => {
    if (event.type === "request.opened" && event.requestId) { asks++; void instance!.adapter.respondToRequest(event.threadId, event.requestId, { behavior: "allow" }); }
    if (event.type === "runtime.error") errors.push(event.message);
    if (event.type === "item.completed" && event.itemType === "assistant_text") {
      try { const result = JSON.parse(event.text); probe = result; socket = result.socket; probes.push(result); } catch {}
    }
    if (event.type === "turn.completed") completed(event);
  });
  await instance.adapter.sendTurn({ threadId: "thread", botId: "bot-a", cwd, text: "fixture", ...(engine === "claude"
    ? { integrations: { hooks: { url: "http://127.0.0.1:8799", token: "hook-fixture" } } }
    : { toolScope: { allow: ["native:read"] } }) });
  const result = await done;
  if (engine === "claude") {
    done = new Promise<RuntimeEvent>((resolve) => { completed = resolve; });
    await instance.adapter.sendTurn({ threadId: "thread", botId: "bot-a", cwd, text: "fixture again", integrations: { hooks: { url: "http://127.0.0.1:8799", token: "hook-fixture-next" } } });
    await done;
  }
  console.log(JSON.stringify({ asks, socket, probe, probes, errors, ok: result.type === "turn.completed" && result.ok }));
} finally {
  await instance?.dispose();
  await botBox.stop();
}
