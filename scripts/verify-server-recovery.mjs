// Real Electron utilityProcess + built server, never the operator's desktop.
// Run after pnpm build:server. Evidence remains; fixture homes are removed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServerSupervisor } from "../electron/server-supervisor.mjs";
import { pollServerIdentity } from "../electron/server-boot-probe.mjs";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = "--omb-server-recovery-fixture";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

if (process.versions.electron && process.argv.includes(flag)) {
  const { app, utilityProcess } = await import("electron");
  const [scenario, output, runtime] = process.argv.slice(process.argv.indexOf(flag) + 1);
  const home = join(output, scenario, "home");
  app.setPath("home", home);
  app.setPath("userData", join(home, "profile"));
  app.setPath("sessionData", join(home, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  const { createTrustedApprovalModeCoordinator } = createRequire(import.meta.url)("../electron/approval-trusted-mode.cjs");
  const { DESKTOP_MUTATION_HEADER } = createRequire(import.meta.url)("../electron/desktop-server-auth.cjs");
  const approval = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
  const events = [];
  const commands = [];
  const children = [];
  const exits = new WeakMap();
  let lease;
  let supervisor;
  let active = null;
  let exhausted = false;
  let fakePid = null;
  let quitting = false;
  let finalReceipt;
  const record = (event, fields = {}) => {
    const row = { event, at: Date.now(), ...fields };
    events.push(row);
    console.log(JSON.stringify(row));
  };
  const stop = async (proc) => {
    if (!proc) return true;
    proc.kill();
    return Promise.race([exits.get(proc).then(() => true), sleep(6500).then(() => false)]);
  };
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      assert.equal(await supervisor?.shutdown(), true);
      if (fakePid) { try { process.kill(fakePid, "SIGKILL"); } catch {} fakePid = null; }
      const count = children.length;
      // Let the first retry deadline pass after real Electron before-quit.
      await sleep(1200);
      assert.equal(children.length, count, "quit must not spawn another child");
      assert.equal(active, null);
      lease?.release();
      record("quit-clean", { children: count });
      if (finalReceipt) {
        finalReceipt.events = events;
        writeFileSync(join(output, `${scenario}.json`), `${JSON.stringify(finalReceipt, null, 2)}\n`);
      }
      app.exit(finalReceipt ? 0 : 1);
    })().catch((error) => { console.error(error); app.exit(1); });
  });

  app.whenReady().then(async () => {
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
      claude: { driver: "claudeAgent", displayName: "Isolated fake", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } },
    } }));
    const port = await freePort();
    let webhookPort;
    do { webhookPort = await freePort(); } while (webhookPort === port);
    const url = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString("base64url");
    lease = acquireDataDirLease(dataDir);
    const leaseFile = join(dataDir, "openmausbot-server.lease");
    const parentLease = readFileSync(leaseFile, "utf8");
    const start = async () => {
      const proc = utilityProcess.fork(join(output, "server/index.js"), [], {
        cwd: home, stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: dirname(runtime), HOME: home, USERPROFILE: home,
          XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
          APPDATA: home, LOCALAPPDATA: home, TMPDIR: home, TEMP: home, TMP: home,
          OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort),
          OMB_STATIC_DIR: join(output, "ui"), OMB_DESKTOP_PARENT: "1",
          ...lease.utilityServerLeaseEnvironment(),
          FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PROMPTS: join(home, "prompts.jsonl"),
          FAKE_CLAUDE_DUMP: join(home, "fake.json"),
        },
      });
      children.push(proc);
      let exited = false;
      exits.set(proc, new Promise((resolve) => proc.once("exit", (code) => {
        exited = true;
        approval.rejectProcess(proc);
        record("exit", { code });
        resolve();
      })));
      supervisor.watch(proc);
      proc.once("spawn", () => {
        record("spawn", { pid: proc.pid, generation: children.length });
        proc.postMessage({ type: "openmausbot:desktop-mutation-token", token, companionToken: token });
      });
      proc.on("message", (message) => {
        if (supervisor.isCurrent(proc)) approval.receive(proc, message);
      });
      for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (data) => process.stdout.write(data));
      const identity = await pollServerIdentity({ port, pid: () => proc.pid, bootTimeoutMs: 20_000, isExited: () => exited || quitting });
      if (identity.outcome === "ready" && supervisor.isCurrent(proc)) return { proc };
      return { proc: null, abort: !(await stop(proc)) };
    };
    supervisor = createServerSupervisor({
      restart: start, stop, log: (message) => record("recovery", { message }),
      onReady(proc) {
        active = proc;
        record("ready", { pid: proc.pid, port });
        assert.equal(readFileSync(leaseFile, "utf8"), parentLease, "parent lease must never be replaced");
        if (scenario === "exhausted" && children.length > 1) setTimeout(() => process.kill(proc.pid, "SIGKILL"), 30);
      },
      onUnavailable() { active = null; record("unavailable"); },
      onExhausted() { exhausted = true; record("exhausted"); },
    });
    const initial = await start();
    assert.ok(initial.proc, "initial server must pass its PID identity probe");
    assert.equal(supervisor.ready(initial.proc), true);
    const initialPid = initial.proc.pid;
    const fetcher = async (route, options = {}) => {
      const response = await fetch(`${url}${route}`, {
        ...options, headers: { "content-type": "application/json", [DESKTOP_MUTATION_HEADER]: token },
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    const { handleToolCall } = await import(pathToFileURL(join(output, "server/mcp-server.js")));
    const control = async (name, args) => {
      const result = await handleToolCall(name, args, fetcher);
      commands.push({ name, args, result });
      return result;
    };

    if (scenario === "recover") {
      const { bot } = await control("create_bot", { name: "Recovery fixture" });
      await control("send_bot_message", { bot_id: bot.id, task_id: bot.activeTaskId, text: "Do not replay this interrupted fixture turn." });
      await until(() => existsSync(join(home, "fake.json")), "fake engine accepted the turn");
      fakePid = JSON.parse(readFileSync(join(home, "fake.json"), "utf8")).pid;
      const prompts = readFileSync(join(home, "prompts.jsonl"), "utf8");
      assert.equal(prompts.trim().split("\n").length, 1);
      // A frozen owned child cannot race an ACK ahead of our simulated crash.
      process.kill(initialPid, "SIGSTOP");
      const pendingApproval = approval.request(initial.proc, bot.id, "ask").then(
        () => "unexpected success", (error) => error.message,
      );
      process.kill(initialPid, "SIGKILL");
      await exits.get(initial.proc);
      assert.equal(active, null, "readiness cleared in the same exit dispatch");
      assert.match(await pendingApproval, /server stopped/);
      // This inert fake intentionally hangs even after stdin closes. Reap only
      // the exact fixture-recorded engine, never a process-name match.
      process.kill(fakePid, "SIGKILL");
      fakePid = null;
      await until(() => active && active.pid !== initialPid, "replacement PID verified");
      const replacementPid = active.pid;
      assert.equal(JSON.parse(readFileSync(join(dataDir, ".openmausbot-server-child/openmausbot-server.lease"), "utf8")).pid, replacementPid);
      const wait = await control("wait_for_conversation", { target_type: "bot", target_id: bot.id, task_id: bot.activeTaskId, timeout_seconds: 2 });
      assert.equal(wait.target.busy, false);
      const messages = await control("get_bot_messages", { bot_id: bot.id, task_id: bot.activeTaskId, limit: 10 });
      assert.equal(messages.messages.filter((message) => message.role === "user").length, 1);
      await sleep(1200);
      assert.equal(readFileSync(join(home, "prompts.jsonl"), "utf8"), prompts, "recovery must not resend the turn");
      assert.equal((await approval.request(active, bot.id, "ask")).approvalMode, "ask");
      await control("create_bot", { name: "Replacement accepts fresh authorized writes" });
      const refused = await fetch(`${url}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Must refuse"}' });
      assert.equal(refused.status, 403, "replacement remains fail-closed without the private token");
      finalReceipt = { passed: true, scenario, url, initialPid, replacementPid, commands,
        checks: ["PID verified replacement", "same port", "unchanged parent lease", "replacement child lease", "immediate unavailable", "pending approval rejected", "new approval accepted", "private mutation capability restored", "unauthorized write refused", "interrupted turn retained once, not replayed"],
        limitation: "Headless fixture uses the production supervisor, probe, lease, approval protocol and built server, not the complete desktop bootstrap or renderer. The inert hung engine is explicitly reaped by the fixture." };
    } else {
      process.kill(initialPid, "SIGKILL");
      await exits.get(initial.proc);
      assert.equal(active, null);
      if (scenario === "exhausted") {
        await until(() => exhausted, "bounded recovery exhausted");
        assert.equal(children.length, 4, "initial child plus exactly three replacements");
        await sleep(4500);
        assert.equal(children.length, 4, "exhaustion must stop retries without needing app.quit");
      }
      finalReceipt = { passed: true, scenario, url, initialPid, children: children.length,
        checks: scenario === "quit" ? ["actual before-quit cancels pending retry", "no replacement after retry deadline"] : ["three bounded recovery attempts", "no restart after exhaustion"] };
    }
    app.quit();
  }).catch((error) => { console.error(error); app.quit(); });
} else {
  assert.notEqual(process.platform, "win32", "This crash fixture uses POSIX SIGSTOP/SIGKILL");
  // macOS's default temp path leaves no room for the server's Unix sockets.
  const output = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "omb-server-recovery-"));
  const electron = createRequire(import.meta.url)("electron");
  cpSync(join(root, "dist-server"), join(output, "server"), { recursive: true });
  mkdirSync(join(output, "ui"));
  writeFileSync(join(output, "ui/index.html"), "<!doctype html><title>Isolated recovery fixture</title>");
  console.log(JSON.stringify({ evidence: output }));
  for (const scenario of ["recover", "quit", "exhausted"]) {
    const home = join(output, scenario, "home");
    mkdirSync(home, { recursive: true });
    const child = spawn(electron, [fileURLToPath(import.meta.url), flag, scenario, output, process.execPath], {
      cwd: home, env: { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), TMPDIR: home, TEMP: home, TMP: home,
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, DISPLAY: process.env.DISPLAY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => appendFileSync(join(output, `${scenario}.log`), data));
    const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timeout);
    assert.equal(code, 0, `${scenario} failed; see ${join(output, `${scenario}.log`)}`);
    console.log(JSON.stringify({ scenario, receipt: join(output, `${scenario}.json`), passed: true }));
    rmSync(home, { recursive: true, force: true });
  }
  rmSync(join(output, "server"), { recursive: true, force: true });
  rmSync(join(output, "ui"), { recursive: true, force: true });
}
