// Real Electron utilityProcess + unchanged bundled server, isolated homes.
// pnpm build:server && node scripts/verify-restore-startup.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pollServerIdentity } from "../electron/server-boot-probe.mjs";
import { createRestoreStartupProgress } from "../electron/workspace-restore-startup.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = "--omb-slow-restore-fixture";
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

if (process.versions.electron && process.argv.includes(flag)) {
  const { app, utilityProcess } = await import("electron");
  const fixture = process.argv[process.argv.indexOf(flag) + 1];
  const home = join(fixture, "home");
  app.setPath("home", home);
  app.setPath("userData", join(home, "electron"));
  app.commandLine.appendSwitch("disable-background-networking");
  // Do not top-level-await readiness: Electron waits for ESM evaluation
  // before emitting ready.
  app.whenReady().then(async () => {
  const port = await freePort();
  const webhookPort = await freePort();
  const progress = createRestoreStartupProgress();
  const phases = new Set();
  const started = Date.now();
  const child = utilityProcess.fork(join(root, "scripts/testing/slow-restore-child.mjs"), [join(fixture, "server/index.js")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OMB_DATA_DIR: join(fixture, "target"), OMB_STATIC_DIR: join(fixture, "ui"), OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(webhookPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  const exit = new Promise(resolve => child.once("exit", code => { exited = true; resolve(code); }));
  child.stdout?.on("data", data => process.stdout.write(data));
  child.stderr?.on("data", data => process.stderr.write(data));
  child.on("message", message => {
    if (progress.receive(message) && !phases.has(message.phase)) {
      phases.add(message.phase);
      console.log(JSON.stringify({ phase: message.phase, elapsedMs: Date.now() - started }));
    }
  });
  let code = 0;
  try {
    const identity = await pollServerIdentity({ port, pid: () => child.pid, bootTimeoutMs: 60_000, isExited: () => exited, restoreProgress: progress.get });
    assert.equal(identity.outcome, "ready");
    assert(Date.now() - started > 60_000, "must actually exceed the original boot deadline");
    assert.deepEqual([...phases], ["checking", "copying", "applying", "done"]);
    const target = join(fixture, "target");
    const journal = JSON.parse(readFileSync(join(target, ".backups/restore-journal.json"), "utf8"));
    assert.equal(journal.phase, "committed");
    assert(existsSync(join(target, ".backups", journal.id, "staged/data/attachments/restore-payload.bin")));
    assert.equal(readFileSync(join(target, ".backups", `safety-${journal.id}/data/before.txt`), "utf8"), "Previous workspace");
    assert.equal(readFileSync(join(target, "attachments/restore-payload.bin")).length, 2 * 1024 ** 2);
    assert(!existsSync(join(target, ".backups/pending-restore.json")));
    console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, children: 1, port, stagedSourceRetained: true, safetyCopyRetained: true, health: identity.outcome }));
  } catch (error) { console.error(error); code = 1; }
  finally {
    child.kill();
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5_000))]);
    app.exit(code);
  }
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const fixture = mkdtempSync(join(tmpdir(), "omb-restore-startup-"));
  let child;
  try {
    const { createWorkspaceBackup, stageWorkspaceBackup, commitPendingWorkspaceRestore } = await import("../server/workspace-backup.ts");
    const source = join(fixture, "source"), target = join(fixture, "target"), home = join(fixture, "home");
    for (const path of [source, target, home, join(source, "attachments"), join(fixture, "ui")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(source, "bots.json"), "[]");
    writeFileSync(join(source, "attachments/restore-payload.bin"), Buffer.alloc(2 * 1024 ** 2, 0x42));
    writeFileSync(join(target, "before.txt"), "Previous workspace");
    writeFileSync(join(fixture, "ui/index.html"), "Isolated restore fixture");
    const password = "synthetic fixture password";
    const backup = await createWorkspaceBackup(source, { password });
    const staged = await stageWorkspaceBackup(target, backup.path, { password });
    commitPendingWorkspaceRestore(target, staged.id);
    cpSync(join(root, "dist-server"), join(fixture, "server"), { recursive: true });
    const electron = createRequire(import.meta.url)("electron");
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) };
    child = spawn(electron, [fileURLToPath(import.meta.url), flag, fixture], { cwd: root, env, stdio: "inherit" });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 180_000);
    const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    clearTimeout(timeout);
    assert.equal(code, 0, "Slow restore startup failed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
