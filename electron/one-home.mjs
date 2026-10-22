// The one-time move that makes the person's own Cloud their only home. cloud-send.mjs carries everything; this runs it
// once, in phases, and keeps where it is in one journal (userData/one-home.json), so each launch goes on from there:
//
//   copy    everything goes while this computer stays home and fully usable
//   wait    until a quiet moment: nothing answering, queued or in a card or sign-in here, and nobody typing for 30 s
//   freeze  this computer's server stops (server/move-freeze.ts): no turns, schedules, webhooks or app events
//   final   the same pass again, for what changed since, with the sign-ins that refresh themselves
//   check   what arrived, against what is here; anything missing goes again, three passes at most
//   switch  My Cloud switches on what was on here, and keeps which computer its bots came from
//   done    home is My Cloud: this computer lends itself, stops its phone link, and says once what arrived
//
// Before the switch a failure lifts the freeze and tries again later; from the switch on the move only goes forward, so
// nothing ever runs in two places. If My Cloud ends, this computer is home again at once (`home-again`), then brings
// back what was done on My Cloud while the Admin still holds it (one-home-again.mjs) and switches on what was on there
// (`back`).

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 300) : null);

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const QUIET_MS = 30_000;
const BUSY_POLL_MS = 5_000;
/** The longest a timer waits before it looks again: longer ones overflow Node's timers. */
const LONGEST_WAIT_MS = 6 * HOUR;
export const CHECK_PASSES = 3;
/** A failure while this computer's server is frozen: lifted, and tried again in an hour. */
export const FROZEN_RETRY_MS = HOUR;
/** A failure before the freeze (no network, My Cloud asleep or updating): tried again sooner at first, then hourly. */
export const COPY_RETRY_MS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR];
export const FAILING_LINE_MS = DAY;
/** This computer's copy is kept this long after the move, and until My Cloud has been paid for once. */
export const KEPT_MS = 30 * DAY;
const PHASES = new Set(["copy", "wait", "freeze", "final", "check", "switch", "done", "home-again", "back"]);
const FROZEN = new Set(["freeze", "final", "check"]);
const AUTOMATION = /^(routine|call|webhook|app-event):([\w-]{1,128})$/u;

/** What a check found missing, by kind and count only: "2 chats, 1 memory". */
export function missingOf(report) {
  const counts = Object.entries(record(report?.gaps) ? report.gaps : {}).flatMap(([kind, list]) => (Array.isArray(list) && list.length ? [`${list.length} ${kind}`] : []));
  const chats = (Array.isArray(report?.chats) ? report.chats : []).filter((entry) => entry.missing || entry.unstamped || entry.path === "broken").length;
  const secrets = (report?.secrets?.differs?.length ?? 0) + (report?.secrets?.missing?.length ?? 0);
  return [...counts, ...(chats ? [`${chats} chat paths`] : []), ...(report?.attachments?.length ? [`${report.attachments.length} attachments`] : []), ...(secrets ? [`${secrets} credentials`] : [])].join(", ") || "something";
}

const errorText = (error) => (typeof error?.errorKey === "string" && error.errorKey.startsWith("serverError.")
  ? { errorKey: error.errorKey, errorParams: record(error.errorParams) ? error.errorParams : {} } : { errorKey: undefined, errorParams: undefined });

/** A journal read back, kept to its known shape; null when there is none. */
export function parseJournal(value) {
  if (!record(value) || value.v !== 1 || !PHASES.has(value.phase) || !record(value.cloud) || typeof value.cloud.origin !== "string" || typeof value.cloud.account !== "string") return null;
  return value;
}

/** How one automation is switched on, over the routes its own page uses. */
export function switchOn(key) {
  const match = AUTOMATION.exec(key);
  if (!match) return null;
  const [, kind, id] = match;
  if (kind === "routine") return { method: "PATCH", route: `/api/routines/${id}`, body: { enabled: true } };
  // A call is on when it has a next time: saving it again works that out from its schedule.
  if (kind === "call") return { method: "PATCH", route: `/api/calendar-calls/${id}`, body: {} };
  if (kind === "webhook") return { method: "PATCH", route: `/api/webhooks/${id}`, body: { enabled: true } };
  return { method: "PATCH", route: `/api/app-triggers/${id}`, body: { enabled: true } };
}

