const DAY = 24 * 60 * 60_000;
const RETRY = 60 * 60_000;
// After the company connection returns, an overdue backup waits this long so
// the person can see (and turn off) the schedule before anything uploads.
const RESUME_DELAY = 15 * 60_000;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const sameScope = (left, right) => Boolean(left && right && left.key === right.key && left.generation === right.generation);
/** A schedule saved under an older key form for this same authority. */
const legacyScope = (record, authority) => Boolean(record && authority && record.scope !== authority.key && authority.adopts?.(record.scope));

/** One opt-in schedule for this desktop workspace. The encrypted store and
 * transfer are injected so this never owns a second credential or upload path. */
export function createCompanyBackupSchedule({ store, scope, run, onState = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let record = null, revision = 0, timer = null, closed = false, started = false;
  let controller = null, operation = null, status = "off", message, needsClear = false, awaitingAuthority = false;
  const snapshot = () => ({ enabled: Boolean(record) || needsClear, status, ...(record ? {
    nextBackupAt: record.nextBackupAt,
    ...(record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt }),
    ...(record.lastBackupAt === undefined ? {} : { lastBackupAt: record.lastBackupAt }),
  } : {}), ...(message ? { message } : {}) });
  const publish = (nextStatus, nextMessage) => { status = nextStatus; message = nextMessage; onState(snapshot()); return snapshot(); };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const current = stamp => !closed && stamp === revision;
  const arm = () => {
    stopTimer();
    if (!closed && started && record && !operation) {
      // ponytail: one hourly retry, no missed-day queue or background OS job.
      const authority = scope();
      let delay = authority ? Math.max(1000, Math.min(DAY, record.nextBackupAt - now())) : RETRY;
      if (authority && awaitingAuthority) { awaitingAuthority = false; delay = Math.max(delay, RESUME_DELAY); }
      else if (!authority) awaitingAuthority = true;
      timer = setTimer(() => { timer = null; return tick().catch(() => {}); }, delay);
      timer?.unref?.();
    }
  };
  async function forget() {
    const stamp = ++revision;
    stopTimer(); controller?.abort(); record = null; needsClear = true;
    publish("paused", "Turning daily backups off.");
    try {
      await store.write(null);
      if (current(stamp)) { needsClear = false; publish("off"); }
    }
    catch {
      if (current(stamp)) publish("error", "The saved schedule could not be cleared. Unlock your system keychain and turn daily backups off again before restarting.");
      throw new Error("The saved daily backup schedule could not be cleared.");
    }
    return snapshot();
  }
  /** Rewrites a legacy key in place; never turns the schedule off. */
  async function adopt(authority) {
    const stamp = revision, adopted = { ...record, scope: authority.key };
    await store.write(adopted);
    if (current(stamp) && record && legacyScope(record, authority)) record = adopted;
  }
  async function tick() {
    if (closed || !started || !record || operation) return;
    const currentScope = scope(), authority = currentScope ? { ...currentScope } : null;
    if (legacyScope(record, authority)) { try { await adopt(authority); } catch { publish("error", "Daily backups could not be updated. Unlock your system keychain; they will retry in an hour."); arm(); return; } }
    if (authority && authority.key !== record.scope) { await forget(); return; }
    if (!authority) { awaitingAuthority = true; publish("paused", "Daily backups will resume when this installation and the company connection are available."); arm(); return; }
    if (record.nextBackupAt > now()) { publish("waiting"); arm(); return; }
    const stamp = revision, abort = new AbortController();
    controller = abort;
    const active = record;
    // Reserve the retry before starting any work, including after a crash.
    active.nextBackupAt = now() + RETRY;
    active.lastAttemptAt = now();
    const work = (async () => {
      try {
        await store.write({ ...active });
        if (!current(stamp) || !sameScope(authority, scope())) return;
        abort.signal.throwIfAborted();
        publish("running");
        await run(abort.signal, authority);
        if (!current(stamp) || !sameScope(authority, scope())) return;
        abort.signal.throwIfAborted();
        const completed = { ...active, lastBackupAt: now(), nextBackupAt: now() + DAY };
        await store.write(completed);
        if (current(stamp)) { record = completed; publish("waiting"); }
      } catch (error) {
        if (!current(stamp)) return;
        publish(abort.signal.aborted || error?.code === "workspace_busy" ? "paused" : "error",
          abort.signal.aborted || error?.code === "workspace_busy"
            ? "Daily backup postponed. It will retry when this installation is available."
            : "The daily backup did not complete. Check your connection, system keychain and free disk space; it will retry in an hour.");
      }
    })();
    operation = work;
    try { await work; }
    finally {
      if (operation === work) operation = null;
      if (controller === abort) controller = null;
      arm();
    }
  }
  return {
    state: snapshot,
    async start() {
      if (started || closed) return snapshot();
      started = true;
      const stamp = revision;
      try {
        const saved = await store.read();
        if (!current(stamp)) return snapshot();
        if (saved !== null) {
          if (!saved || ![1, 2].includes(saved.version) || typeof saved.scope !== "string" || saved.scope.length > 8192 ||
              !validTime(saved.nextBackupAt) || (saved.lastAttemptAt !== undefined && !validTime(saved.lastAttemptAt)) ||
              (saved.lastBackupAt !== undefined && !validTime(saved.lastBackupAt))) throw new Error("Invalid schedule");
          record = { version: 2, scope: saved.scope, nextBackupAt: Math.min(saved.nextBackupAt, now() + DAY),
            ...(saved.lastAttemptAt === undefined ? {} : { lastAttemptAt: saved.lastAttemptAt }),
            ...(saved.lastBackupAt === undefined ? {} : { lastBackupAt: saved.lastBackupAt }) };
          if (saved.version === 1) await store.write({ ...record });
          if (!current(stamp)) return snapshot();
        }
        publish(record ? "waiting" : "off");
        await tick();
      } catch {
        if (current(stamp)) { record = null; publish("error", "Daily backups could not be restored. Unlock your system keychain and enable them again."); }
      }
      return snapshot();
    },
    async configure(input) {
      if (closed) throw new Error("The desktop is shutting down.");
      if (input?.enabled === false && Object.keys(input).length === 1) return forget();
      if (needsClear) throw new Error("Finish turning daily backups off before enabling them again.");
      if (input?.enabled !== true || input.confirmation !== "BACK UP THIS WORKSPACE DAILY" ||
          Object.keys(input).some(key => !["enabled", "confirmation"].includes(key))) throw new Error("Confirm daily backup of this entire installation.");
      const currentScope = scope(), authority = currentScope ? { ...currentScope } : null;
      if (!authority) throw new Error("Connect your organization in the local desktop before enabling daily backups.");
      const stamp = ++revision;
      stopTimer(); controller?.abort();
      record = { version: 2, scope: authority.key, nextBackupAt: now() + DAY };
      try {
        await store.write({ ...record });
        if (!current(stamp)) return snapshot();
        if (!sameScope(authority, scope())) { await forget(); throw new Error("Your organization connection changed."); }
        started = true; publish("waiting"); arm(); return snapshot();
      } catch (error) {
        if (current(stamp)) { record = null; publish("error", "Daily backups were not enabled. Unlock your system keychain and try again."); }
        throw error;
      }
    },
    forget,
    reconcile() {
      const authority = scope();
      if (!authority) { controller?.abort(); if (record) awaitingAuthority = true; }
      if (legacyScope(record, authority)) { void adopt(authority).then(() => arm(), () => arm()); return; }
      if (record && authority && record.scope !== authority.key) { void forget().catch(() => {}); return; }
      // Repeated connection refreshes cannot bring a persisted retry forward.
      arm();
    },
    close() { closed = true; revision++; stopTimer(); controller?.abort(); record = null; },
  };
}
