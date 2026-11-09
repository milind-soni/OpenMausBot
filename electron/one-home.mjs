// The one-time move that makes the person's own Cloud their only home. cloud-send.mjs carries everything; this runs it
// once, in phases, and keeps where it is in one journal (userData/one-home.json), so each launch goes on from there:
//
//   copy    everything goes while this computer stays home and fully usable
//   wait    until a quiet moment: no work under way here (server/move-waits.ts), and nobody typing for 30 s
//   freeze  this computer's server stops (server/move-freeze.ts): no turns, schedules, webhooks or app events
//   final   the same pass again, for what changed since, with the sign-ins that refresh themselves
//   check   what arrived, against what is here; anything missing goes again, three passes at most
//   switch  My Cloud switches on what was on here, and keeps which computer its bots came from
//   done    home is My Cloud: this computer lends itself and says once what arrived
//
// Before the switch a failure lifts the freeze and tries again later; from the switch on the move only goes forward, so
// nothing ever runs in two places. If My Cloud ends, this computer is home again at once (`home-again`), then brings
// back what was done on My Cloud while the Admin still holds it (one-home-again.mjs) and switches on what was on there
// (`back`). Once done, the Admin is told once per sign-in that this computer moved, so it can be the one an ended Cloud's
// things come home to. When the Admin names another computer as that one, this one only opens its own copy, with every
// automation off, and says where the bots went (`back` with `elsewhere`). When the Cloud this computer moved to is gone and
// is not My Cloud any more (deleted, or ended while another Cloud is My Cloud), by the Admin's word on that Cloud, this
// computer opens its own copy as it was at the move, with every automation off, keeps its bots here, and says so once
// (`back` with `gone`). That word is asked for the journal's Cloud, or for the Cloud the freeze names when this app kept no
// journal.
//
// A person may keep this computer's bots on this computer (`keep`, its own choice, kept on this computer). Then no move
// starts, and one under way stops before the switch as the Admin's kill switch stops it. Once this computer has moved,
// its bots come home to it while My Cloud goes on (`keeping`): My Cloud's backup is staged here, the automations this
// computer brought stop there, this computer opens with every automation off and restores the backup, and once the app
// opens again what was on of them at My Cloud is switched on here (`back` with `kept`). The Admin is then told this
// computer no longer counts as moved. Choosing otherwise again moves it again, as anyone's first move.
import nativeText from "./native-text.cjs";

import { failureOf, rateLimited } from "./move-failure.mjs";
import { gapKey, gapSummary, stayedBehind } from "./move-gaps.mjs";

export { rateLimited };

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 300) : null);

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const QUIET_MS = 30_000;
const BUSY_POLL_MS = 5_000;
/** The longest a timer waits before it looks again: longer ones overflow Node's timers. */
const LONGEST_WAIT_MS = 6 * HOUR;
export const CHECK_PASSES = 3;
/** A failure while this computer's server is frozen: lifted, and tried again in an hour, then twice as long after each
 * one that follows, up to FROZEN_RETRY_MAX_MS, so a move that keeps failing does not stop this computer every hour. */
export const FROZEN_RETRY_MS = HOUR;
export const FROZEN_RETRY_MAX_MS = 12 * HOUR;
/** What the line and the Admin say when the check still found things missing after its passes. */
export const INCOMPLETE = "Some things didn't reach My Cloud yet. It tries again by itself, and if they still can't go, the rest moves without them and you'll see what stayed here.";
/** A failure before the freeze (no network, My Cloud asleep or updating): tried again sooner at first, then hourly. */
export const COPY_RETRY_MS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR];
export const FAILING_LINE_MS = DAY;
/** At most this many of the things a move could not carry are named on its line. */
const NAMED_MAX = 5;
/** This computer's copy is kept this long after the move, and until My Cloud has been paid for once. */
export const KEPT_MS = 30 * DAY;
const PHASES = new Set(["copy", "wait", "freeze", "final", "check", "switch", "done", "keeping", "home-again", "back"]);
const FROZEN = new Set(["freeze", "final", "check"]);
/** The phases in which home is My Cloud: the window shows it. */
const AWAY = new Set(["switch", "done", "keeping"]);
/** The phases that use My Cloud's owner session, a pass that failed and waits to go again included. */
const MOVING = new Set(["copy", "wait", "freeze", "final", "check", "switch"]);
/** The phases a restart of this app would cut into: from the wait for the quiet moment to the switch. */
const CUT_SHORT = new Set(["wait", ...FROZEN, "switch"]);
const AUTOMATION = /^(routine|call|webhook|app-event):([\w-]{1,128})$/u;

/** At most this many ids of a kind in the log line. */
const LOGGED_IDS = 10;
const ID = /^[\w-]{1,200}$/u;
/** Rooms and conversations are named by their ids, never their names: what a person can be asked about, nothing they wrote. */
const IDS_OF = { rooms: (entry) => entry?.id, conversations: (entry) => entry, settings: (entry) => entry };
const named = (ids) => {
  const kept = ids.filter((id) => typeof id === "string" && ID.test(id));
  return kept.length ? ` (${kept.slice(0, LOGGED_IDS).join(", ")}${kept.length > LOGGED_IDS ? `, ${kept.length - LOGGED_IDS} more` : ""})` : "";
};

