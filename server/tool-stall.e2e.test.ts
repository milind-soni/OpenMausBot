// The real server with two silent turns side by side: a Claude turn that hangs with no tool, and an ACP turn whose one
// tool holds until a gate opens. A marker file brings the stall watchdog's twenty minutes forward.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const STALLED = "error: no activity for 20 minutes — the turn was stopped";

let fixture: VerificationServer | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

it("stops a silent turn but spares one whose tool is still running", async () => {
  fixture = await launchVerificationServer({ ...process.env, OMB_TEST_STALL_CLOCK: "1", FAKE_CLAUDE_MODE: "hang" },
    undefined, undefined, undefined, undefined, undefined, ["cline"]);
  const { url, dataDir } = fixture.info;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const gate = join(dataDir, "tool.gate");
  const wrapper = join(dataDir, "acp-slow-tool.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    `Object.assign(process.env, ${JSON.stringify({ FAKE_ACP_MODE: "slow-tool", FAKE_ACP_TOOL_GATE: gate })});`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-acp-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  const patched = await fetch(`${url}/api/instances/cline`, {
    method: "PATCH", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ cli: wrapper }),
  });
  expect(patched.status, await patched.text()).toBeLessThan(300);

  const { bot: quiet } = await cli("new-bot", "--name", "Quiet");
  const { bot: busy } = await cli("new-bot", "--name", "Busy");
  await cli("set-model", "--bot", busy.id, "--instance", "cline", "--model", "cline-default");
  await cli("send", "--bot", quiet.id, "--task", quiet.activeTaskId, "--text", "hello");
  await cli("send", "--bot", busy.id, "--task", busy.activeTaskId, "--text", "run the suite");
  const read = (path: string) => {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
  };
  // Each turn's last frame before its silence: a frame read after the marker starts that turn's window over.
  await expect.poll(() => read(join(dataDir, "native", `${quiet.activeTaskId}.ndjson`)).split("\n")
    .some((line) => line.includes('"dir":"in"') && line.includes('"subtype":"init"')), { timeout: hostTimeout(30_000) }).toBe(true);
  await expect.poll(() => read(join(dataDir, "events", `${busy.activeTaskId}.ndjson`)).includes('"itemId":"tc-slow"'),
    { timeout: hostTimeout(30_000) }).toBe(true);
  const transcript = async (bot: { id: string; activeTaskId: string }) =>
    JSON.stringify(await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "50"));

  writeFileSync(join(dataDir, "stall-turns"), "");
  await expect.poll(() => transcript(quiet), { timeout: hostTimeout(15_000) }).toContain(STALLED);
  // The sweep that stopped the quiet turn looked at every watched turn.
  expect(await transcript(busy)).not.toMatch(/No activity for \d+ minutes/i);

  rmSync(join(dataDir, "stall-turns"));
  writeFileSync(gate, "open");
  await expect.poll(() => transcript(busy), { timeout: hostTimeout(15_000) }).toContain('"text":"done"');
  expect(await transcript(busy)).not.toMatch(/No activity for \d+ minutes/i);
}, hostTimeout(90_000));
