import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TIMERS } from "./types.mjs";
import { resolvePaths } from "./config.mjs";
import { DaemonFSM } from "./fsm.mjs";
import {
  readJsonSafe,
  atomicWriteJson,
  discoverInstances,
  checkBotQuiescence,
  acquireLock,
  releaseLock,
  appendLog
} from "./repo.mjs";
import {
  loadAccounts,
  planSync,
  buildAcpTokenPayload,
  rankCandidateAccounts
} from "./service.mjs";

export class SyncDaemonRuntime {
  constructor(options = {}) {
    this.options = options;
    this.paths = resolvePaths(options);
    this.fsm = new DaemonFSM("BOOTSTRAPPING", (record) => {
      appendLog(this.paths.logPath, {
        level: "INFO",
        state: record.to,
        event: "STATE_TRANSITION",
        reason: record.reason
      });
    });

    this.postExitGuards = new Map(); // instanceId -> { expectedHash, payload, guardUntil, reassertCount }
    this.debounceTimer = null;
    this.debounceStartTime = null;
    this.reconcileTimer = null;
    this.watchers = [];
    this.isShuttingDown = false;
  }

  log(level, event, extra = {}) {
    appendLog(this.paths.logPath, {
      level,
      state: this.fsm.state,
      event,
      ...extra
    });
  }

  async runOnce({ dryRun = false, force = false, policy = "primary-and-unhealthy" } = {}) {
    if (this.fsm.state !== "RECONCILING") {
      this.fsm.transition("RECONCILING", "runOnce started");
    }

    const instances = discoverInstances(this.paths.ombDataDir);
    const { currentAccountId, accounts } = loadAccounts(this.paths.toolsDir);

    this.fsm.transition("EVALUATING_POOL", "Evaluating accounts and instances");
    const decisions = planSync({
      currentAccountId,
      accounts,
      instances,
      syncPolicy: policy
    });

    const report = {
      timestamp: new Date().toISOString(),
      dryRun,
      instancesFound: instances.length,
      accountsFound: accounts.length,
      currentAccountId,
      decisionsCount: decisions.length,
      decisions: decisions.map(d => ({
        instanceId: d.instanceId,
        reason: d.reason,
        fromAccountId: d.fromAccountId,
        toAccountId: d.toAccountId,
        toEmail: d.toEmail,
        tier: d.tier,
        score: d.score
      }))
    };

    if (dryRun || decisions.length === 0) {
      this.fsm.transition("WATCHING", "Dry run complete or no changes needed");
      return report;
    }

    // Execute decisions
    for (const dec of decisions) {
      this.fsm.transition("WAITING_QUIESCENT", `Waiting quiescence for ${dec.instanceId}`);
      const isQuiescent = await checkBotQuiescence(dec.instanceId, TIMERS.QUIESCENT_TIMEOUT_MS, TIMERS.QUIESCENT_POLL_MS);
      if (!isQuiescent && !force) {
        this.log("WARN", "QUIESCENCE_TIMEOUT", { instanceId: dec.instanceId, reason: "Bot still busy, deferring" });
        this.fsm.transition("COOLDOWN_BACKOFF", "Quiescence timeout");
        this.fsm.transition("RECONCILING", "Continuing next instance");
        continue;
      }

      // Settle window
      await new Promise(r => setTimeout(r, TIMERS.SETTLE_WINDOW_MS));

      this.fsm.transition("SYNCING_ATOMIC", `Syncing ${dec.instanceId}`);
      const matchingInstance = instances.find(i => i.instanceId === dec.instanceId);
      const payload = buildAcpTokenPayload(dec.accountData, matchingInstance?.currentToken);

      const writeRes = await atomicWriteJson(dec.tokenPath, payload);
      this.fsm.transition("VERIFYING", `Verifying write for ${dec.instanceId}`);

      const rtHash = crypto.createHash("sha256").update(payload.refresh_token).digest("hex");
      this.postExitGuards.set(dec.instanceId, {
        tokenPath: dec.tokenPath,
        expectedHash: rtHash,
        payload,
        guardUntil: Date.now() + TIMERS.POST_EXIT_GUARD_WINDOW_MS,
        reassertCount: 0
      });

      this.log("INFO", "SYNC_COMPLETED", {
        instanceId: dec.instanceId,
        reason: dec.reason,
        toAccountId: dec.toAccountId,
        written: writeRes.written
      });

    }
    this.fsm.transition("WATCHING", "All decisions in batch executed");

    return report;
  }