/** What a check found missing, by kind and count, and the rooms and conversations by id: "3 rooms (r1, r2, r3), 1 memory". */
export function missingOf(report) {
  const counts = Object.entries(record(report?.gaps) ? report.gaps : {}).flatMap(([kind, list]) => (Array.isArray(list) && list.length
    ? [`${list.length} ${kind}${IDS_OF[kind] ? named(list.map(IDS_OF[kind])) : ""}`] : []));
  const chats = (Array.isArray(report?.chats) ? report.chats : []).filter((entry) => entry.missing || entry.unstamped || entry.path === "broken");
  const secrets = (report?.secrets?.differs?.length ?? 0) + (report?.secrets?.missing?.length ?? 0);
  return [...counts, ...(chats.length ? [`${chats.length} chat paths${named(chats.map((entry) => entry.threadId))}`] : []), ...(report?.attachments?.length ? [`${report.attachments.length} attachments`] : []),
    ...(secrets ? [`${secrets} credentials`] : [])].join(", ") || "something";
}

/** A move's stage: a freeze that finds work under way goes back to waiting, which is the same wait. */
const stageOf = (phase) => (phase === "freeze" ? "wait" : phase);
/** A failure of the move's own, with the code it is reported by. */
const tagged = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const errorText = (error) => (typeof error?.errorKey === "string" && error.errorKey.startsWith("serverError.")
  ? { errorKey: error.errorKey, errorParams: record(error.errorParams) ? error.errorParams : {} } : { errorKey: undefined, errorParams: undefined });

/** The session's Cloud (`cloud`: its address, id and `formerOrigins`) is the one kept as `kept` (a journal's Cloud: its
 * address, and its id once known): the same address, the same id, or an address the Cloud had before it moved to another
 * provider. A journal from before ids were kept is known again by that last one alone. */
export const sameCloud = (cloud, kept) => cloud.origin === kept.origin || (Boolean(cloud.id) && cloud.id === kept.id)
  || (Array.isArray(cloud.formerOrigins) && cloud.formerOrigins.includes(kept.origin));

/** The session's My Cloud is known to be another Cloud than `kept`. A held Cloud that names no address gives no sign of being
 * another, so it is taken for that one. */
const anotherCloud = (cloud, kept) => !sameCloud(cloud, kept) && !(cloud.ended && !cloud.origin);

/** A journal read back, kept to its known shape; null when there is none. */
export function parseJournal(value) {
  if (!record(value) || value.v !== 1 || !PHASES.has(value.phase) || !record(value.cloud) || typeof value.cloud.origin !== "string" || typeof value.cloud.account !== "string") return null;
  return value;
}

/** Home is My Cloud by this journal: its switch happened, and its bots are not on their way back here. */
export const awayIn = (journal) => AWAY.has(journal?.phase ?? "");

/** This computer's bots are on their way home and past turning back: their automations stopped on My Cloud, or this
 * computer opened again. */
export const underWay = (journal) => journal?.phase === "keeping" && Boolean(journal.offThere || journal.thawed);

/** This computer's own choice to keep its bots here, read back. */
export function parseKeep(value) {
  return { on: record(value) && value.v === 1 && value.on === true };
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

/** Each automation a manifest lists, by key, and whether it is on. */
export function automationsOn(manifest) {
  return Object.fromEntries((Array.isArray(manifest?.automations) ? manifest.automations : [])
    .filter((entry) => record(entry) && typeof entry.key === "string" && AUTOMATION.test(entry.key) && typeof entry.on === "boolean").map((entry) => [entry.key, entry.on]));
}

/** The automations this computer brought, on or off as My Cloud has them (`there`, from its manifest): those on are
 * switched off there before this computer's bots come home, and on here once they are. */
export function keptSwitches(brought, there) {
  return Object.fromEntries(Object.entries(there ?? {}).filter(([key, on]) => Object.hasOwn(brought, key) && typeof on === "boolean" && AUTOMATION.test(key)));
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
 *   cloud(): null | { origin: string | null, account: string, machine: string | null, ready: boolean, moves: boolean, ended: boolean, paid: boolean,
 *     homecoming?: { installationId: string, name: string }, signIn?: string, verified?: boolean, id?: string, formerOrigins?: string[] },
 *   send: { move(options?: { final?: boolean }): Promise<unknown>, check(): Promise<{ ok: boolean }>, switches(): Record<string, boolean>, snapshot(): any },
 *   local: { freeze(origin: string): Promise<{ frozen: true } | { busy: string, what?: string }>, unfreeze(options?: { automations?: "off" }): Promise<void>, frozen(): Promise<boolean>, json(route: string): Promise<any>,
 *     call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>, forget?(): Promise<void>,
 *     marker?(): Promise<{ frozen: boolean, cloud?: string, place?: string }> },
 *   gone?(origin: string): Promise<"deleted" | "ended" | null>,
 *   session(): Promise<{ call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>, close(): Promise<void> }>,
 *   release?(): Promise<void>,
 *   lend?(projects: string[]): Promise<unknown>,
 *   phone?: { paired(): boolean, start(): Promise<void> },
 *   openHome?(): void,
 *   openLocal?(): void,
 *   lastInput?(): number,
 *   again?: { bring(): Promise<{ restored: string, switches: Record<string, boolean> } | { deleted: true } | { later: number }> },
 *   keep?: { read(): unknown, write(value: unknown): void },
 *   keepHome?: { stage(): Promise<{ staged: true, switches: Record<string, boolean> } | { later: number } | { deleted: true }>,
 *     bring(): Promise<{ restored: string, switches: Record<string, boolean> } | { deleted: true } | { later: number }> },
 *   installation?(): Promise<string | null>,
 *   reportMove?(): Promise<boolean>,
 *   reportKept?(): Promise<boolean>,
 *   restart?(): void,
 *   version?: string,
 *   onChange?(view: unknown): void,
 *   now?(): number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void },
 *   log?(line: string): void,
 *   t?(key: string, params?: Record<string, string | number>): string,
 * }} deps `gone(origin)`: the Admin's word that this account's Cloud at `origin` is gone ("deleted", or "ended": stopped
 * and kept only until it is deleted); null for anything else, and while it can't be asked. `cloud().verified`: the Admin
 * answered this sign-in just now (connected). `local.marker()`: this computer's freeze marker.
 */
