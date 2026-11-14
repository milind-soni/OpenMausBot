// pnpm build:server
// pnpm exec electron scripts/smoke-login-handoff.cjs
// Send to My Cloud's secret path in real Electron: main asks the packaged server, forked as a utility process, for a saved
// login over the private utility port (electron/cloud-logins.mjs, server/login-handoff.ts), exactly as cloud-send-main.mjs
// does. Disposable home, fake engine; obvious fake secrets, never printed.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const root = resolve(__dirname, "..");
const home = mkdtempSync(join(tmpdir(), "omb-login-handoff-smoke-"));
app.setPath("userData", join(home, "electron"));
const owner = randomBytes(32).toString("base64url");
const password = `fake-handoff-${randomBytes(6).toString("hex")}`;
let logs = "";
let harness = null;

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
async function until(check) {
  const deadline = Date.now() + 40_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("Fixture timed out");
}

app.whenReady().then(async () => {
  const { createLoginHandoffClient } = await import(pathToFileURL(join(root, "electron/cloud-logins.mjs")).href);
  const port = await freePort();
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
  } }));
  harness = utilityProcess.fork(join(root, "dist-server/index.js"), [], { cwd: root, stdio: "pipe", env: {
    HOME: home, USERPROFILE: home, OMB_DATA_DIR: home, PATH: "", OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(await freePort()),
    OMB_DESKTOP_PARENT: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  } });
  harness.stdout.on("data", (chunk) => { logs += chunk; });
  harness.stderr.on("data", (chunk) => { logs += chunk; });
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(5000),
      headers: { "x-openmausbot-desktop-owner": owner, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  await until(() => fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok).catch(() => false));
  harness.postMessage({ type: "openmausbot:desktop-mutation-token", token: owner });
  await until(() => api("/api/logins").then((answer) => answer.status === 200).catch(() => false));
  const saved = await api("/api/logins", "POST", { site: "https://accounts.example.test/login", username: "alice", password, totp: "JBSWY3DPEHPK3PXP" });
  assert.equal(saved.status, 201);

  // Main's own client, answered only by the process it asked, over Electron's utility port.
  const handoff = createLoginHandoffClient();
  harness.on("message", (message) => handoff.receive(harness, message));
  const answered = await handoff.request(harness, { kind: "login", id: saved.body.login.id });
  assert.equal(answered.ok, true);
  assert.equal(answered.login.site, "accounts.example.test");
  assert.equal(answered.login.username, "alice");
  assert.equal(answered.login.password === password, true, "the saved password came back unchanged");
  assert.match(answered.login.totp, /^otpauth:\/\/totp\//);
  await assert.rejects(handoff.request(harness, { kind: "1password" }), /1Password is not connected on this computer/);
  await assert.rejects(handoff.request(harness, { kind: "login", id: "no-such-login" }), /no longer saved on this computer/);
  assert.equal(logs.includes(password), false, "no secret in the server's output");
  console.log(JSON.stringify({ passed: true, realUtilityPort: true, loginHandedOver: true, onePasswordRefusedPlainly: true, unknownLoginRefusedPlainly: true }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  const evidence = join(tmpdir(), `omb-login-handoff-${Date.now()}.log`);
  writeFileSync(evidence, logs.replaceAll(owner, "[redacted]").replaceAll(password, "[redacted]"));
  console.log(`Fixture log: ${evidence}`);
  if (harness?.pid) {
    const exited = once(harness, "exit");
    harness.kill();
    await Promise.race([exited, delay(5000)]);
  }
  rmSync(home, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
