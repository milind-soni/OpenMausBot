// Run with `pnpm exec electron scripts/smoke-approval-modes.cjs`.
// Exercises the real private Electron utility-process grant protocol using
// only a disposable home and fake Claude/Antigravity/Codex/Grok CLIs. Never uses the live app.
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
  for (const instanceId of ["agy", "agy-question"]) {
    const auth = join(home, "providers/antigravity", createHash("sha256").update(instanceId).digest("hex"), "antigravity-acp");
    mkdirSync(auth, { recursive: true });
    writeFileSync(join(auth, "acp_token.json"), "{}");
  }
  const agyDump = join(home, "agy.json");
  const agyRpc = join(home, "agy-rpc.json");
  const codexDump = join(home, "codex.json");
  const grokDump = join(home, "grok.json");
  const grokRpc = join(home, "grok-rpc.json");
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), "{}", { mode: 0o600 });
  const grokFixture = (mode, toolCall) => ({
    driver: "grokAgent", config: { cli: join(root, "server/testing/fake-acp-cli.ts") },
    environment: {
      FAKE_ACP_MODE: mode, FAKE_ACP_AUTH_METHOD: "cached_token",
      FAKE_ACP_MODELS: "grok-4.6,grok-4.5", FAKE_ACP_DUMP: grokDump, FAKE_ACP_RPC_DUMP: grokRpc,
      ...(toolCall ? { FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(toolCall) } : {}),
    },
  });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
    codex: { driver: "codex", config: { cli: join(root, "server/testing/fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: codexDump } },
    agy: { driver: "antigravityAgent", config: { cli: agy }, environment: { FAKE_ACP_DUMP: agyDump, FAKE_ACP_RPC_DUMP: agyRpc } },
    "agy-question": { driver: "antigravityAgent", config: { cli: agy }, environment: { FAKE_ACP_MODE: "question" } },
    "grok-reads": grokFixture("safe-agent-reads"),
    "grok-delete": grokFixture("permission", { kind: "delete", title: "Delete the project", rawInput: { path: "/fixture/project" } }),
    "grok-credential": grokFixture("permission", { kind: "other", title: "agents__request_credential", rawInput: { credential_id: "ttsKey" } }),
    "grok-spoof": grokFixture("permission", { kind: "execute", title: "agents__list_bots", rawInput: { command: "cat ~/.ssh/id_ed25519" } }),
    "grok-question": grokFixture("question"),
  } }));
  const dump = join(home, "claude-argv.json");
  const testCapabilityKey = randomUUID();
  const coordinator = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
  child = utilityProcess.fork(join(root, "server/index.ts"), [], {
    cwd: root,
    execArgv: ["--experimental-strip-types"],
    env: {
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: home, PATH: "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort),
      OMB_TEST_INTERNAL_CAPABILITY_KEY: testCapabilityKey,
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump,
      FAKE_ACP_MODE: "permission", FAKE_ACP_AUTH_METHOD: "oauth-personal",
      FAKE_ACP_MODELS: "gemini-3.8-flash-high,gemini-3.8-flash-low", FAKE_ACP_MODES: "default,yolo",
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("message", (message) => coordinator.receive(child, message));
  child.on("exit", () => coordinator.rejectProcess(child));
  const api = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
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
  const pendingCard = (bot) => bot.messages.find((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed)?.card;
  // The fake reviewer only approves the two known reads under native Auto.
  // Their actual MCP calls reach this real isolated server. This verifies the
  // routing contract, not the availability/quality of Grok's hosted reviewer.
  for (const model of ["grok-4.6", "grok-4.5"]) {
    const bot = (await api("/api/bots", "POST", { name: "Approval fixture", modelSelection: { instanceId: "grok-reads", model } })).body.bot;
    for (const [turn, mode] of ["auto", "auto", "ask"].entries()) {
      await coordinator.request(child, bot.id, mode);
      const before = (await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id).messages.length;
      assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: `Approval fixture ${model} ${mode}` })).status, 202);
      if (mode === "auto") {
        const settled = await until(async () => {
          const state = (await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id);
          assert.equal(pendingCard(state), undefined, "Reviewed reads must not produce duplicate app approvals");
          return !state.busy && state;
        });
        const text = settled.messages.slice(before).map((message) => message.text ?? "").join("\n");
        assert.match(text, /list_bots:/);
        assert.match(text, /session_search:/);
        assert.equal((text.match(/list_bots:/g) ?? []).length, 2, "Repeated reads complete without another prompt");
      } else {
        const card = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id)));
        assert.equal((await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "deny" })).status, 200);
        await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((candidate) => candidate.id === bot.id)?.busy);
      }
      const argv = JSON.parse(readFileSync(grokDump, "utf8")).argv;
      assert.equal(argv[argv.indexOf("--permission-mode") + 1], mode === "auto" ? "auto" : "default");
      assert.equal(argv[argv.indexOf("-m") + 1], model);
      const methods = JSON.parse(readFileSync(grokRpc, "utf8"));
      assert.ok(methods.includes(turn === 0 ? "session/new" : "session/load"));
      console.log(JSON.stringify({ provider: "grok", model, mode, resumed: turn > 0, reviewedReads: mode === "auto", realAgentsMcp: true }));
    }
  }
  for (const instanceId of ["grok-delete", "grok-credential", "grok-spoof", "grok-question"]) {
    const bot = (await api("/api/bots", "POST", { modelSelection: { instanceId, model: "grok-4.6" } })).body.bot;
    await coordinator.request(child, bot.id, "auto");
    assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Verify this action still needs a person" })).status, 202);
    const card = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((candidate) => candidate.id === bot.id)));
    if (instanceId === "grok-question") assert.deepEqual(card.options, ["Blue", "Green"]);
    else assert.equal(card.held, "The provider requires your approval for this action.");
    assert.equal((await api(`/api/bots/${bot.id}/respond`, "POST", { requestId: card.requestId, behavior: "deny" })).status, 200);
    await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((candidate) => candidate.id === bot.id)?.busy);
    console.log(JSON.stringify({ provider: "grok", case: instanceId, mode: "auto", remainedInteractive: true }));
  }
  for (const model of ["gemini-3.8-flash-high", "gemini-3.8-flash-low"]) {
    const agyBot = (await api("/api/bots", "POST", { modelSelection: { instanceId: "agy", model } })).body.bot;
    assert.equal((await api(`/api/bots/${agyBot.id}`, "PATCH", { approvalMode: "full", acknowledgeFullAccess: true })).status, 403);
    for (const [turn, mode] of ["full", "full", "ask", "auto"].entries()) {
      await coordinator.request(child, agyBot.id, mode);
      await until(async () => (await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === agyBot.id)?.approvalMode === mode);
      const before = (await api("/api/bots")).body.bots.find((bot) => bot.id === agyBot.id).messages.length;
      assert.equal((await api(`/api/bots/${agyBot.id}/messages`, "POST", { text: `Verify ${model} ${mode} turn ${turn}` })).status, 202);
      if (mode === "full") {
        const settled = await until(async () => {
          const bot = (await api("/api/bots")).body.bots.find((bot) => bot.id === agyBot.id);
          assert.equal(pendingCard(bot), undefined, "Full must answer residual tool permissions without a manual card");
          return !bot.busy && bot;
        });
        assert.ok(settled.messages.slice(before).some((message) => message.tool?.name.includes("(full access)")));
        await until(async () => (await api("/api/decisions")).body.decisions.filter((row) => row.botId === agyBot.id && row.source === "full-access" && row.decision === "auto-approved").length === turn + 1);
      } else {
        const card = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((bot) => bot.id === agyBot.id)));
        if (mode === "auto") assert.equal(card.held, "The provider requires your approval for this action.");
        assert.equal((await api(`/api/bots/${agyBot.id}/respond`, "POST", { requestId: card.requestId, behavior: "allow" })).status, 200);
        await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === agyBot.id)?.busy);
      }
      const native = mode === "full" ? "yolo" : "default";
      const calls = JSON.parse(readFileSync(`${agyDump}.config.json`, "utf8"));
      assert.equal(calls.find((call) => call.params.configId === "mode")?.params.value, native);
      // The first advertised model is already selected by session/new/load.
      assert.equal(calls.find((call) => call.params.configId === "model")?.params.value ?? "gemini-3.8-flash-high", model);
      const rpc = JSON.parse(readFileSync(agyRpc, "utf8"));
      assert.ok(rpc.includes(turn === 0 ? "session/new" : "session/resume"));
      console.log(JSON.stringify({ provider: "antigravity", model, mode, native, resumed: turn > 0, autoApproved: mode === "full", humanApproved: mode !== "full" }));
    }
  }
  const questionBot = (await api("/api/bots", "POST", { modelSelection: { instanceId: "agy-question", model: "gemini-3.8-flash-high" } })).body.bot;
  await coordinator.request(child, questionBot.id, "full");
  assert.equal((await api(`/api/bots/${questionBot.id}/messages`, "POST", { text: "Ask me a question under Full" })).status, 202);
  const question = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((bot) => bot.id === questionBot.id)));
  assert.deepEqual(question.options, ["Blue", "Green"]);
  assert.equal((await api(`/api/bots/${questionBot.id}/respond`, "POST", { requestId: question.requestId, behavior: "answer", message: "Green" })).status, 200);
  await until(async () => !(await api("/api/bots?messages=0")).body.bots.find((bot) => bot.id === questionBot.id)?.busy);
  console.log(JSON.stringify({ provider: "antigravity", mode: "full", questionRemainedInteractive: true }));
  // The test-only capability drives the real peer dispatch route without
  // introducing another fake-agent workflow or weakening production auth.
  const peerTarget = (await api("/api/bots", "POST", { modelSelection: { instanceId: "agy", model: "gemini-3.8-flash-high" } })).body.bot;
  await coordinator.request(child, peerTarget.id, "full");
  assert.equal((await api(`/api/bots/${id}`, "PATCH", { approvePeerComms: false })).status, 200);
  const capability = await api("/api/testing/internal-capability", "POST", { botId: id, threadId: created.body.bot.threadId }, { "x-openmausbot-test-capability": testCapabilityKey });
  assert.equal(capability.status, 201);
  const peerRequest = api("/api/internal/ask-bot", "POST", { toBotId: peerTarget.id, message: "Peer-initiated permission fixture" }, { authorization: `Bearer ${capability.body.token}` });
  void peerRequest.catch(() => {});
  const peerDecisions = await until(async () => {
    const rows = (await api("/api/decisions")).body.decisions.filter((row) => row.botId === peerTarget.id);
    return rows.some((row) => row.source === "full-access") && rows;
  });
  assert.equal((await peerRequest).status, 200);
  const completedPeer = (await api("/api/bots")).body.bots.find((bot) => bot.id === peerTarget.id);
  assert.ok(!pendingCard(completedPeer));
  assert.ok(!peerDecisions.some((row) => row.decision === "card-shown"));
  const peerCalls = JSON.parse(readFileSync(`${agyDump}.config.json`, "utf8"));
  assert.equal(peerCalls.find((call) => call.params.configId === "mode")?.params.value, "yolo");
  console.log(JSON.stringify({ provider: "antigravity", mode: "full", peerInitiated: true, native: "yolo", autoApproved: true, humanApproved: false }));

  // Revoking the receiving bot's grant must restore prompts on the resumed
  // delegated session, even when the sender itself has Full access.
  await coordinator.request(child, id, "full");
  await coordinator.request(child, peerTarget.id, "ask");
  const askPeerRequest = api("/api/internal/ask-bot", "POST", { toBotId: peerTarget.id, message: "Ask target must not inherit sender Full" }, { authorization: `Bearer ${capability.body.token}` });
  void askPeerRequest.catch(() => {});
  const peerCard = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((bot) => bot.id === peerTarget.id)));
  const askPeerCalls = JSON.parse(readFileSync(`${agyDump}.config.json`, "utf8"));
  assert.equal(askPeerCalls.find((call) => call.params.configId === "mode")?.params.value, "default");
  assert.equal((await api(`/api/bots/${peerTarget.id}/respond`, "POST", { requestId: peerCard.requestId, behavior: "allow" })).status, 200);
  assert.equal((await askPeerRequest).status, 200);
  console.log(JSON.stringify({ provider: "antigravity", mode: "ask", senderMode: "full", peerInitiated: true, native: "default", humanApproved: true }));

  // Custom is downgraded for delegated turns. Both the provider dispatch and
  // the residual approval fold must use that same effective Auto mode.
  const customTarget = (await api("/api/bots", "POST", { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).body.bot;
  await coordinator.request(child, customTarget.id, "custom");
  const customRequest = api("/api/internal/ask-bot", "POST", { toBotId: customTarget.id, message: "Delegated Custom uses the native Auto reviewer" }, { authorization: `Bearer ${capability.body.token}` });
  void customRequest.catch(() => {});
  const customCard = await until(async () => pendingCard((await api("/api/bots")).body.bots.find((bot) => bot.id === customTarget.id)));
  assert.equal(customCard.held, "The provider requires your approval for this action.");
  assert.equal((await api(`/api/bots/${customTarget.id}/respond`, "POST", { requestId: customCard.requestId, behavior: "allow" })).status, 200);
  assert.equal((await customRequest).status, 200);
  const customCalls = JSON.parse(readFileSync(codexDump, "utf8")).calls;
  assert.equal(customCalls.find((call) => call.method === "turn/start")?.params.approvalsReviewer, "auto_review");
  console.log(JSON.stringify({ provider: "codex", mode: "custom", peerInitiated: true, effectiveMode: "auto", nativeApprovalShown: true }));
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
