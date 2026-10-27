// Where this computer's one-time move to My Cloud stands (one-home.mjs), as the Admin keeps it per sign-in: POST
// /api/cloud/desktop/move-status, sent when it changes and every 15 minutes otherwise, so an operator can see why a move
// hasn't finished, or never started. Ids and codes only: never a name, a path or anything the person wrote.
import { teamPlan } from "./cloud-team-plan.mjs";
import { FAILURE_CODES, FAILURE_PHASES, safeSentence } from "./move-failure.mjs";
import { awayIn } from "./one-home.mjs";

export const MOVE_STATUS_VERSION = 1;
/** `none`: no move has started on this computer; the rest are the journal's phases (one-home.mjs). */
export const MOVE_PHASES = Object.freeze(["none", "copy", "wait", "freeze", "final", "check", "switch", "done", "keeping", "home-again", "back"]);
/** What holds the move now, as `reason`; null while it goes on. */
export const MOVE_REASONS = Object.freeze([
  "signed_out", "not_verified", "no_cloud", "team_only", "cloud_not_ready", "cloud_ended", "moves_off", "keep_here", "other_account",
  "frozen_without_move", "local_unavailable", "already_moved", "cloud_outdated", "thaw_failed", "retry_wait", "waiting_quiet", "waiting_busy",
]);
export const MOVE_BUSY = Object.freeze(["bot", "room", "sign-in", "other"]);
export const MOVE_STATUS_HEARTBEAT_MS = 15 * 60_000;
/** A burst of changes (a pass's phases follow each other within seconds) goes as one report. */
export const MOVE_STATUS_SETTLE_MS = 5_000;
/** At most one report a minute, whatever changes. */
export const MOVE_STATUS_GAP_MS = 60_000;
/** An Admin that doesn't take reports yet (404) is asked again after this long. */
export const MOVE_STATUS_OFF_MS = 6 * 3_600_000;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const moment = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const STARTS = new Set(["none", "back"]);
const WAITS = new Set(["wait", "freeze"]);

/** Why no move starts on this computer, in the order one-home.mjs's run asks; null once one would start. */
function startHold(state, cloud, noted) {
  if (state.status !== "connected") return "not_verified";
  if (!state.machine) return teamPlan(state) || (Array.isArray(state.teams) && state.teams.length) ? "team_only" : "no_cloud";
  if (cloud.ended) return "cloud_ended";
  if (!cloud.moves) return "moves_off";
  if (!cloud.ready) return "cloud_not_ready";
  return noted === "frozen_without_move" || noted === "local_unavailable" ? noted : null;
}

/** What holds the move, given the journal (`phase`, "none" without one), the session and the last run's facts. */
function reasonOf({ journal, phase, state, cloud, kept, facts, now }) {
  if (!cloud) return "signed_out";
  if (journal && cloud.account !== journal.cloud.account) return "other_account";
  const comingHome = phase === "home-again" || (cloud.ended && awayIn(journal));
  if (!comingHome && (phase === "keeping" || kept)) return "keep_here";
  if (phase === "done") return cloud.ended ? "cloud_ended" : "already_moved";
  if (comingHome || phase === "keeping") return "cloud_ended";
  if (STARTS.has(phase)) return startHold(state, cloud, facts.noted);
  if (phase !== "switch") {
    if (state.status !== "connected") return "not_verified";
    if (cloud.ended) return "cloud_ended";
    if (!cloud.moves) return "moves_off";
    if (!cloud.ready) return "cloud_not_ready";
    if (journal.updating) return "cloud_outdated";
  }
  if (facts.noted === "thaw_failed") return "thaw_failed";
  if (moment(journal.retryAt) && journal.retryAt > now) return "retry_wait";
  if (WAITS.has(phase)) {
    if (facts.noted === "waiting_quiet") return "waiting_quiet";
    if (facts.waiting !== null && facts.waiting !== undefined) return "waiting_busy";
  }
  return null;
}

/** The journal's last failure, its sentence made safe to send; a journal from before failures had codes reads as `error`. */
function failureIn(journal) {
  const failure = record(journal?.failure) ? journal.failure : null;
  const message = safeSentence(journal?.error);
  if (!failure && !message) return null;
  const count = Number.isSafeInteger(failure?.count) && failure.count > 0 ? failure.count : Number.isSafeInteger(journal?.tries) && journal.tries > 0 ? journal.tries : 1;
  return {
    phase: FAILURE_PHASES.includes(failure?.phase) ? failure.phase : null,
    code: FAILURE_CODES.includes(failure?.code) ? failure.code : "error",
    message,
    count,
    since: moment(failure?.since) ?? moment(journal?.failingSince),
    at: moment(failure?.at),
  };
}

