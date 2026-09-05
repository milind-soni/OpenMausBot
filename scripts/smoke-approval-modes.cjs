// Run with `pnpm exec electron scripts/smoke-approval-modes.cjs`.
// Exercises the real private Electron utility-process grant protocol using
// only a disposable home and fake Claude/Antigravity CLIs. Never uses the live app.
const { app, utilityProcess } = require("electron");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { createTrustedApprovalModeCoordinator } = require("../electron/approval-trusted-mode.cjs");

const root = resolve(__dirname, "..");
const home = mkdtempSync(join(tmpdir(), "omb-approval-smoke-"));
app.setPath("userData", join(home, "electron"));
let child;
let logs = "";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function until(check) {
  const deadline = Date.now() + 30_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Fixture timed out. ${logs.slice(-2000)}`);
}

app.whenReady().then(async () => {
  const port = await freePort();
  let webhookPort = await freePort();
  while (webhookPort === port) webhookPort = await freePort();
  const agy = join(home, "fake-antigravity.ts");
  copyFileSync(join(root, "server/testing/fake-acp-cli.ts"), agy);
  const harness = join(home, process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
  writeFileSync(harness, "fake harness");
  if (process.platform !== "win32") { chmodSync(agy, 0o755); chmodSync(harness, 0o755); }
  const auth = join(home, "providers/antigravity", createHash("sha256").update("agy").digest("hex"), "antigravity-acp");
  mkdirSync(auth, { recursive: true });
  writeFileSync(join(auth, "acp_token.json"), "{}");
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
    agy: { driver: "antigravityAgent", config: { cli: agy } },
  } }));
  const dump = join(home, "claude-argv.json");
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
  child = utilityProcess.fork(join(root, "server/index.ts"), [], {
    cwd: root,
    execArgv: ["--experimental-strip-types"],
    env: {
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: home, PATH: "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort),
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump,
      FAKE_ACP_MODE: "permission", FAKE_ACP_AUTH_METHOD: "oauth-personal",
      FAKE_ACP_MODELS: "gemini-3.8-flash-high", FAKE_ACP_MODES: "default,yolo",
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("message", (message) => coordinator.receive(child, message));
  child.on("exit", () => coordinator.rejectProcess(child));
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await until(() => api("/api/health").catch(() => null));
  const created = await api("/api/bots", "POST", { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  assert.equal(created.status, 201);
  const id = created.body.bot.id;
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvalMode: "full", acknowledgeFullAccess: true })).status, 403);
  for (const [mode, native] of [["full", "bypassPermissions"], ["auto", "auto"], ["ask", "default"]]) {
    await coordinator.request(child, id, mode);
    await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === id)?.approvalMode === mode);
    assert.equal((await api(`/api/bots/${id}/messages`, "POST", { text: `Verify ${mode}` })).status, 202);
    await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === id)?.busy);
    const argv = JSON.parse(readFileSync(dump, "utf8")).argv;
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], native);
    if (mode !== "full") assert.ok(argv.includes("--resume"));
    console.log(JSON.stringify({ mode, native, privateGrant: true, turnSettled: true }));
  }
  await assert.rejects(coordinator.request(child, id, "custom"), /only for Codex/);
  const agyBot = (await api("/api/bots", "POST", { modelSelection: { instanceId: "agy", model: "gemini-3.8-flash-high" } })).body.bot;
  for (const mode of ["full", "auto", "ask"]) {
    await coordinator.request(child, agyBot.id, mode);
    await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === agyBot.id)?.approvalMode === mode);
    assert.equal((await api(`/api/bots/${agyBot.id}/messages`, "POST", { text: `Verify native ${mode} approval` })).status, 202);
    const card = await until(async () => {
      const bot = (await api("/api/bots")).body.bots.find((bot) => bot.id === agyBot.id);
      return bot.messages.find((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;
    });
    if (mode !== "ask") assert.equal(card.held, "The provider requires your approval for this action.");
    assert.equal((await api(`/api/bots/${agyBot.id}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status, 200);
    await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === agyBot.id)?.busy);
    console.log(JSON.stringify({ provider: "antigravity", mode, nativeApprovalShown: true, humanApproved: true }));
  }
  console.log("Approval smoke passed; HTTP elevation rejected, private grant and resumed mode transitions verified.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child?.pid) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  rmSync(home, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