/** What arrived, in counts a person recognises: only what both sides hold, this computer's manifest against My Cloud's. */
export function arrivedCounts(here, there) {
  const keys = new Set((there?.items ?? []).map((item) => item.key));
  const items = (here?.items ?? []).filter((item) => keys.has(item.key));
  const count = (...kinds) => items.filter((item) => kinds.includes(item.kind)).length;
  const threads = new Set((there?.conversations ?? []).map((head) => head.threadId));
  const automations = new Set((there?.automations ?? []).map((entry) => entry.key));
  return {
    bots: count("bot"), skills: count("skill", "imported-skill", "library-skill"), logins: count("login"), onePassword: count("1password") > 0,
    chats: (here?.conversations ?? []).filter((head) => threads.has(head.threadId)).length,
    routines: (here?.automations ?? []).filter((entry) => entry.key.startsWith("routine:") && automations.has(entry.key)).length,
  };
}

/**
 * @param {{
 *   journal: { read(): unknown, write(value: unknown): void },
 *   cloud(): null | { origin: string | null, account: string, machine: string | null, ready: boolean, moves: boolean, ended: boolean, paid: boolean },
 *   send: { move(options?: { final?: boolean }): Promise<unknown>, check(): Promise<{ ok: boolean }>, switches(): Record<string, boolean>, snapshot(): any },
 *   local: { freeze(origin: string): Promise<{ frozen: true } | { busy: string }>, unfreeze(): Promise<void>, frozen(): Promise<boolean>, json(route: string): Promise<any>,
 *     call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>, forget?(): Promise<void> },
 *   session(): Promise<{ call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>, close(): Promise<void> }>,
 *   lend?(projects: string[]): Promise<unknown>,
 *   phone?: { paired(): boolean, stop(): Promise<void>, start(): Promise<void> },
 *   openHome?(): void,
 *   openLocal?(): void,
 *   lastInput?(): number,
 *   again?: { bring(): Promise<{ restored: string, switches: Record<string, boolean> } | { deleted: true } | { later: number }> },
 *   restart?(): void,
 *   version?: string,
 *   onChange?(view: unknown): void,
 *   now?(): number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void },
 *   log?(line: string): void,
 * }} deps
 */