/**
 * The report for POST /api/cloud/desktop/move-status (move-status.d.mts MoveStatusReport): `journal` as one-home.mjs keeps
 * it (null without one), `state` the MausBot Cloud sign-in's state (cloud-account.mjs), `kept` the person's choice to keep
 * this computer's bots here, `facts` what one-home's last run found (createOneHome's `facts`).
 */
export function moveStatus({ journal, state, kept, facts = { noted: null, waiting: null }, now, version }) {
  const account = typeof state?.account?.id === "string" && state.account.id ? state.account.id : null;
  const connected = state?.status === "connected", machine = connected ? state.machine ?? null : null;
  const cloud = account ? {
    account,
    ready: connected && machine?.status === "ready" && Boolean(machine.origin),
    moves: connected && machine?.moves === true,
    ended: connected && Boolean(machine?.hold),
  } : null;
  const phase = MOVE_PHASES.includes(journal?.phase) ? journal.phase : "none";
  const reason = reasonOf({ journal, phase, state: state ?? {}, cloud, kept: kept === true, facts, now });
  const busy = reason === "waiting_busy" ? (MOVE_BUSY.includes(facts.waiting) ? facts.waiting : "other") : null;
  return {
    v: MOVE_STATUS_VERSION,
    appVersion: typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/u.test(version) ? version : "unknown",
    phase,
    reason,
    keepHere: kept === true,
    since: phase === "none" ? null : moment(journal.phaseAt) ?? moment(journal.startedAt),
    startedAt: phase === "none" ? null : moment(journal.startedAt),
    passes: Number.isSafeInteger(journal?.passes) && journal.passes >= 0 && journal.passes <= 10 ? journal.passes : null,
    retryAt: moment(journal?.retryAt),
    busy,
    cloudState: typeof machine?.status === "string" ? machine.status : null,
    failure: phase === "none" ? null : failureIn(journal),
  };
}

/**
 * Sends `status()` to the Admin with `send` (true once recorded, false when the Admin doesn't take reports yet) for the
 * sign-in `signIn()` names: a moment after it changes, at most once a minute, and every 15 minutes while it doesn't.
 * Fire and forget: a report that fails is only logged, and nothing about the move waits for it or changes with it.
 */
export function createMoveStatusReport({ status, send, signIn, now = Date.now, log = () => {},
  timers = { set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; }, clear: (timer) => clearTimeout(timer) } }) {
  let timer = null, dueAt = Infinity, sent = null, triedAt = -Infinity, offUntil = -Infinity, busy = false, again = false, closed = false;
  const plan = (ms) => {
    if (closed) return;
    if (timer) timers.clear(timer);
    const delay = Math.max(MOVE_STATUS_SETTLE_MS, ms);
    dueAt = now() + delay;
    timer = timers.set(() => { timer = null; dueAt = Infinity; void flush(); }, delay);
  };
  async function flush() {
    if (closed) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      let body = null, who = null;
      try { who = signIn(); body = who ? status() : null; } catch (error) { log(`one home: the move's status could not be read (${error?.message ?? error})`); }
      if (!body) return plan(MOVE_STATUS_HEARTBEAT_MS);
      const at = now(), key = JSON.stringify(body), same = sent?.key === key && sent.who === who;
      const wait = Math.max(same ? sent.at + MOVE_STATUS_HEARTBEAT_MS - at : 0, triedAt + MOVE_STATUS_GAP_MS - at, offUntil - at);
      if (wait > 0) return plan(wait);
      triedAt = at;
      try {
        if (await send(body)) sent = { key, who, at };
        else offUntil = at + MOVE_STATUS_OFF_MS;
      } catch (error) { log(`one home: the Admin hears where the move stands later (${error?.message ?? error})`); }
      plan(MOVE_STATUS_HEARTBEAT_MS);
    } finally {
      busy = false;
      if (again) { again = false; changed(); }
    }
  }
  /** Something the report reads may have changed: it is read again in a moment. */
  function changed() {
    if (closed || dueAt <= now() + MOVE_STATUS_SETTLE_MS) return;
    plan(MOVE_STATUS_SETTLE_MS);
  }
  return { changed, flush, close() { closed = true; if (timer) timers.clear(timer); timer = null; } };
}
