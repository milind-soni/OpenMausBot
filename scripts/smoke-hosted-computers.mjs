// Exercise lazy provider initialization in the standalone bundle. A startup-only
// smoke cannot catch dependencies first loaded when Admin enables a provider.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { verificationServerEnvironment } from "./control-omb.ts";
import { startFakeHostedComputers, hostedFixtureConfig } from "../server/testing/fake-hosted-computers.ts";

const provider = await startFakeHostedComputers();
const root = mkdtempSync(join(tmpdir(), "nation-bundle-providers-"));
const data = join(root, "home");
mkdirSync(join(data, "tmp"), { recursive: true });
cpSync(fileURLToPath(new URL("../dist-server", import.meta.url)), join(root, "server"), { recursive: true });
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {}, features: { computers: true } }));
const probe = createServer();
probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, [join(root, "server/index.js")], { cwd: root,
  env: { ...verificationServerEnvironment({}, data, port), NATION_TEST_ORGO_API: provider.url, NATION_TEST_DAYTONA_API: provider.url },
  stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; });
child.stderr.on("data", chunk => { logs += chunk; });
const exit = once(child, "exit");
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  assert(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Bundled server did not start: ${logs.slice(-2000)}`);
  const saved = await fetch(`http://127.0.0.1:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostedComputers: hostedFixtureConfig }) });
  assert.equal(saved.status, 200, await saved.text());
  for (const backend of ["orgo", "daytona"]) {
    const { bot } = await api("/api/bots", { name: `Fixture ${backend}` });
    const patched = await fetch(`http://127.0.0.1:${port}/api/bots/${bot.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ computer: "cloud", cloudBackend: backend }) });
    assert.equal(patched.status, 200, await patched.text());
    await api(`/api/bots/${bot.id}/computer/provision`, {});
    assert((await api(`/api/bots/${bot.id}/computer/screenshot`, {})).png);
    await api(`/api/bots/${bot.id}/computer/sleep`, {});
  }
  assert.deepEqual(provider.unknown, []);
  console.log("Packaged Orgo and Daytona setup, start, screenshot and sleep passed without node_modules.");
} finally {
  child.kill("SIGTERM"); await exit;
  await provider.close(); rmSync(root, { recursive: true, force: true });
}