export function createOneHome(deps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; }, clear: (timer) => clearTimeout(timer) };
  const log = deps.log ?? (() => {});
  let running = null, again = false, timer = null, closed = false, waitingFor = null, wasReady = null;

  const read = () => parseJournal(deps.journal.read());
  const publish = () => { try { deps.onChange?.(view()); } catch {} };
  const write = (journal) => { deps.journal.write(journal); publish(); return journal; };
  const later = (ms) => {
    if (closed) return;
    if (timer) timers.clear(timer);
    timer = timers.set(() => { timer = null; void kick(); }, Math.min(LONGEST_WAIT_MS, Math.max(250, ms)));
  };

  /** What the line on either page says: the phase, its progress, who it waits for, a day of failing, the done line
   * until it is closed, and coming home. Null when there is nothing to say. */
  function view() {
    const journal = read();
    if (!journal || journal.paused || journal.told) return null;
    if (journal.phase === "done") return { phase: "done", ...(journal.counts ? { counts: journal.counts } : {}), phone: journal.phone === true, held: journal.held ?? [] };
    if (journal.phase === "home-again" || journal.phase === "back") return { phase: journal.phase, ...(journal.lost ? { lost: true } : {}) };
    const running = deps.send.snapshot?.()?.running;
    const chats = journal.phase === "copy" && running?.phase === "chats" && running.progress ? { done: running.progress.done, total: running.progress.total } : null;
    const failing = journal.failingSince && now() - journal.failingSince >= FAILING_LINE_MS
      ? { error: journal.error ?? null, ...(journal.error && journal.errorKey ? { errorKey: journal.errorKey, errorParams: journal.errorParams ?? {} } : {}) } : null;
    const phase = FROZEN.has(journal.phase) || journal.phase === "switch" ? "finishing" : journal.phase;
    return { phase, ...(chats ? { chats } : {}), ...(phase === "wait" && waitingFor !== null ? { waitingFor } : {}), ...(failing ? { failing } : {}) };
  }

  /** Lifts this computer's freeze; true once it is lifted. */
  async function thaw(journal) {
    try { await deps.local.unfreeze(); } catch (error) { log(`one home: could not lift the freeze yet (${error?.message ?? error})`); later(MINUTE); return false; }
    const { thaw: _, ...rest } = journal;
    write(rest);
    return true;
  }

  /** The move fails here: a frozen server is lifted, and it all goes again later from the copy. */
  async function failed(journal, error, frozen) {
    const said = sentence(error?.message) ?? "My Cloud did not answer.";
    log(`one home: ${journal.phase} failed (${said})`);
    const tries = (journal.tries ?? 0) + 1;
    const next = write({ ...journal, phase: "copy", passes: 0, tries, error: said, ...errorText(error), failingSince: journal.failingSince ?? now(),
      retryAt: now() + (frozen ? FROZEN_RETRY_MS : COPY_RETRY_MS[Math.min(tries - 1, COPY_RETRY_MS.length - 1)]), hourly: frozen || undefined, ...(frozen ? { thaw: true } : {}) });
    if (frozen) await thaw(next);
    return null;
  }

  async function copy(journal) {
    waitingFor = null;
    try { await deps.send.move(); }
    catch (error) { return failed(journal, error, false); }
    return write({ ...journal, phase: "wait", retryAt: undefined, hourly: undefined });
  }

  async function wait(journal) {
    const quietFor = now() - (deps.lastInput?.() ?? 0);
    if (quietFor < QUIET_MS) { later(QUIET_MS - quietFor); return null; }
    // The journal says "freeze" before the server is frozen: a crash in between resumes frozen, never forgotten.
    return freeze(write({ ...journal, phase: "freeze" }));
  }

  async function freeze(journal) {
    let answer;
    try { answer = await deps.local.freeze(journal.cloud.origin); }
    catch (error) { return failed(journal, error, true); }
    if (record(answer) && typeof answer.busy === "string") {
      waitingFor = answer.busy;
      write({ ...journal, phase: "wait" });
      later(BUSY_POLL_MS);
      return null;
    }
    waitingFor = null;
    return write({ ...journal, phase: "final", frozenAt: now() });
  }

  async function final(journal) {
    try { await deps.send.move({ final: true }); }
    catch (error) { return failed(journal, error, true); }
    return write({ ...journal, phase: "check", passes: 1 });
  }

  async function check(journal) {
    let passes = journal.passes ?? 1;
    try {
      for (let report = await deps.send.check(); report?.ok !== true; report = await deps.send.check()) {
        log(`one home: the check found ${missingOf(report)} missing`);
        if (passes >= CHECK_PASSES) throw new Error("Some of this computer's things did not reach My Cloud.");
        await deps.send.move({ final: true });
        passes += 1;
        write({ ...journal, passes });
      }
    } catch (error) { return failed({ ...journal, passes }, error, true); }
    let counts = null;
    try {
      const session = await deps.session();
      try { counts = arrivedCounts(await deps.local.json("/api/cloud-send/manifest"), (await session.call("GET", "/api/cloud-send/manifest")).body); }
      finally { await session.close().catch(() => {}); }
    } catch {}
    return write({ ...journal, phase: "switch", passes, checkedAt: now(), ...(counts ? { counts } : {}) });
  }

  /** The point of no return: My Cloud switches on what was on here, and keeps which computer its bots came from. */
  async function switchOver(journal) {
    const switches = deps.send.switches();
    const switched = { ...journal.switched };
    let session;
    try {
      session = await deps.session();
      for (const [key, on] of Object.entries(switches)) {
        const change = on && !switched[key] ? switchOn(key) : null;
        if (!change) continue;
        const answer = await session.call(change.method, change.route, change.body);
        // One deleted on My Cloud meanwhile stays deleted; any other refusal is tried again.
        if (!answer.ok && answer.status !== 404) throw Object.assign(new Error(sentence(answer.body?.error) ?? "My Cloud did not switch on an automation."), { status: answer.status });
        switched[key] = true;
        write({ ...journal, switched });
      }
      const computer = sentence((await deps.local.json("/api/cloud-connections").catch(() => null))?.computer?.label) ?? "this computer";
      const webhooks = Object.keys(switches).flatMap((key) => (key.startsWith("webhook:") ? [key.slice("webhook:".length)] : []));
      const arrived = await session.call("POST", "/api/cloud-send/arrived", { v: 1, computer, webhooks });
      if (!arrived.ok) throw Object.assign(new Error(sentence(arrived.body?.error) ?? "My Cloud did not finish the move."), { status: arrived.status });
    } catch (error) {
      log(`one home: switching over goes on later (${error?.message ?? error})`);
      const next = write({ ...journal, switched, error: sentence(error?.message) ?? undefined, ...errorText(error), retryAt: now() + 2 * MINUTE });
      later(next.retryAt - now());
      return null;
    } finally { await session?.close().catch(() => {}); }
    const held = (deps.send.snapshot?.()?.whole?.result?.notes ?? []).filter((note) => note?.kind === "held" && typeof note.connection === "string").map((note) => note.connection);
    const done = write({ ...journal, phase: "done", switched, doneAt: now(), version: deps.version ?? null, phone: deps.phone?.paired() === true, held,
      error: undefined, errorKey: undefined, errorParams: undefined, failingSince: undefined, retryAt: undefined, tries: undefined });
    await settle(done);
    deps.openHome?.();
    return null;
  }

  /** Once home is My Cloud: this computer is lent to it, and its own phone link stops. Each once. */
  async function settle(journal) {
    let next = journal;
    if (!next.lent) {
      try {
        const bots = (await deps.local.json("/api/bots?messages=0"))?.bots ?? [];
        await deps.lend?.([...new Set(bots.map((bot) => bot?.cwd).filter((cwd) => typeof cwd === "string" && cwd))]);
        next = write({ ...next, lent: true });
      } catch (error) { log(`one home: this computer is lent later (${error?.message ?? error})`); }
    }
    if (!next.phoneStopped) {
      try {
        if (next.phone) await deps.phone?.stop();
        next = write({ ...next, phoneStopped: true });
      } catch (error) { log(`one home: the phone link stops later (${error?.message ?? error})`); }
    }
    return next;
  }

  /** Home is My Cloud: tops up what a newer app learned to move, deletes this computer's copy once it is old enough and
   * My Cloud was paid for, and comes home if My Cloud ends. */
  async function steady(journal, cloud, waiting) {
    let next = await settle(journal);
    if (cloud?.ended) return homeAgain(next);
    if (!waiting && !next.forgot && deps.version && next.version !== deps.version && cloud?.ready) {
      try { await deps.send.move({ final: true }); next = write({ ...next, version: deps.version, retryAt: undefined }); }
      catch (error) { log(`one home: the top-up waits (${error?.message ?? error})`); next = write({ ...next, retryAt: now() + HOUR }); }
    }
    if (!next.forgot && cloud?.paid && now() - next.doneAt >= KEPT_MS && deps.local.forget) {
      try { await deps.local.forget(); next = write({ ...next, forgot: true }); }
      catch (error) { log(`one home: this computer's copy is deleted later (${error?.message ?? error})`); }
    }
    if (!next.forgot) later(next.doneAt + KEPT_MS - now());
    return null;
  }

  /** My Cloud ended: this computer is home again at once, as it was at the move, then brings back what was done there. */
  async function homeAgain(journal) {
    let next = journal;
    if (next.phase !== "home-again") {
      try { await deps.local.unfreeze(); } catch (error) { log(`one home: could not come home yet (${error?.message ?? error})`); later(MINUTE); return null; }
      next = write({ ...next, phase: "home-again", endedAt: now(), told: undefined });
      try { if (next.phone) await deps.phone?.start(); } catch {}
      deps.openLocal?.();
    }
    if (!deps.again || next.forgot) return write({ ...next, phase: "back", lost: true });
    const retry = (ms) => { write({ ...next, retryAt: now() + ms }); later(ms); return null; };
    let brought;
    try { brought = await deps.again.bring(); }
    catch (error) { log(`one home: bringing My Cloud's things back waits (${error?.message ?? error})`); return retry(5 * MINUTE); }
    if ("later" in brought) return retry(brought.later);
    if ("deleted" in brought) return write({ ...next, phase: "back", lost: true });
    write({ ...next, phase: "back", restoreId: brought.restored, switchBack: brought.switches, retryAt: undefined });
    deps.restart?.();
    return null;
  }

  /** After coming home with My Cloud's backup: what was on at My Cloud is switched on here, which a restore leaves off. */
  async function switchBack(journal) {
    const pending = { ...journal.switchBack };
    for (const [key, on] of Object.entries(pending)) {
      const change = on ? switchOn(key) : null;
      if (change) {
        const answer = await deps.local.call(change.method, change.route, change.body).catch(() => null);
        if (!answer || (!answer.ok && answer.status !== 404)) { later(MINUTE); write({ ...journal, switchBack: pending }); return null; }
      }
      delete pending[key];
    }
    const { switchBack: _, ...rest } = journal;
    write(rest);
    return null;
  }

  async function run() {
    let journal = read();
    const cloud = deps.cloud();
    // A move left off while My Cloud was away goes on as soon as it is back, unless it failed frozen: that waits its hour.
    const cameBack = cloud?.ready === true && wasReady === false;
    wasReady = cloud ? cloud.ready : null;
    const waiting = () => journal.retryAt > now() && !(cameBack && !journal.hourly);
    if (journal && cloud && cloud.account !== journal.cloud.account) {
      // Another account's Cloud never moves this computer's copy, nor lifts its freeze once the move is done.
      if (FROZEN.has(journal.phase)) await failed(journal, new Error("Another MausBot Cloud account signed in."), true);
      return;
    }
    if (journal?.phase === "back" && journal.switchBack) return void await switchBack(journal);
    if (!journal || journal.phase === "back") {
      if (!cloud?.ready || !cloud.moves || cloud.ended || !cloud.origin) return;
      // A frozen server with no move under way is one this app no longer knows about: it is never lifted blindly.
      if (await deps.local.frozen().catch(() => true)) { log("one home: this computer is frozen with no move under way"); return; }
      journal = write({ v: 1, phase: "copy", cloud: { origin: cloud.origin, account: cloud.account, machine: cloud.machine }, startedAt: now() });
    }
    if (journal.thaw && !(await thaw(journal))) return;
    journal = read() ?? journal;
    if (journal.phase === "done") return void await steady(journal, cloud, waiting());
    if (journal.phase === "home-again" || journal.phase === "switch" && cloud?.ended) {
      if (journal.phase === "home-again" && waiting()) return void later(journal.retryAt - now());
      return void await homeAgain(journal);
    }
    if (journal.phase === "switch" && waiting()) return void later(journal.retryAt - now());
    if (journal.phase !== "switch") {
      if (cloud?.ended || cloud && !cloud.moves) {
        // My Cloud ended, or moves were switched off (the Admin's kill switch), before the switch: a frozen server lifts.
        if (FROZEN.has(journal.phase) && !(await thaw({ ...journal, thaw: true }))) return;
        if (cloud.ended) { deps.journal.write(null); publish(); } else write({ ...(read() ?? journal), phase: "copy", paused: true });
        return;
      }
      if (!cloud?.ready) {
        if (FROZEN.has(journal.phase)) await failed(journal, new Error("My Cloud is not ready."), true);
        return;
      }
      if (journal.paused) journal = write({ ...journal, paused: undefined });
      if (journal.phase === "copy" && waiting()) { later(journal.retryAt - now()); return; }
    }
    for (let step = 0; journal && step < 12 && !closed; step++) {
      if (journal.phase === "copy") journal = await copy(journal);
      else if (journal.phase === "wait") journal = await wait(journal);
      else if (journal.phase === "freeze") journal = await freeze(journal);
      else if (journal.phase === "final") journal = await final(journal);
      else if (journal.phase === "check") journal = await check(journal);
      else if (journal.phase === "switch") journal = await switchOver(journal);
      else break;
    }
    const after = read();
    if (after?.phase === "copy" && after.retryAt) later(after.retryAt - now());
  }

  /** Goes on from where the journal is: at launch, on account changes and when a wait is over. One run at a time. */
  async function kick() {
    if (closed) return;
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try { await run(); } catch (error) { log(`one home: ${error?.message ?? error}`); later(MINUTE); }
      } while (again && !closed);
    })().finally(() => { running = null; publish(); });
    return running;
  }

  return {
    kick,
    view,
    /** Home is My Cloud: the switch happened and My Cloud has not ended. */
    away: () => ["switch", "done"].includes(read()?.phase ?? ""),
    /** Try again, after a day of failing: now, not at the next hourly try. */
    retry() {
      const journal = read();
      if (journal?.phase === "copy") write({ ...journal, retryAt: undefined, hourly: undefined });
      return kick();
    },
    /** The done line, or the one about coming home, was closed. */
    seen() {
      const journal = read();
      if (journal && ["done", "back"].includes(journal.phase) && !journal.told) write({ ...journal, told: true });
      return view();
    },
    /** A send's progress moved: the line follows it. */
    changed: publish,
    close() { closed = true; if (timer) timers.clear(timer); },
  };
}
