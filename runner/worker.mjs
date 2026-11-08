import { mkdir, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { VERSION, atomicJson, readJson, Redactor, RunError, classifyFailure, sleep } from './security.mjs';
import { discoverAccounts, freshReport, selectAccount, confirmedExhausted } from './accounts.mjs';
import { WorkerClient, RunLedger, EventJournal, Lease } from './protocol.mjs';
import { Workspace, temporaryEnvironment } from './git.mjs';
import { startHarness } from './harnesses.mjs';
import { runnerUpdatePlan, automaticUpdatePolicy, automaticUpdateDue } from './maintenance.mjs';
import { maintainTools, recoverManagedToolUpdates } from './tool-updates.mjs';
import { assertIdleState, withMaintenanceLock, applyRunnerRelease, beginRunnerUpdate, confirmRunnerUpdate, recoverRunnerUpdate, boundedUpdateReports } from './service.mjs';
import { RunConsole, validateConsoleInput } from './run-console.mjs';
import { HerdrConnections } from './herdr-connections.mjs';
import { RexConnections } from './rex-connections.mjs';

export class Runner {
  constructor(config, dependencies = {}) {
    this.config = config; this.root = config.dataDirectory;
    this.client = dependencies.client ?? new WorkerClient(config);
    this.discover = dependencies.discover ?? discoverAccounts;
    this.startHarness = dependencies.startHarness ?? startHarness;
    this.Workspace = dependencies.Workspace ?? Workspace;
    this.startConsole = dependencies.startConsole ?? (options => RunConsole.start(options));
    this.herdr = config.herdr?.enabled === true ? (dependencies.herdrConnections ?? new HerdrConnections(config)) : null;
    this.rex = config.rex?.enabled === true ? (dependencies.rexConnections ?? new RexConnections(config)) : null;
    this.ledger = new RunLedger(this.root); this.accounts = []; this.active = null; this.paused = false; this.stopping = false;
    this.localPaused = false; this.serverPaused = false;
    this.abort = new AbortController(); this.heartbeatSeconds = config.heartbeatSeconds ?? 15;
    this.maintenance = new Map(); this.nextUsageRefreshAt = 0;
    this.updateDependencies = { ...dependencies.updates, signal: dependencies.updates?.signal ? AbortSignal.any([this.abort.signal, dependencies.updates.signal]) : this.abort.signal }; this.updateReports = [];
  }
  async status(extra = {}) {
    this.updateReports = boundedUpdateReports(this.updateReports, [this.config.hostToken]);
    await atomicJson(join(this.root, 'status.json'), { version: VERSION, pid: process.pid, hostId: this.config.hostId, name: this.config.name ?? hostname(), paused: this.paused, locallyPaused: this.localPaused, serverPaused: this.serverPaused, activeRunId: this.active?.run.id ?? null, updatedAt: Date.now(), accounts: this.accounts.map(value => freshReport(value.report)), updates: this.updateReports, herdr: this.herdr?.report() ?? { enabled: false, cloudConnections: false }, rex: this.rex?.report() ?? { enabled: false, cloudConnections: false }, ...extra });
  }
  async localControls() {
    const controls = await readJson(join(this.root, 'control.json'), {});
    this.localPaused = controls.paused ?? false;
    this.paused = this.localPaused || this.serverPaused;
    if (controls.stop) { this.stopping = true; const reason = new RunError('cancelled', 'Runner stopped by local owner'); this.active?.abort.abort(reason); this.abort.abort(reason); }
  }
  async heartbeat() {
    await this.localControls();
    this.updateReports = boundedUpdateReports(this.updateReports, [this.config.hostToken]);
    let response;
    try {
      response = await this.client.request('heartbeat', { version: VERSION, platform: process.platform, capabilities: [...new Set(this.accounts.map(value => value.binding.harness))], activeRunIds: this.active ? [this.active.run.id] : [], accounts: this.accounts.map(value => freshReport(value.report)), capacity: 1, paused: this.localPaused, herdr: this.herdr?.report() ?? { enabled: false, cloudConnections: false }, rex: this.rex?.report() ?? { enabled: false, cloudConnections: false }, ...(this.updateReports.length ? { updateReports: this.updateReports } : {}) });
    } catch (error) { this.herdr?.schedule([]); this.rex?.schedule([]); throw error; }
    this.herdr?.schedule(response.herdrPlans ?? []);
    this.rex?.schedule(response.rexPlans ?? []);
    if (response.cancelRunIds?.includes(this.active?.run.id)) this.active.abort.abort(new RunError('cancelled', 'Cancelled by Origin'));
    if (response.refreshUsage) this.refreshUsage = true;
    if (response.paused !== undefined) this.serverPaused = response.paused;
    this.paused = this.localPaused || this.serverPaused;
    for (const request of response.maintenance ?? []) if (['checkUpdates', 'applyUpdates'].includes(request.op)) this.maintenance.set(request.id, request);
    await this.status({ availableVersion: response.updates?.availableVersion });
  }
  async run() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, 'worker.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Runner lock exists. Another worker may be active; inspect status and process trees before removing a crash-stale worker.lock. No duplicate execution started.'); throw error; }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() })); await lock.sync();
    const stop = () => { this.stopping = true; this.active?.abort.abort(new RunError('cancelled', 'Runner shutdown')); this.abort.abort(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    let heartbeatLoop;
    try {
      if (await readJson(join(this.root, 'tool-maintenance-fence.json'), null)) throw new Error('Host fenced after uncertain native tool maintenance; operator stop/rollback recovery required');
      const unresolved = (await this.ledger.records()).filter(record => !['stopped', 'acknowledged'].includes(record.state));
      if (unresolved.length) throw new Error(`Uncertain prior execution (${unresolved.map(value => value.id).join(', ')}). No reassignment: verify old process groups stopped before operator recovery.`);
      if (await beginRunnerUpdate(this.config)) { this.stopping = true; process.exitCode = 75; return; }
      await this.loadUpdateReports();
      await this.replayReceipts();
      await recoverManagedToolUpdates(this.config, this.updateDependencies);
      this.accounts = await this.discover(this.config);
      this.nextUsageRefreshAt = performance.now() + 60000;
      await this.heartbeat();
      await confirmRunnerUpdate(this.config);
      heartbeatLoop = (async () => {
        while (!this.stopping) {
          try { await sleep(this.heartbeatSeconds * 1000, this.abort.signal); await this.heartbeat(); }
          catch { if (this.stopping) break; await this.status({ controller: 'unreachable' }); }
        }
      })();
      while (!this.stopping) {
        await this.localControls();
        if (this.stopping) break;
        if (this.refreshUsage || performance.now() >= this.nextUsageRefreshAt) {
          this.accounts = await this.discover(this.config); this.refreshUsage = false; this.nextUsageRefreshAt = performance.now() + 60000;
          await this.heartbeat();
        }
        await this.replayReceipts();
        await this.performMaintenance();
        if (this.stopping) break;
        if (!this.paused) {
          let claimedRun;
          try {
            const claimedAt = performance.now();
            const { run } = await this.client.request('claim');
            claimedRun = run;
            if (run) { await this.execute(run, claimedAt); continue; }
          } catch (error) {
            if (claimedRun) throw error; // Uncertain cleanup/stop/persistence is a host fence, never another claim.
            await this.status({ error: new Redactor([this.config.hostToken]).text(error.message) });
          }
        }
        await sleep(3000, this.abort.signal).catch(() => {});
      }
    } catch (error) {
      if (error.processStopUnproven || error.maintenanceUncertain) await atomicJson(join(this.root, 'tool-maintenance-fence.json'), { at: Date.now(), message: 'Uncertain maintenance/discovery process stop; operator recovery required' });
      else await recoverRunnerUpdate(this.config);
      if (!this.abort.signal.aborted || error !== this.abort.signal.reason || error.processStopUnproven || error.maintenanceUncertain) throw error;
    } finally {
      this.stopping = true; this.abort.abort(); await heartbeatLoop;
      await this.herdr?.stop();
      await this.rex?.stop();
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      try { await this.status({ stopped: true }); }
      finally { await lock.close(); await rm(lockPath, { force: true }); }
    }
  }
  async loadUpdateReports() {
    const path = join(this.root, 'automatic-updates.json'), state = await readJson(path, {});
    this.updateReports = boundedUpdateReports(state.updates, [this.config.hostToken]).map(report => report.component === 'origin-runner' && report.status === 'updating' ? { ...report, currentVersion: VERSION, status: report.availableVersion === VERSION ? 'current' : 'failed', message: report.availableVersion === VERSION ? 'Signed stable runner started; confirming heartbeat.' : 'Pending runner update did not survive startup; prior release restored and rejected version quarantined.' } : report);
    if (JSON.stringify(state.updates ?? []) !== JSON.stringify(this.updateReports)) await atomicJson(path, { ...state, updates: this.updateReports });
  }
  async replayReceipts() {
    for (const record of await this.ledger.records()) {
      if (record.state !== 'stopped') continue;
      const journal = new EventJournal(this.ledger, record, this.client, new Redactor([this.config.hostToken]));
      try { await journal.flush(true); } catch { /* Durable stopped receipt is retried before the next claim. */ }
    }
  }
  async collectUpdates({ apply = false, policy } = {}) {
    this.updateDependencies.signal.throwIfAborted();
    const updates = await maintainTools(this.config, this.accounts, { apply, harnesses: policy?.tools, automatic: Boolean(policy), approveBoundary: false }, this.updateDependencies);
    this.updateDependencies.signal.throwIfAborted();
    if (apply) this.refreshUsage = true;
    if (!policy || policy.runner) {
      let report;
      try {
        const plan = await runnerUpdatePlan(this.config, this.updateDependencies);
        report = plan.report;
        if (apply && plan.compatible && report.status === 'available') {
          await this.status();
          await withMaintenanceLock(this.config, () => applyRunnerRelease(this.config, plan, { supervised: true }, this.updateDependencies));
          report = { ...report, status: 'updating', message: `${report.message} Installed idle; restarting through existing supervision. New heartbeat must confirm startup; prior release retained.` };
          this.stopping = true; process.exitCode = 75;
        }
      } catch (error) {
        if (error.processStopUnproven || error.maintenanceUncertain || this.updateDependencies.signal.aborted) throw error;
        report = { ...(report ?? { component: 'origin-runner', currentVersion: VERSION, checkedAt: Date.now() }), status: report ? 'failed' : 'unknown', message: new Redactor([this.config.hostToken]).text(error.message) };
      }
      updates.unshift(report);
    }
    this.updateReports = boundedUpdateReports(updates, [this.config.hostToken]);
    return this.updateReports;
  }
  async performMaintenance() {
    if (this.active || this.stopping) return;
    await assertIdleState(this.config);
    // Do not restart or move executables while an earlier stop receipt is unacknowledged.
    if ((await this.ledger.records()).some(record => record.state !== 'acknowledged')) return;
    const path = join(this.root, 'maintenance.json');
    const storedReceipts = await readJson(path, {});
    const receipts = Object.fromEntries(Object.entries(storedReceipts).map(([id, receipt]) => [id, { updates: boundedUpdateReports(receipt?.updates, [this.config.hostToken]) }]));
    if (JSON.stringify(storedReceipts) !== JSON.stringify(receipts)) await atomicJson(path, receipts);
    for (const [id, request] of this.maintenance) {
      if (!receipts[id]) {
        receipts[id] = { updates: boundedUpdateReports(await this.collectUpdates({ apply: request.op === 'applyUpdates' }), [this.config.hostToken]) };
        await atomicJson(path, receipts);
      }
      try { await this.client.request('maintenanceResult', { id, ...receipts[id] }); this.maintenance.delete(id); }
      catch { /* A duplicate maintenance delivery replays the durable result, not the update. */ }
      if (this.stopping) return;
    }
    const schedulePath = join(this.root, 'automatic-updates.json'), state = await readJson(schedulePath, {});
    if (!automaticUpdateDue(this.config, state)) return;
    const policy = automaticUpdatePolicy(this.config), checkedAt = Date.now();
    // Persist the next deadline before network/process work: restart cannot spin a failed check.
    const next = { ...state, updates: boundedUpdateReports(state.updates, [this.config.hostToken]), checkedAt, nextCheckAt: checkedAt + policy.intervalHours * 3600000 };
    await atomicJson(schedulePath, next);
    const updates = boundedUpdateReports(await this.collectUpdates({ apply: true, policy }), [this.config.hostToken]);
    await atomicJson(schedulePath, { ...next, updates });
    await this.status();
  }
  async execute(run, claimedAt = performance.now()) {
    if (this.active) throw new Error('Runner capacity is one');
    if (!Number.isFinite(run.timeoutSeconds) || run.timeoutSeconds <= 0) throw new Error('Invalid run timeout');
    const record = await this.ledger.claim(run);
    const abort = new AbortController();
    const lease = new Lease(run.leaseDurationSeconds ?? 60);
    lease.renew(run.leaseDurationSeconds ?? 60, claimedAt);
    const redactor = new Redactor([this.config.hostToken, run.leaseToken, run.gitCredential?.token, ...Object.values(run.environmentVariables ?? {})]);
    const sourceRedactor = new Redactor([this.config.hostToken, run.leaseToken, run.gitCredential?.token, ...Object.entries(run.environmentVariables ?? {}).filter(([key]) => /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|(?:DATABASE|DB|REDIS|MONGO).*URL|(?:API|ACCESS).*KEY/i.test(key)).map(([, value]) => value)]);
    const journal = new EventJournal(this.ledger, record, this.client, redactor);
    const active = { run, abort, journal, lease, sourceRedactor, messages: [], approvals: new Map(), handle: null, messageReady: false, leaseLost: false, finishing: Boolean(run.verificationOnly) };
    const persistEvent = journal.event.bind(journal);
    journal.event = async event => { await persistEvent(event); active.console?.publish(event); };
    this.active = active;
    const emit = event => journal.event(event).catch(error => { abort.abort(error); });
    const stdout = redactor.stream(text => { void emit({ type: 'log', stream: 'stdout', text }); });
    const stderr = redactor.stream(text => { void emit({ type: 'log', stream: 'stderr', text }); });
    const output = (stream, text) => (stream === 'stderr' ? stderr : stdout).push(text);
    const timer = setTimeout(() => abort.abort(new RunError('cancelled', 'Run exceeded configured timeout')), Math.min(run.timeoutSeconds * 1000, 2147483647));
    const leaseTimer = setInterval(() => { try { lease.assert(); } catch (error) { active.leaseLost = true; abort.abort(error); } }, 250);
    let controlDone = false;
    const controls = (async () => {
      while (!controlDone && !abort.signal.aborted) {
        try { await this.control(active); }
        catch (error) {
          if ([401, 403, 409, 410].includes(error.status)) { active.leaseLost = true; abort.abort(new RunError('cancelled', 'Controller rejected worker lease')); }
          else if (error instanceof RunError && error.result === 'cancelled') { active.leaseLost = true; abort.abort(error); }
          else if (error instanceof RunError && error.result === 'needs_auth') abort.abort(error);
        }
        if (!controlDone && !abort.signal.aborted) await sleep(10000, abort.signal).catch(() => {});
      }
    })();
    const flushTimer = setInterval(() => { void journal.flush().catch(() => {}); }, 1000);
    let temporary, workspace, checkpoint, verification, final, checkpointPushed = false;
    try {
      lease.assert();
      if (abort.signal.aborted) throw abort.signal.reason;
      if (this.config.herdr?.enabled === true || this.config.rex?.enabled === true) {
        try {
          active.console = await this.startConsole({ config: this.config, run, redactor, signal: abort.signal, input: request => this.consoleInput(active, request) });
          if (active.console) for (const event of active.console.metadata) await journal.event(event);
        } catch (error) {
          if (error.processStopUnproven || abort.signal.aborted) throw error;
          await journal.event({ type: 'log', stream: 'system', text: 'Run console unavailable. Native execution and Origin owner controls remain authoritative.' });
        }
      }
      if (run.verificationOnly && !run.resume?.checkpointSha) throw new RunError('failed', 'Verification-only work requires an exact preserved checkpoint');
      await journal.event({ type: 'status', status: 'preparing' });
      if (run.gitCredential?.expiresAt && run.gitCredential.expiresAt - Date.now() < 60000) await this.refreshGitCredential(active);
      temporary = await temporaryEnvironment(this.root, run);
      active.temporary = temporary;
      workspace = new this.Workspace(this.root, run, temporary, { signal: abort.signal, onOutput: output });
      await workspace.prepare();
      await journal.mutate(value => { value.worktree = workspace.path; value.state = 'preparing'; });
      let summary = run.resume?.summary || 'Re-verified preserved task checkpoint against current base';
      if (!run.verificationOnly) {
        if (run.resume?.checkpointSha) await workspace.alignBase();
        if (run.selection.harness === 't3') throw new RunError('needs_approval', `T3 automation is not enrolled with a stable, lease-fenced server. Manually add this isolated folder as a T3 project: ${workspace.path}. Select the requested account, model and effort explicitly; no T3 model was started.`);
        const previousAccount = selectAccount(this.accounts, run.selection, run.billingKind);
        const refreshed = await this.discover({ ...this.config, accounts: [previousAccount.binding] });
        const account = selectAccount(refreshed, run.selection, run.billingKind);
        if (account.report.identityHash !== previousAccount.report.identityHash) throw new RunError('needs_auth', 'The selected local profile now belongs to another provider account');
        this.accounts = this.accounts.map(value => value === previousAccount ? account : value);
        active.account = account;
        const sessionDirectory = join(this.root, 'sessions', `${run.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${run.attempt ?? 1}`);
        await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
        lease.assert();
        await journal.event({ type: 'status', status: 'running' });
        await journal.mutate(value => { value.state = 'running'; });
        lease.assert();
        if (abort.signal.aborted) throw abort.signal.reason;
        const prompt = `Origin execution contract: Work only in this isolated worktree. Do not read or change personal checkouts or authentication. Do not push or merge; Origin verifies and pushes the exact head after you stop. Do not start detached daemons. Use the explicitly selected model and account only.\nProject application variables (including API keys) are intentionally NOT in your native CLI environment. To run an application/test command with its scoped variables, use: "$ORIGIN_PROJECT_NODE" "$ORIGIN_PROJECT_ENV_RUNNER" --file "$ORIGIN_PROJECT_ENV_FILE" -- npm test (replace npm test with the actual command/arguments). The protected JSON file is outside the checkout; never print, copy, commit, or interpolate its secret values into command arguments. Origin's configured verification/smoke commands already receive the project variables directly.\n\nTask:\n${run.prompt}${run.resume?.summary ? `\nPrevious checkpoint summary:\n${run.resume.summary}` : ''}`;
        active.activityStarted = true;
        active.handle = await this.startHarness({ run, account, cwd: workspace.path, sessionDirectory, projectEnvironmentFile: temporary.environmentFile, prompt, signal: abort.signal, output,
          addSecret: value => { redactor.add(value); sourceRedactor.add(value); },
          approve: (tool, input) => this.approve(active, redactor, tool, input),
          usage: usage => {
            if (usage.quota) account.report.quota = usage.quota;
            const tokens = { ...usage }; delete tokens.quota;
            void emit({ type: 'usage', ...tokens, account: account.report });
          },
        });
        const drain = (active.controlPending ?? Promise.resolve()).catch(() => {}).then(async () => {
          for (const message of active.messages.splice(0)) {
            lease.assert(); abort.signal.throwIfAborted();
            await active.handle.message(message.text);
          }
          active.messageReady = true;
        });
        active.controlPending = drain;
        await drain;
        const result = await active.handle.done;
        summary = result.summary;
        active.finishing = true;
        await active.handle.stop(); active.handle = null;
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      checkpoint = await workspace.checkpoint('Origin execution checkpoint', sourceRedactor, { push: false });
      lease.assert(); await this.refreshGitCredential(active, temporary);
      await workspace.alignBase();
      checkpoint = await workspace.checkpoint('Origin aligned execution checkpoint', sourceRedactor, { push: false });
      await journal.event({ type: 'status', status: 'verifying' });
      verification = await workspace.verify(redactor);
      if (verification.some(value => value.exitCode !== 0) || verification.length !== run.verificationCommands.length + 1) throw new RunError('failed', 'Configured verification or smoke command failed');
      const dirty = (await workspace.git(['status', '--porcelain'])).stdout;
      const verifiedHead = (await workspace.git(['rev-parse', 'HEAD'])).stdout.trim();
      if (dirty || verifiedHead !== checkpoint.sha) throw new RunError('failed', 'Verification changed tracked/untracked files or HEAD; refusing to push an unverified commit');
      lease.assert(); await this.refreshGitCredential(active, temporary);
      checkpoint = await workspace.checkpoint('Origin verified checkpoint', sourceRedactor);
      checkpointPushed = true;
      await journal.event({ type: 'checkpoint', ...checkpoint });
      final = { type: 'finished', result: 'succeeded', activityStarted: Boolean(active.activityStarted), summary: redactor.text(summary).slice(0, 4000), headSha: checkpoint.sha, baseSha: workspace.baseSha, branch: checkpoint.branch, checkpointSha: checkpoint.sha, verification, processStopped: true };
    } catch (error) {
      if (error.cleanupIncomplete || error.processStopUnproven) throw error;
      if (abort.signal.aborted) error = abort.signal.reason;
      await active.handle?.stop(); active.handle = null;
      for (const pending of active.approvals.values()) pending(false);
      active.approvals.clear();
      if (!abort.signal.aborted && error.httpStatus === 429 && active.account) {
        try {
          const reports = await this.discover({ ...this.config, accounts: [active.account.binding] });
          const refreshed = reports.find(value => value.report.id === active.account.report.id && value.report.identityHash === active.account.report.identityHash);
          if (refreshed) {
            active.account.report.quota = refreshed.report.quota;
            await emit({ type: 'usage', account: active.account.report });
            if (confirmedExhausted(refreshed.report.quota, Date.now(), run.selection.model)) error = new RunError('quota', 'Native telemetry confirms quota exhaustion after provider rejection');
          }
        } catch (refreshError) {
          if (refreshError.processStopUnproven) throw refreshError;
          await emit({ type: 'log', stream: 'system', text: 'Native usage refresh unavailable; provider rejection is not proof of exhaustion.' });
        }
        if (abort.signal.aborted) error = abort.signal.reason;
      }
      if (workspace && record.worktree) {
        // Local preservation is allowed after fencing. Never push or resume model work on a lost lease.
        workspace.signal = undefined;
        try {
          let push = !active.leaseLost && !abort.signal.aborted;
          if (push) { lease.assert(); await this.refreshGitCredential(active, temporary); }
          checkpoint = await workspace.checkpoint('Origin interrupted execution checkpoint', sourceRedactor, { push });
          checkpointPushed = push;
          await journal.mutate(value => { value.localCheckpointSha = checkpoint.sha; });
          if (push) await journal.event({ type: 'checkpoint', ...checkpoint });
        } catch (checkpointError) {
          if (checkpointError.processStopUnproven) throw checkpointError;
          await emit({ type: 'log', stream: 'system', text: `Checkpoint retained locally where possible: ${redactor.text(checkpointError.message)}` });
        }
      }
      final = { type: 'finished', result: classifyFailure(error), activityStarted: Boolean(active.activityStarted), summary: redactor.text(error.message ?? String(error)).slice(0, 4000), ...(checkpoint && checkpointPushed ? { checkpointSha: checkpoint.sha, branch: checkpoint.branch } : {}), ...(verification ? { verification } : {}), processStopped: true };
    } finally {
      active.closing = true;
      clearTimeout(timer); clearInterval(leaseTimer); clearInterval(flushTimer); controlDone = true;
      abort.abort(new RunError('cancelled', 'Execution finished'));
      await controls;
      await active.controlPending?.catch(() => {});
      stdout.end(); stderr.end();
      try {
        await temporary?.dispose();
        if (final) await journal.event(final);
        try { await journal.flush(active.leaseLost); } catch { /* Stopped receipt stays durable for reconnect. */ }
      } finally {
        await active.console?.close(final ? 'Native execution stopped. See Origin for the audited result.' : 'Native stop is unproven. Origin has fenced this execution; operator recovery is required.');
        this.active = null;
        await this.status();
      }
    }
  }
  async consoleInput(active, value) {
    const request = validateConsoleInput(value);
    const operation = (active.controlPending ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.active !== active || active.closing) throw new Error('Run console is closed');
      // Local-owner IPC is not a lease or authorization bypass. Serialize with normal
      // controls, refresh membership/lease and apply pending Origin controls first.
      try { await this.performControl(active); }
      catch (error) {
        if ([401, 403, 409, 410].includes(error.status) || (error instanceof RunError && error.result === 'cancelled')) {
          active.leaseLost = true; active.abort.abort(new RunError('cancelled', 'Controller rejected console authorization'));
        } else if (error instanceof RunError && error.result === 'needs_auth') active.abort.abort(error);
        throw error;
      }
      active.lease.assert();
      if (active.abort.signal.aborted || active.closing || this.active !== active) throw new Error('Run is no longer accepting input');
      const fingerprint = createHash('sha256').update(JSON.stringify([request.action, request.text ?? ''])).digest('hex');
      const previous = active.journal.record.consoleInputs?.find(entry => entry.id === request.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Request ID was already used for different input');
        return { state: previous.state, duplicate: true };
      }
      if ((active.journal.record.consoleInputs?.length ?? 0) >= 1000) throw new Error('Run console input limit reached');
      if (request.action === 'followup' && (active.finishing || !active.messageReady || !active.handle)) throw new Error('Native model is not accepting follow-ups; use an Origin continuation');
      // Admission is durable BEFORE native delivery. A lost acknowledgement or
      // uncertain send must never replay the same model input, even after a crash.
      await active.journal.mutate(record => { (record.consoleInputs ??= []).push({ id: request.id, fingerprint, action: request.action, state: 'admitted' }); });
      try {
        active.lease.assert();
        if (active.abort.signal.aborted || active.closing) throw new Error('Run closed after input admission');
        if (request.action === 'cancel') active.abort.abort(new RunError('cancelled', 'Cancelled by local owner in Origin run console'));
        else await active.handle.message(request.text);
        await active.journal.mutate(record => { record.consoleInputs.find(entry => entry.id === request.id).state = 'delivered'; });
        return { state: 'delivered' };
      } catch (error) {
        await active.journal.mutate(record => { record.consoleInputs.find(entry => entry.id === request.id).state = 'uncertain'; });
        throw error;
      }
    });
    active.controlPending = operation;
    return operation;
  }
  async control(active, refreshGitCredential = false) {
    const request = (active.controlPending ?? Promise.resolve()).catch(() => {}).then(() => this.performControl(active, refreshGitCredential));
    active.controlPending = request;
    return request;
  }
  async performControl(active, refreshGitCredential = false) {
    const request = { runId: active.run.id, leaseToken: active.run.leaseToken, ackMessageIds: active.journal.record.messages, ackApprovalIds: active.journal.record.approvals ?? [], ...(refreshGitCredential ? { refreshGitCredential: true } : {}) };
    const requestedAt = active.lease.clock();
    const response = await this.client.request('control', request);
    if (response.leaseValid !== true) { active.leaseLost = true; throw Object.assign(new Error('Invalid lease'), { status: 409 }); }
    active.lease.assert();
    active.lease.renew(response.leaseDurationSeconds ?? 60, requestedAt);
    if (active.abort.signal.aborted) throw active.abort.signal.reason;
    if (response.gitCredential) {
      const credential = response.gitCredential;
      if (typeof credential.token !== 'string' || !credential.token || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) throw new RunError('needs_auth', 'Controller returned an invalid repository credential');
      active.run.gitCredential = credential;
      active.journal.redactor.add(credential.token); active.sourceRedactor.add(credential.token);
      if (active.temporary) Object.assign(active.temporary.gitEnv, { ORIGIN_GIT_USERNAME: credential.username ?? 'x-access-token', ORIGIN_GIT_TOKEN: credential.token });
    }
    if (response.cancel) { active.abort.abort(new RunError('cancelled', 'Cancelled by Origin')); return response; }
    for (const approval of response.approvals ?? []) {
      const resolve = active.approvals.get(approval.approvalId);
      if (resolve) {
        await active.journal.mutate(record => { (record.approvals ??= []).push(approval.approvalId); });
        active.approvals.delete(approval.approvalId); resolve(approval.decision === 'allow');
      }
    }
    for (const message of response.messages ?? []) {
      if (active.journal.record.messages.includes(message.id)) continue;
      if (active.finishing) {
        active.abort.abort(new RunError('needs_approval', 'A new task message arrived after model completion. The checkpoint is preserved; start a continuation to apply it.'));
        break;
      }
      // Durable admission before delivering: reconnect must not issue the same prompt twice.
      await active.journal.mutate(record => { record.messages.push(message.id); });
      if (active.messageReady && active.handle) await active.handle.message(message.text); else active.messages.push(message);
    }
    return response;
  }
  async refreshGitCredential(active, temporary) {
    const credential = active.run.gitCredential;
    if (!credential || !credential.expiresAt || credential.expiresAt - Date.now() < 60000) await this.control(active, true);
    if (active.abort.signal.aborted) throw active.abort.signal.reason;
    const latest = active.run.gitCredential;
    if (!latest || (latest.expiresAt && latest.expiresAt <= Date.now())) throw new RunError('needs_auth', 'Repository push needs a refreshed scoped credential');
    if (temporary) {
      temporary.gitEnv.ORIGIN_GIT_USERNAME = latest.username;
      temporary.gitEnv.ORIGIN_GIT_TOKEN = latest.token;
    }
    // Refresh tokens must enter the live redactor before a git error can contain them.
    active.journal.redactor.add(latest.token);
    active.sourceRedactor.add(latest.token);
  }
  async approve(active, redactor, tool, input) {
    if (active.abort.signal.aborted) return false;
    const approvalId = randomUUID();
    const answer = new Promise(resolve => {
      const abort = () => { active.approvals.delete(approvalId); resolve(false); };
      active.abort.signal.addEventListener('abort', abort, { once: true });
      active.approvals.set(approvalId, allow => { active.abort.signal.removeEventListener('abort', abort); resolve(allow); });
    });
    await active.journal.event({ type: 'approval', approvalId, tool: redactor.text(tool), input: redactor.value(input) });
    const allow = await answer;
    if (!allow && !active.abort.signal.aborted) active.abort.abort(new RunError('needs_approval', 'Tool permission denied by task owner'));
    return allow;
  }
}