  async checkAndReassertGuards() {
    const now = Date.now();
    for (const [instanceId, guard] of this.postExitGuards.entries()) {
      if (now > guard.guardUntil) {
        this.postExitGuards.delete(instanceId);
        continue;
      }

      const onDisk = readJsonSafe(guard.tokenPath);
      if (onDisk?.refresh_token) {
        const currentHash = crypto.createHash("sha256").update(onDisk.refresh_token).digest("hex");
        if (currentHash !== guard.expectedHash) {
          if (guard.reassertCount >= 3) {
            this.log("ERROR", "POST_EXIT_GUARD_EXCEEDED", { instanceId, attempts: guard.reassertCount });
            this.postExitGuards.delete(instanceId);
            continue;
          }

          guard.reassertCount++;
          this.log("WARN", "POST_EXIT_GUARD_REASSERT", {
            instanceId,
            attempt: guard.reassertCount,
            reason: "External overwrite detected within 30s guard window"
          });

          await new Promise(r => setTimeout(r, 300));
          await atomicWriteJson(guard.tokenPath, guard.payload);
        }
      }
    }
  }

  triggerDebouncedSync(reason = "fs_event") {
    if (this.isShuttingDown) return;
    const now = Date.now();

    if (!this.debounceStartTime) {
      this.debounceStartTime = now;
    }

    const elapsedSinceFirst = now - this.debounceStartTime;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.fsm.canTransitionTo("DEBOUNCING")) {
      this.fsm.transition("DEBOUNCING", reason);
    }

    const waitMs = (elapsedSinceFirst >= TIMERS.DEBOUNCE_MAX_WAIT_MS)
      ? 0
      : TIMERS.DEBOUNCE_MS;

    this.debounceTimer = setTimeout(async () => {
      this.debounceStartTime = null;
      try {
        await this.runOnce({ policy: this.options.policy || "primary-and-unhealthy" });
      } catch (err) {
        this.log("ERROR", "SYNC_ERROR", { error: err.message, stack: err.stack });
        if (this.fsm.canTransitionTo("COOLDOWN_BACKOFF")) {
          this.fsm.transition("COOLDOWN_BACKOFF", err.message);
        }
      }
    }, waitMs);
  }

  startWatchers() {
    // Watch toolsDir for accounts.json
    if (fs.existsSync(this.paths.toolsDir)) {
      try {
        const w1 = fs.watch(this.paths.toolsDir, (event, filename) => {
          if (filename && filename.includes("accounts.json")) {
            this.triggerDebouncedSync(`tools_dir_${event}_${filename}`);
          }
        });
        this.watchers.push(w1);
      } catch {}
    }

    // Watch accounts detail directory
    if (fs.existsSync(this.paths.accountsDetailDir)) {
      try {
        const w2 = fs.watch(this.paths.accountsDetailDir, (event, filename) => {
          if (filename && filename.endsWith(".json") && !filename.endsWith(".tmp")) {
            this.triggerDebouncedSync(`accounts_detail_${event}`);
          }
        });
        this.watchers.push(w2);
      } catch {}
    }

    // Watch discovered acp_token.json files for post-exit overwrites
    const instances = discoverInstances(this.paths.ombDataDir);
    for (const inst of instances) {
      const dir = path.dirname(inst.tokenPath);
      if (fs.existsSync(dir)) {
        try {
          const w = fs.watch(dir, async (event, filename) => {
            if (filename === "acp_token.json") {
              await this.checkAndReassertGuards();
            }
          });
          this.watchers.push(w);
        } catch {}
      }
    }
  }

  async startDaemon() {
    const lock = acquireLock(this.paths.lockPath);
    if (!lock.acquired) {
      if (lock.isCurrentProcess) {
        return;
      }
      this.log("WARN", "ALREADY_RUNNING", { pid: lock.pid });
      return;
    }

    this.log("INFO", "DAEMON_STARTED", { pid: process.pid, version: "1.0.0" });

    // Initial reconciliation
    try {
      await this.runOnce();
    } catch (err) {
      this.log("ERROR", "INITIAL_RECONCILE_FAILED", { error: err.message });
    }

    this.startWatchers();

    // 60s periodic reconciliation fallback
    this.reconcileTimer = setInterval(async () => {
      try {
        await this.checkAndReassertGuards();
        await this.runOnce();
      } catch (err) {
        this.log("ERROR", "PERIODIC_RECONCILE_FAILED", { error: err.message });
      }
    }, TIMERS.RECONCILE_INTERVAL_MS);

    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      this.log("INFO", "SHUTDOWN_SIGNAL", { signal });
      if (this.fsm.canTransitionTo("SHUTTING_DOWN")) {
        this.fsm.transition("SHUTTING_DOWN", signal);
      }

      if (this.reconcileTimer) clearInterval(this.reconcileTimer);
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      for (const w of this.watchers) {
        try { w.close(); } catch {}
      }

      releaseLock(this.paths.lockPath);
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}