export function createOneHome(deps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; }, clear: (timer) => clearTimeout(timer) };
  const log = deps.log ?? (() => {});
  const t = deps.t ?? nativeText.englishText.t;
  let running = null, again = false, timer = null, closed = false, waitingFor = null, waitingWhat = null, wasReady = null, reportFailedAt = -Infinity, keptFailedAt = -Infinity;
  /** What the last run found holding the move that only a run can find out; `heldOff`, a first move waits for this
   * computer's own copy, said once in the log. */
  let noted = null, heldOff = false;

  const read = () => parseJournal(deps.journal.read());
  const kept = () => { try { return parseKeep(deps.keep?.read()).on; } catch { return false; } };
  const publish = () => { try { deps.onChange?.(view()); } catch {} };
  /** Each stage the journal enters is dated (`phaseAt`), so how long a move has stood still is known after a relaunch too. */
  const write = (journal) => {
    const next = journal && stageOf(read()?.phase) !== stageOf(journal.phase) ? { ...journal, phaseAt: now() } : journal;
    deps.journal.write(next);
    publish();
    return next;
  };
  /** Someone else is signed in than the account this journal's move belongs to. */
  const anotherAccount = (journal) => { const cloud = deps.cloud(); return Boolean(journal && cloud && cloud.account !== journal.cloud.account); };
  const later = (ms) => {
    if (closed) return;
    if (timer) timers.clear(timer);
    timer = timers.set(() => { timer = null; void kick(); }, Math.min(LONGEST_WAIT_MS, Math.max(250, ms)));
  };

  /** What the line on either page says: the phase, its progress, who it waits for, a day of failing, the done line
   * until it is closed, and coming home; `place`, a server of the person's own the move goes to, by its name. Null when
   * there is nothing to say. */
  function view() {
    if (anotherAccount(read())) return null;
    const seen = phaseView(), place = read()?.cloud?.name;
    return seen && typeof place === "string" ? { ...seen, place } : seen;
  }

  function phaseView() {
    const journal = read();
    if (!journal || journal.paused || (journal.told && journal.phase !== "keeping")) return null;
    if (journal.phase === "done") return { phase: "done", ...(Number.isSafeInteger(journal.doneAt) ? { at: journal.doneAt } : {}), ...(journal.counts ? { counts: journal.counts } : {}), phone: journal.phone === true, held: journal.held ?? [],
      ...(journal.left?.length ? { left: journal.left } : {}), ...(journal.stayed?.length ? { stayed: journal.stayed } : {}) };
    if (journal.phase === "keeping") return { phase: "keeping", ...(journal.updating ? { updating: true } : {}) };
    if (journal.phase === "home-again" || journal.phase === "back") {
      return { phase: journal.phase, ...(journal.lost ? { lost: true } : {}), ...(journal.elsewhere ? { elsewhere: journal.elsewhere } : {}), ...(journal.kept ? { kept: true } : {}),
        ...(journal.phase === "back" && journal.gone ? { gone: true } : {}) };
    }
    const sent = deps.send.snapshot?.();
    const running = sent?.running;
    const chats = journal.phase === "copy" && running?.phase === "chats" && running.progress ? { done: running.progress.done, total: running.progress.total } : null;
    if (journal.phase === "copy" && journal.updating && !running) return { phase: "copy", updating: true };
    const failing = journal.failingSince && (journal.failure?.code === "incomplete" || now() - journal.failingSince >= FAILING_LINE_MS)
      ? { error: journal.error ?? null, ...(journal.error && journal.errorKey ? { errorKey: journal.errorKey, errorParams: journal.errorParams ?? {} } : {}) } : null;
    const items = failing ? notCarried(sent, false) : [];
    const phase = FROZEN.has(journal.phase) || journal.phase === "switch" ? "finishing" : journal.phase;
    const waits = phase === "wait" && waitingFor !== null ? { waitingFor, ...(waitingWhat ? { waitingWhat } : {}) } : {};
    return { phase, ...(chats ? { chats } : {}), ...waits, ...(failing ? { failing: { ...failing, ...(items.length ? { items } : {}) } } : {}) };
  }

  /** What the last whole pass could not carry, each with why: all of it while the move is failing, only what My Cloud
   * refused for good (`final`, which the move goes on without) once it is done. */
  function notCarried(sent, onlyFinal) {
    const failed = sent?.whole?.result?.failed;
    return (Array.isArray(failed) ? failed : []).filter((entry) => typeof entry?.label === "string" && (!onlyFinal || entry.final === true))
      .slice(0, NAMED_MAX).map((entry) => ({ label: entry.label, error: sentence(entry.error) ?? t("native.home.itemDidNotMove") }));
  }

  /** Lifts this computer's freeze; true once it is lifted. */
  async function thaw(journal) {
    try { await deps.local.unfreeze(); } catch (error) { noted = "thaw_failed"; log(`one home: could not lift the freeze yet (${error?.message ?? error})`); later(MINUTE); return false; }
    const { thaw: _, ...rest } = journal;
    write(rest);
    return true;
  }

  /** The move fails here: a frozen server is lifted, and it all goes again later from the copy. A frozen pass waits an
   * hour, unless the Admin only said "too many requests" (429), which it lifts within minutes. */
  async function failed(journal, error, frozen) {
    const said = sentence(error?.message) ?? "My Cloud did not answer.";
    log(`one home: ${journal.phase} failed (${said})`);
    const tries = (journal.tries ?? 0) + 1;
    const hourly = frozen && !rateLimited(error);
    const frozenTries = hourly ? (journal.frozenTries ?? 0) + 1 : journal.frozenTries;
    const wait = hourly ? Math.min(FROZEN_RETRY_MAX_MS, FROZEN_RETRY_MS * 2 ** Math.min(frozenTries - 1, 8)) : COPY_RETRY_MS[Math.min(tries - 1, COPY_RETRY_MS.length - 1)];
    // A check's gaps are kept by key, so the next check can tell whether sending again carried any of them.
    const next = write({ ...journal, phase: "copy", passes: 0, tries, frozenTries, error: said, ...errorText(error), failingSince: journal.failingSince ?? now(), failure: failureOf(error, journal.phase, journal.failure, now()),
      gapKey: typeof error?.gapKey === "string" ? error.gapKey : undefined, gaps: typeof error?.gaps === "string" ? error.gaps : undefined,
      retryAt: now() + wait, hourly: hourly || undefined, ...(frozen ? { thaw: true } : {}) });
    if (frozen) await thaw(next);
    return null;
  }

  async function copy(journal) {
    waitingFor = waitingWhat = null;
    try { await deps.send.move(); }
    catch (error) { return error?.code === "outdated" ? updating(journal, error) : failed({ ...journal, updating: undefined }, error, false); }
    return write({ ...journal, phase: "wait", retryAt: undefined, hourly: undefined, updating: undefined });
  }

  /** My Cloud is too old to take a move: it updates by itself, and the move starts once it has, so this is not the move
   * failing and there is nothing to try again. */
  function updating(journal, error) {
    log(`one home: the move waits for My Cloud to update (${sentence(error?.message) ?? "too old"})`);
    const tries = (journal.tries ?? 0) + 1;
    write({ ...journal, phase: "copy", updating: true, tries, retryAt: now() + COPY_RETRY_MS[Math.min(tries - 1, COPY_RETRY_MS.length - 1)] });
    return null;
  }

  async function wait(journal) {
    const quietFor = now() - (deps.lastInput?.() ?? 0);
    if (quietFor < QUIET_MS) { noted = "waiting_quiet"; later(QUIET_MS - quietFor); return null; }
    // The journal says "freeze" before the server is frozen: a crash in between resumes frozen, never forgotten.
    return freeze(write({ ...journal, phase: "freeze" }));
  }

  async function freeze(journal) {
    let answer;
    try { answer = await deps.local.freeze(journal.cloud.origin); }
    catch (error) { return failed(journal, error, true); }
    if (record(answer) && typeof answer.busy === "string") {
      // The server names what holds the move, and lets go of anything that is not a turn answering now within half an
      // hour (server/move-waits.ts), so this poll ends by itself.
      waitingFor = answer.busy;
      waitingWhat = typeof answer.what === "string" ? answer.what : null;
      write({ ...journal, phase: "wait" });
      later(BUSY_POLL_MS);
      return null;
    }
    waitingFor = waitingWhat = null;
    return write({ ...journal, phase: "final", frozenAt: now() });
  }

  async function final(journal) {
    try { await deps.send.move({ final: true }); }
    catch (error) { return failed(journal, error, true); }
    return write({ ...journal, phase: "check", passes: 1 });
  }

  /** What arrived, against what is here. What sending again three times carried none of, which the try before this one
   * also ended without (by the same gaps, or by any for a journal from before gaps were kept), never will go: it stays on
   * this computer, the rest moves, and the done line says what stayed (`stuck`). Anything else fails, and goes again. */
  async function check(journal) {
    let passes = journal.passes ?? 1, first = null, stuck = null;
    try {
      for (let report = await deps.send.check(); report?.ok !== true; report = await deps.send.check()) {
        log(`one home: the check found ${missingOf(report)} missing`);
        const key = gapKey(report);
        first ??= key;
        if (passes >= CHECK_PASSES) {
          const again = journal.failure?.code === "incomplete" && (journal.gapKey === undefined || journal.gapKey === key);
          // Only what can be named stays behind: a check that can't say what it misses fails as before.
          if (key === first && again && (stuck = stayedBehind(report, t)).length) { log(`one home: moving on without what never arrived (${gapSummary(report)})`); break; }
          throw tagged(t("native.cloud.incomplete"), "incomplete", { gapKey: key, gaps: gapSummary(report) });
        }
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
    return write({ ...journal, phase: "switch", passes, checkedAt: now(), ...(counts ? { counts } : {}), ...(stuck?.length ? { stuck } : {}) });
  }

  /** The point of no return: My Cloud switches on what was on here, and keeps which computer its bots came from. What was
   * on here is read here, frozen since the freeze, over what each pass recorded as it carried it: a switch turned since,
   * or once this computer's bots came home and move again, is not on record. */
  async function switchOver(journal) {
    const switches = { ...deps.send.switches(), ...automationsOn(await deps.local.json("/api/cloud-send/manifest").catch(() => null)) };
    const switched = { ...journal.switched };
    let session;
    try {
      session = await deps.session();
      for (const [key, on] of Object.entries(switches)) {
        const change = on && !switched[key] ? switchOn(key) : null;
        if (!change) continue;
        const answer = await session.call(change.method, change.route, change.body);
        // One deleted on My Cloud meanwhile stays deleted; any other refusal is tried again.
        if (!answer.ok && answer.status !== 404) throw tagged(sentence(answer.body?.error) ?? "My Cloud did not switch on an automation.", "switch_refused", { status: answer.status });
        switched[key] = true;
        write({ ...journal, switched });
      }
      const computer = sentence((await deps.local.json("/api/cloud-connections").catch(() => null))?.computer?.label) ?? "this computer";
      const webhooks = Object.keys(switches).flatMap((key) => (key.startsWith("webhook:") ? [key.slice("webhook:".length)] : []));
      const arrived = await session.call("POST", "/api/cloud-send/arrived", { v: 1, computer, webhooks, ...(journal.cloud.name ? { place: journal.cloud.name } : {}) });
      if (!arrived.ok) throw tagged(sentence(arrived.body?.error) ?? "My Cloud did not finish the move.", "switch_refused", { status: arrived.status });
    } catch (error) {
      log(`one home: switching over goes on later (${error?.message ?? error})`);
      const next = write({ ...journal, switched, error: sentence(error?.message) ?? undefined, ...errorText(error), retryAt: now() + 2 * MINUTE, failure: failureOf(error, "switch", journal.failure, now()) });
      later(next.retryAt - now());
      return null;
    } finally { await session?.close().catch(() => {}); }
    const sent = deps.send.snapshot?.();
    const held = (sent?.whole?.result?.notes ?? []).filter((note) => note?.kind === "held" && typeof note.connection === "string").map((note) => note.connection);
    const left = [...notCarried(sent, true), ...(Array.isArray(journal.stuck) ? journal.stuck : [])];
    const stayed = (sent?.whole?.result?.notes ?? []).filter((note) => note?.kind === "stayed" && typeof note.connection === "string").slice(0, NAMED_MAX)
      .map((note) => ({ name: note.connection, ...(typeof note.needs === "string" ? { needs: note.needs } : {}) }));
    const done = write({ ...journal, phase: "done", switched, doneAt: now(), version: deps.version ?? null, phone: deps.phone?.paired() === true, held, ...(left.length ? { left } : {}), ...(stayed.length ? { stayed } : {}),
      error: undefined, errorKey: undefined, errorParams: undefined, failingSince: undefined, retryAt: undefined, tries: undefined, failure: undefined, frozenTries: undefined, gapKey: undefined, gaps: undefined, stuck: undefined });
    await settle(done);
    deps.openHome?.();
    return null;
  }

  /** Once home is My Cloud: the bots' project folders are lent to it with this computer, and the Admin is told it moved,
   * once per sign-in (tried again at most hourly while the Admin can't take it). The phone link stays on: a phone paired
   * here hears from the frozen copy where its bots went, and reaches a workspace of this computer's own while one runs. */
  async function settle(journal, cloud = deps.cloud()) {
    let next = journal;
    if (deps.reportMove && cloud?.signIn && next.reported !== cloud.signIn && now() - reportFailedAt >= HOUR) {
      let told = false;
      try { told = await deps.reportMove(); }
      catch (error) { log(`one home: the Admin is told this computer moved later (${error?.message ?? error})`); }
      if (told) next = write({ ...next, reported: cloud.signIn });
      else reportFailedAt = now();
    }
    if (!next.lent) {
      try {
        const bots = (await deps.local.json("/api/bots?messages=0"))?.bots ?? [];
        await deps.lend?.([...new Set(bots.map((bot) => bot?.cwd).filter((cwd) => typeof cwd === "string" && cwd))]);
        next = write({ ...next, lent: true });
      } catch (error) { log(`one home: this computer is lent later (${error?.message ?? error})`); }
    }
    return next;
  }

  /** Home is My Cloud: tops up what a newer app learned to move, deletes this computer's copy once it is old enough and
   * My Cloud was paid for, and comes home if My Cloud ends. */
  async function steady(journal, cloud, waiting) {
    let next = await settle(journal, cloud);
    if (cloud?.ended) return ended(next, cloud);
    // Not while this computer's own copy isn't the server answering: it goes as soon as it is, rather than an hour later.
    if (!waiting && !next.forgot && deps.version && next.version !== deps.version && cloud?.ready && deps.ownCopy?.() !== false) {
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

  /** My Cloud ended: its things come home here, unless the Admin names another computer as the one they come home to.
   * Named, this computer waits until it knows which it is itself. */
  async function ended(journal, cloud) {
    const home = cloud?.homecoming;
    if (!home) return homeAgain(journal);
    const mine = await deps.installation?.().catch(() => null) ?? null;
    if (!mine) { log("one home: coming home waits until this computer knows which one it is"); later(MINUTE); return null; }
    return home.installationId === mine ? homeAgain(journal) : cameHomeElsewhere(journal, home.name);
  }

  /** Another computer is home now: this one opens its own copy as it was at the move, with every automation off, takes
   * nothing from My Cloud and starts nothing. */
  async function cameHomeElsewhere(journal, name) {
    try { await deps.local.unfreeze({ automations: "off" }); }
    catch (error) { log(`one home: could not open this computer's copy yet (${error?.message ?? error})`); later(MINUTE); return null; }
    const { retryAt: _, ...rest } = journal;
    const since = journal.forgot ? null : journal.frozenAt ?? journal.doneAt ?? null;
    write({ ...rest, phase: "back", endedAt: journal.endedAt ?? now(), told: undefined, elsewhere: { name, ...(since ? { since } : {}) } });
    deps.openLocal?.();
    return null;
  }

  /** The Cloud this computer is frozen for (`from`: the journal, or what the freeze names) is gone and My Cloud is another
   * Cloud or none, by the Admin's word on that Cloud: this computer opens its own copy as it was at the move, with every
   * automation off (the person may have set things up again elsewhere), keeps its bots here so no move starts by itself,
   * and says so once. Nothing is asked of a Cloud that no longer exists. One already home, bringing that Cloud's things
   * back, only stops waiting for them. */
  async function cameHomeGone(from, gone) {
    if (from.phase === "home-again") { write({ ...from, phase: "back", lost: true, retryAt: undefined }); return; }
    try { await deps.local.unfreeze({ automations: "off" }); }
    catch (error) { log(`one home: could not open this computer's copy yet (${error?.message ?? error})`); later(MINUTE); return; }
    try { deps.keep?.write({ v: 1, on: true, at: now() }); } catch {}
    // A way home already under way ends here: what it would have switched on here stays off.
    const { retryAt: _retry, switchBack: _back, webhooks: _hooks, keptFrom: _from, keptAt: _at, offThere: _off, thawed: _thawed, updating: _updating, ...rest } = from;
    log(`one home: the Cloud this computer moved to is ${gone}; its own copy is open again, with every automation off`);
    // A copy already deleted has nothing to say "as they were" about.
    write({ ...rest, v: 1, phase: "back", gone, endedAt: from.endedAt ?? now(), told: from.forgot ? true : undefined });
    deps.openLocal?.();
  }

  /** The Cloud this computer is frozen for, when it is not My Cloud now and the Admin's verified word on it may bring this
   * computer home: the journal's while home is there (or on its way back from it), else the Cloud the freeze names when
   * this app kept no journal of it. Never a server of the person's own (`place`), nor one another account moved to. */
  async function frozenFor(journal, cloud) {
    if (!cloud?.verified || !deps.gone) return null;
    if (journal && (awayIn(journal) || journal.phase === "home-again")) return anotherCloud(cloud, journal.cloud) ? journal : null;
    if (journal && journal.phase !== "back") return null;
    const marker = await deps.local.marker?.().catch(() => null);
    if (!marker?.frozen || marker.place || typeof marker.cloud !== "string" || sameCloud(cloud, { origin: marker.cloud })) return null;
    return { v: 1, cloud: { origin: marker.cloud, account: cloud.account, machine: marker.cloud }, startedAt: now() };
  }

  /** Whether the Cloud this computer is frozen for is gone, so this run only brings it home (cameHomeGone). */
  async function goneHome(journal, cloud) {
    const from = await frozenFor(journal, cloud);
    if (!from) return false;
    const gone = await deps.gone(from.cloud.origin).catch(() => null);
    if (gone !== "deleted" && gone !== "ended") return false;
    await cameHomeGone(from, gone);
    return true;
  }

  /** My Cloud's word as it bears on this journal: what the session says of My Cloud is said of the Cloud this computer
   * moved to only while they are the same Cloud. While My Cloud is another Cloud (or none), the one moved to neither ends
   * nor takes a top-up by that word, and a move not yet switched over stops as it does when My Cloud ends (nothing runs
   * there yet). Only a verified session's word, for the journal's own account. */
  function judged(cloud, journal) {
    if (!cloud?.verified || !journal || journal.phase === "back" || cloud.account !== journal.cloud.account || !anotherCloud(cloud, journal.cloud)) return cloud;
    const { homecoming: _, ...rest } = cloud;
    return awayIn(journal) || journal.phase === "home-again" ? { ...rest, ready: false, ended: false } : { ...rest, ended: true };
  }

  /** The Cloud this journal moved to, by a verified session's word for its own account, answers at a new address now (it
   * moved to another provider), or its id is known now: the journal follows it there and keeps its id, so the move goes
   * on, or stays done, at that address, and the old one is never read as My Cloud having ended. */
  function followed(journal, cloud) {
    if (!journal || journal.phase === "back" || !cloud?.verified || !cloud.origin || cloud.account !== journal.cloud.account || !sameCloud(cloud, journal.cloud)) return journal;
    const id = cloud.id || journal.cloud.id;
    if (cloud.origin === journal.cloud.origin && id === journal.cloud.id) return journal;
    if (cloud.origin !== journal.cloud.origin) log("one home: the Cloud this computer moved to answers at a new address; the move follows it there");
    return write({ ...journal, cloud: { ...journal.cloud, origin: cloud.origin, machine: cloud.machine ?? cloud.origin, ...(id ? { id } : {}) } });
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

  /** After coming home with My Cloud's backup: what was on at My Cloud is switched on here, which a restore leaves off, and
   * each bot that said on My Cloud that its webhook had a new address says it has one here again. */
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
    await deps.local.call("POST", "/api/cloud-send/home", { v: 1, ...(journal.kept ? { webhooks: journal.webhooks ?? [] } : {}) }).catch(() => null);
    const { switchBack: _, webhooks: _webhooks, ...rest } = journal;
    write(rest);
    return null;
  }

  /** Whether this run goes the way the person's choice to keep this computer's bots here says. An ended Cloud's come-home
   * goes on as it does for anyone. */
  function keepsHere(journal, cloud) {
    if (journal?.phase === "home-again" || (cloud?.ended && awayIn(journal))) return false;
    return journal?.phase === "keeping" || kept();
  }

  /** This computer keeps its bots here: nothing moves, a move under way stops before its switch as the Admin's kill switch
   * stops it (nothing runs on My Cloud yet), and bots that moved come home. Turned off again before their automations
   * stopped on My Cloud, home is My Cloud as it was. */
  async function keepHere(journal, cloud) {
    if (!journal) return null;
    if (journal.phase === "back") return tellKept(journal);
    if (journal.phase === "keeping" && !kept() && !underWay(journal)) {
      const { keptFrom, keptAt: _at, switchBack: _back, webhooks: _hooks, updating: _updating, retryAt: _retry, ...rest } = journal;
      write({ ...rest, phase: keptFrom === "switch" ? "switch" : "done" });
      again = true;
      return null;
    }
    if (awayIn(journal)) return comeHome(journal, cloud);
    if ((FROZEN.has(journal.phase) || journal.thaw) && !(await thaw({ ...journal, thaw: true }))) return null;
    deps.journal.write(null);
    publish();
    return null;
  }

  /** This computer's bots come home while My Cloud goes on. My Cloud's backup is staged here first, so nothing has changed
   * anywhere while it is taken; then the automations this computer brought stop there (one request, which a Cloud too
   * old to take answers 404 until it updates), this computer opens with every automation off and restores the backup, and
   * the app opens again, where switchBack switches on here what was on of them at My Cloud. */
  async function comeHome(journal, cloud) {
    let next = journal.phase === "keeping" ? journal
      : write({ ...journal, phase: "keeping", keptFrom: journal.phase, keptAt: now(), retryAt: undefined, error: undefined, failingSince: undefined, tries: undefined, failure: undefined });
    if (!deps.keepHome || !cloud?.ready) return null;
    if (next.retryAt > now()) { later(next.retryAt - now()); return null; }
    const retry = (ms, error, change = {}) => {
      if (error) log(`one home: this computer's bots come home later (${error?.message ?? error})`);
      write({ ...next, ...change, retryAt: now() + ms });
      later(ms);
      return null;
    };
    let staged;
    try { staged = await deps.keepHome.stage(); } catch (error) { return retry(5 * MINUTE, error); }
    if (!("staged" in staged)) return retry("later" in staged ? staged.later : HOUR);
    if (!kept() && !underWay(next)) return null;
    if (!next.switchBack) {
      const switchBack = keptSwitches(deps.send.switches(), staged.switches);
      next = write({ ...next, switchBack, webhooks: Object.keys(switchBack).flatMap((key) => (key.startsWith("webhook:") ? [key.slice("webhook:".length)] : [])) });
    }
    const on = Object.keys(next.switchBack).filter((key) => next.switchBack[key]);
    if (on.length && !next.offThere) {
      let session;
      try {
        session = await deps.session();
        const answer = await session.call("POST", "/api/cloud-send/automations-off", { v: 1, keys: on });
        if (answer.status === 404) return retry(COPY_RETRY_MS.at(-1), null, { updating: true });
        if (!answer.ok) throw Object.assign(new Error(sentence(answer.body?.error) ?? "My Cloud did not stop this computer's automations."), { status: answer.status });
      } catch (error) { return retry(5 * MINUTE, error); }
      finally { await session?.close().catch(() => {}); }
      next = write({ ...next, offThere: true, updating: undefined });
    }
    if (!next.thawed) {
      try { await deps.local.unfreeze({ automations: "off" }); } catch (error) { return retry(MINUTE, error); }
      next = write({ ...next, thawed: true });
    }
    let brought;
    try { brought = await deps.keepHome.bring(); } catch (error) { return retry(5 * MINUTE, error); }
    if (!("restored" in brought)) return retry("later" in brought ? brought.later : HOUR);
    const { keptFrom: _from, keptAt: _at, offThere: _off, thawed: _thawed, updating: _updating, retryAt: _retry, ...rest } = next;
    write({ ...rest, phase: "back", kept: true, told: undefined, restoreId: brought.restored });
    deps.restart?.();
    return null;
  }

  /** Once this computer's bots are home, the Admin is told once that it no longer counts as moved, so an ended Cloud's
   * things never come home to it instead of to a computer that moved (tried again at most hourly while it can't). */
  async function tellKept(journal) {
    if (!journal.kept || !journal.reported || journal.keptTold || !deps.reportKept || now() - keptFailedAt < HOUR) return null;
    let told = false;
    try { told = await deps.reportKept(); }
    catch (error) { log(`one home: the Admin is told this computer keeps its bots later (${error?.message ?? error})`); }
    if (told) write({ ...journal, keptTold: true });
    else keptFailedAt = now();
    return null;
  }

  async function run() {
    noted = null;
    const said = deps.cloud();
    let journal = followed(read(), said);
    const cloud = judged(said, journal);
    // A move left off while My Cloud was away goes on as soon as it is back, unless it failed frozen: that waits its hour.
    const cameBack = cloud?.ready === true && wasReady === false;
    wasReady = cloud ? cloud.ready : null;
    const waiting = () => journal.retryAt > now() && !(cameBack && !journal.hourly);
    if (journal && cloud && cloud.account !== journal.cloud.account) {
      // Another account's Cloud never moves this computer's copy, nor lifts its freeze once the move is done.
      if (FROZEN.has(journal.phase)) await failed(journal, tagged("Another MausBot Cloud account signed in.", "other_account"), true);
      await deps.release?.();
      return;
    }
    if (await goneHome(journal, said)) return;
    if (journal?.phase === "back" && journal.switchBack) {
      await switchBack(journal);
      journal = read();
      if (journal?.switchBack || !journal?.kept) return;
    }
    if (keepsHere(journal, cloud)) return void await keepHere(journal, cloud);
    if (!journal || journal.phase === "back") {
      if (!cloud?.ready || !cloud.moves || cloud.ended || !cloud.origin) return;
      // A frozen server with no move under way is one this app no longer knows about: it is never lifted blindly.
      noted = await deps.local.frozen().then((frozen) => (frozen ? "frozen_without_move" : null), () => "local_unavailable");
      if (noted) { log(`one home: ${noted === "frozen_without_move" ? "this computer is frozen with no move under way" : "this computer's server did not say whether it is frozen"}`); return; }
      // Only from this computer's own copy: while another folder's server runs (the clean workspace, a profile, a named
      // local environment) nothing starts or counts as failing, and it looks again in a minute.
      if (deps.ownCopy?.() === false) { noted = "local_unavailable"; if (!heldOff) log("one home: the move waits until this computer's own copy runs"); heldOff = true; later(MINUTE); return; }
      heldOff = false;
      journal = write({ v: 1, phase: "copy", cloud: { origin: cloud.origin, account: cloud.account, machine: cloud.machine, ...(cloud.id ? { id: cloud.id } : {}), ...(cloud.name ? { name: cloud.name } : {}) },
        startedAt: now() });
    }
    if (journal.thaw && !(await thaw(journal))) return;
    journal = read() ?? journal;
    if (journal.phase === "done") return void await steady(journal, cloud, waiting());
    if (journal.phase === "home-again" || (journal.phase === "switch" || journal.phase === "keeping") && cloud?.ended) {
      if (journal.phase === "home-again" && waiting()) return void later(journal.retryAt - now());
      return void await ended(journal, cloud);
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
        if (FROZEN.has(journal.phase)) await failed(journal, tagged("My Cloud is not ready.", "not_ready"), true);
        return;
      }
      if (journal.paused) journal = write({ ...journal, paused: undefined });
      if (journal.phase === "copy" && waiting()) { later(journal.retryAt - now()); return; }
    }
    for (let step = 0; journal && step < 12 && !closed && !kept(); step++) {
      // Each step reads My Cloud from the sign-in: none of them ever runs for an account that signed in since the last.
      if (anotherAccount(journal)) { if (FROZEN.has(journal.phase)) await failed(journal, tagged(t("native.cloud.otherAccount"), "other_account"), true); break; }
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
      const journal = read();
      if (!journal || journal.paused || !MOVING.has(journal.phase)) await deps.release?.();
    })().finally(() => { running = null; publish(); });
    return running;
  }

  return {
    kick,
    view,
    /** Home is My Cloud: the switch happened, My Cloud has not ended, and this computer's bots are not home yet. */
    away: () => awayIn(read()),
    /** A move or a send under way that restarting this app would cut into. */
    busy: () => Boolean(running) || Boolean(deps.send.snapshot?.()?.running) || CUT_SHORT.has(read()?.phase ?? ""),
    /** The move belonging to the account signed in is under way, past where it can stop by itself: that account can't be
     * left for a moment, or this computer's freeze would have to lift for the other. */
    moving: () => { const journal = read(); return !anotherAccount(journal) && (Boolean(deps.send.snapshot?.()?.running) || CUT_SHORT.has(journal?.phase ?? "")); },
    /** This computer keeps its bots here: the person's own choice. */
    keeps: kept,
    /** Keeps this computer's bots here (`on`), or lets them move with everything else again, at the next quiet moment as
     * anyone's first move; refused once their way home is under way (underWay). */
    keep(on) {
      if (!on && underWay(read())) throw new Error(t("native.cloud.keepUnderWay"));
      deps.keep?.write(on ? { v: 1, on: true, at: now() } : { v: 1, on: false });
      publish();
      return kick();
    },
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
    /** What the last run found holding the move: `noted`, a reason only a run finds out, and `waiting`, what kind of work
     * holds the freeze ("" when the server didn't say), never its name; null when nothing does. */
    facts: () => ({ noted, waiting: waitingFor === null ? null : waitingWhat ?? "" }),
    close() { closed = true; if (timer) timers.clear(timer); },
  };
}
