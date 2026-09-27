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
let logs = "";
function launch() {
  const child = spawn(process.execPath, [join(root, "server/index.js")], { cwd: root,
    env: { ...verificationServerEnvironment({}, data, port), NATION_TEST_ORGO_API: provider.url, NATION_TEST_DAYTONA_API: provider.url },
    stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  return { child, exit: once(child, "exit") };
}
let server = launch();
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  assert(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
};
async function waitReady() {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Bundled server did not start: ${logs.slice(-2000)}`);
}
try {
  await waitReady();
  const saved = await fetch(`http://127.0.0.1:${port}/api/config`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostedComputers: hostedFixtureConfig }) });
  assert.equal(saved.status, 200, await saved.text());
  // A fresh process must recover Admin's settings from disk without the
  // runtime environment populated by the earlier PUT masking a failed save.
  server.child.kill("SIGTERM"); await server.exit;
  server = launch();
  await waitReady();
  const restored = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  for (const backend of ["orgo", "daytona"]) {
    assert.equal(restored.hostedComputers[backend].configured, true);
    assert.equal(restored.hostedComputers[backend].enabled, true);
  }
  assert(!JSON.stringify(restored).includes("fixture-secret"));
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
  console.log("Packaged Orgo and Daytona setup, server restart, start, screenshot and sleep passed without node_modules.");
} finally {
  server.child.kill("SIGTERM"); await server.exit;
  await provider.close(); rmSync(root, { recursive: true, force: true });
}
