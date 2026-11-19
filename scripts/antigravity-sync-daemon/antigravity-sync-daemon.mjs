#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolvePaths, parseCliArgs, redactSecrets } from "./src/config.mjs";
import { GATEWAY_CONSTANTS } from "./src/types.mjs";
import {
  readJsonSafe,
  discoverInstances,
  isProcessAlive,
  acquireLock,
  releaseLock
} from "./src/repo.mjs";
import { loadAccounts, rankCandidateAccounts } from "./src/service.mjs";
import { registerBackupGateway, verifyGatewayConfig, probeGateway } from "./src/gateway.mjs";
import { SyncDaemonRuntime } from "./src/runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function handleStatus(paths, options) {
  const cfg = readJsonSafe(paths.configPath) || {};
  const bots = (readJsonSafe(paths.botsPath) || {}).bots || [];
  const lockData = readJsonSafe(paths.lockPath);
  const isRunning = lockData?.pid ? isProcessAlive(lockData.pid) : false;

  const gwInstance = cfg.instances?.[GATEWAY_CONSTANTS.INSTANCE_ID];
  let gwProbe = { healthy: false, error: "Not configured" };
  if (gwInstance?.config?.url) {
    gwProbe = await probeGateway(gwInstance.config.url, gwInstance.config.key);
  }

  const gwVerification = verifyGatewayConfig(cfg, bots);
  const instances = discoverInstances(paths.ombDataDir);
  const { currentAccountId, accounts } = loadAccounts(paths.toolsDir);
  const rankedAccounts = rankCandidateAccounts(accounts);

  const statusObj = {
    daemon: {
      running: isRunning,
      pid: isRunning ? lockData.pid : null,
      lockFile: paths.lockPath
    },
    gateway: {
      registered: !!gwInstance,
      url: gwInstance?.config?.url || null,
      healthy: gwProbe.healthy,
      modelCount: gwProbe.modelCount || 0,
      violations: gwVerification.violations
    },
    pool: {
      totalAccounts: accounts.length,
      eligibleAccounts: rankedAccounts.length,
      currentAccountId,
      activeInstances: instances.length
    }
  };

  if (options.json) {
    console.log(JSON.stringify(statusObj, null, 2));
  } else {
    console.log("=== Antigravity Sync Daemon Status ===");
    console.log(`Daemon:   ${isRunning ? "RUNNING (PID: " + lockData.pid + ")" : "STOPPED"}`);
    console.log(`Gateway:  ${gwInstance ? "REGISTERED" : "MISSING"} (${gwProbe.healthy ? "HTTP 200, " + gwProbe.modelCount + " models" : "UNHEALTHY: " + gwProbe.error})`);
    console.log(`Violations: ${gwVerification.violations.length === 0 ? "NONE (ACP primary preserved)" : gwVerification.violations.join(", ")}`);
    console.log(`Accounts: ${rankedAccounts.length}/${accounts.length} eligible, Current: ${currentAccountId || "none"}`);
    console.log(`Instances: ${instances.length} active native ACP instances`);
  }
}

async function handleInstallAutostart(paths) {
  console.log("Installing Windows windowless autostart launcher...");

  // 1. Register backup gateway first if not registered
  try {
    await registerBackupGateway({ configPath: paths.configPath, guiConfigPath: paths.guiConfigPath });
    console.log("✔ Backup gateway registered cleanly in config.json");
  } catch (err) {
    console.warn("⚠ Gateway registration notice:", err.message);
  }

  // 2. Deploy script and src to ~/.openmausbot
  const targetScriptPath = paths.runtimeDaemonPath;
  const targetSrcDir = path.join(paths.ombDataDir, "src");

  fs.copyFileSync(__filename, targetScriptPath);
  if (!fs.existsSync(targetSrcDir)) fs.mkdirSync(targetSrcDir, { recursive: true });

  const srcDir = path.join(__dirname, "src");
  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(targetSrcDir, file));
  }
  console.log(`✔ Runtime daemon files deployed to ${paths.ombDataDir}`);

  // 3. Create Windows Startup VBS Launcher
  const nodeExe = process.execPath;
  const vbsContent = [
    `Set WshShell = CreateObject("WScript.Shell")`,
    `cmd = Chr(34) & "${nodeExe}" & Chr(34) & " " & Chr(34) & "${targetScriptPath}" & Chr(34) & " --daemon"`,
    `WshShell.Run cmd, 0, False`,
    ""
  ].join("\r\n");

  const vbsDir = path.dirname(paths.startupVbsPath);
  if (!fs.existsSync(vbsDir)) fs.mkdirSync(vbsDir, { recursive: true });
  fs.writeFileSync(paths.startupVbsPath, vbsContent, "utf8");
  console.log(`✔ Silent VBS launcher written to: ${paths.startupVbsPath}`);

  // 4. Launch daemon silently via wscript.exe
  try {
    const child = child_process.spawn("wscript.exe", [paths.startupVbsPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    // Verify lockfile appears within 5 seconds
    let started = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const lockData = readJsonSafe(paths.lockPath);
      if (lockData?.pid && isProcessAlive(lockData.pid)) {
        started = true;
        console.log(`✔ Daemon process started silently in background (PID: ${lockData.pid})`);
        break;
      }
    }

    if (!started) {
      console.log("ℹ Daemon launched; lock check will complete upon first filesystem event.");
    }
  } catch (err) {
    console.error("Failed to launch wscript:", err.message);
  }
}

async function handleUninstallAutostart(paths) {
  console.log("Uninstalling autostart launcher and stopping daemon...");

  // Remove VBS launcher
  if (fs.existsSync(paths.startupVbsPath)) {
    try {
      fs.unlinkSync(paths.startupVbsPath);
      console.log(`✔ Removed VBS launcher: ${paths.startupVbsPath}`);
    } catch (err) {
      console.warn("Failed to delete VBS launcher:", err.message);
    }
  }

  // Stop running daemon
  const lockData = readJsonSafe(paths.lockPath);
  if (lockData?.pid && isProcessAlive(lockData.pid)) {
    try {
      process.kill(lockData.pid, "SIGTERM");
      console.log(`✔ Sent SIGTERM to daemon process PID ${lockData.pid}`);
    } catch {}
    try { fs.unlinkSync(paths.lockPath); } catch {}
  } else {
    console.log("ℹ No active daemon process was running.");
  }
}

async function main() {
  const options = parseCliArgs();
  const paths = resolvePaths();

  switch (options.mode) {
    case "status":
      await handleStatus(paths, options);
      break;

    case "dry-run": {
      const runtime = new SyncDaemonRuntime();
      const report = await runtime.runOnce({ dryRun: true, policy: options.policy });
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case "sync-now": {
      const runtime = new SyncDaemonRuntime();
      const report = await runtime.runOnce({ dryRun: false, force: options.force, policy: options.policy });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Sync completed: ${report.decisionsCount} decision(s) executed.`);
      }
      break;
    }

    case "register-gateway": {
      const res = await registerBackupGateway({
        configPath: paths.configPath,
        guiConfigPath: paths.guiConfigPath
      });
      console.log(`✔ Backup gateway registered successfully: ${res.instanceId} (${res.url})`);
      break;
    }

    case "install-autostart":
      await handleInstallAutostart(paths);
      break;

    case "uninstall-autostart":
      await handleUninstallAutostart(paths);
      break;

    case "daemon": {
      const runtime = new SyncDaemonRuntime({ policy: options.policy });
      await runtime.startDaemon();
      break;
    }

    default:
      console.log("Unknown mode:", options.mode);
      process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", redactSecrets(err.message));
  process.exit(1);
});
