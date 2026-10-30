// Moving one bot from My Cloud into one of its person's teams ("Move to Acme"). The send a one-time move uses
// (cloud-send.mjs, kept to that one bot) carries it; this runs it in phases and keeps where each move is in one journal
// (userData/team-moves.json), so a move goes on after the app quits:
//
//   copy    the bot, its skills, files, chats and routines go while it keeps working on My Cloud
//   freeze  My Cloud holds it: no turns, its automations off (server/bot-moves.ts)
//   final   the same pass again, for what changed since
//   check   what arrived, against what My Cloud has; what is missing goes again, three passes at most
//   switch  the team switches on the routines that were on, then My Cloud keeps the bot as the line that opens it there
//   done    the line says so, until it is closed
//
// Before the switch a failure lets the bot go on on My Cloud as it was, and the move tries again later; from the switch
// on it only goes forward, so a routine never runs in both places.

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, 300) : null);

const MINUTE = 60_000;
export const CHECK_PASSES = 3;
export const RETRY_MS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 60 * MINUTE];
export const BUSY_POLL_MS = 5_000;
const SWITCH_RETRY_MS = 2 * MINUTE;
const PHASES = new Set(["copy", "freeze", "final", "check", "switch", "done"]);
const FROZEN = new Set(["freeze", "final", "check"]);
const ID = /^[\w-]{1,128}$/u;

/** One move as the journal keeps it; null when it is not one. */
function parseMove(value) {
  if (!record(value) || !PHASES.has(value.phase) || !record(value.bot) || !ID.test(value.bot.id ?? "") || typeof value.bot.name !== "string"
    || !record(value.team) || !ID.test(value.team.id ?? "") || typeof value.team.name !== "string") return null;
  return value;
}

export function parseTeamMoves(value) {
  return { v: 1, moves: record(value) && Array.isArray(value.moves) ? value.moves.map(parseMove).filter(Boolean).slice(0, 50) : [] };
}

/** The routines that were on on My Cloud when the move held the bot there: what the team switches on. */
export const routinesOn = (held) => (Array.isArray(held) ? held.filter((key) => typeof key === "string" && /^routine:[\w-]{1,128}$/u.test(key)) : []);

/**
 * @param {{
 *   journal: { read(): unknown, write(value: unknown): void },
 *   open(move: any): {
 *     engine: { move(options?: { final?: boolean }): Promise<any>, check(): Promise<{ ok: boolean }> },
 *     myCloud: { call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }> },
 *     team: { begin(): Promise<{ name: string } | { done: true }>, done(on: string[]): Promise<void> },
 *     prepare?(): Promise<Record<string, unknown>>,
 *     close(): Promise<void>,
 *   },
 *   inTeam(teamId: string): boolean,
 *   onChange?(view: unknown): void,
 *   now?(): number,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void },
 *   log?(line: string): void,
 * }} deps `open`: one move's sessions for one run, opened when first used: its send, My Cloud's owner session and the
 * team's move-in sign-in; `prepare` reads the bot on My Cloud before it goes (a `final` error stops the move).
 * `inTeam`: the person is still in this team, by the Admin's last word.
 */
export function createTeamMove(deps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; }, clear: (timer) => clearTimeout(timer) };
  const log = deps.log ?? (() => {});
  let running = null, again = false, timer = null, closed = false;

  const read = () => parseTeamMoves(deps.journal.read());
  const view = () => {
    const shown = read().moves.filter((move) => !move.told).at(-1);
    if (!shown) return null;
    const phase = shown.phase === "done" ? "done" : shown.failing ? "failed" : "moving";
    return { bot: { id: shown.bot.id, name: shown.name ?? shown.bot.name }, team: { id: shown.team.id, name: shown.team.name }, phase };
  };
  const publish = () => { try { deps.onChange?.(view()); } catch {} };
  /** The move of this bot, changed as `change` says; the journal is written before anything acts on it. */
  const update = (botId, change) => {
    const journal = read();
    const at = journal.moves.findIndex((move) => move.bot.id === botId);
    if (at < 0) return null;
    const next = change === null ? null : { ...journal.moves[at], ...change };
    if (next) journal.moves[at] = next; else journal.moves.splice(at, 1);
    deps.journal.write(journal);
    publish();
    return next;
  };
  const later = (ms) => {
    if (closed) return;
    if (timer) timers.clear(timer);
    timer = timers.set(() => { timer = null; void kick(); }, Math.max(250, Math.min(6 * 60 * MINUTE, ms)));
  };

  /** Lets the bot go on on My Cloud as it was; true once it does. */
  async function thaw(io, move) {
    const answer = await io.myCloud.call("DELETE", `/api/bot-moves/${move.bot.id}`).catch((error) => ({ ok: false, status: 0, body: { error: error?.message } }));
    if (!answer.ok) { log(`team move: ${move.bot.name} is let go of later (${answer.body?.error ?? answer.status})`); return false; }
    return true;
  }

  /** The move fails before the switch: My Cloud's bot goes on, and the move tries again later from the copy. */
  async function failed(io, move, error, frozen) {
    const said = sentence(error?.message) ?? "The team did not answer.";
    log(`team move: ${move.bot.name} to ${move.team.name}: ${move.phase} failed (${said})`);
    const tries = (move.tries ?? 0) + 1;
    const released = frozen ? await thaw(io, move) : true;
    return update(move.bot.id, { phase: "copy", passes: 0, tries, error: said, failing: true, retryAt: now() + RETRY_MS[Math.min(tries - 1, RETRY_MS.length - 1)],
      ...(released ? { thaw: undefined } : { thaw: true }) });
  }

  async function copy(io, move) {
    let begun;
    try {
      if (io.prepare) move = update(move.bot.id, await io.prepare());
      begun = await io.team.begin();
    } catch (error) {
      // The bot is gone from My Cloud, or is one that stays there: the move stops, nothing changed.
      if (error?.final) return update(move.bot.id, { failing: true, stopped: true, error: sentence(error.message) ?? undefined, retryAt: undefined });
      return failed(io, move, error, false);
    }
    // The team took it already: a run cut short after the switch goes on from there.
    if (begun.done) return update(move.bot.id, { phase: "switch", teamDone: true, name: begun.name ?? move.name });
    move = update(move.bot.id, { name: begun.name });
    try { await io.engine.move(); }
    catch (error) { return failed(io, move, error, false); }
    return update(move.bot.id, { phase: "freeze" });
  }

  async function freeze(io, move) {
    let answer;
    try { answer = await io.myCloud.call("POST", `/api/bot-moves/${move.bot.id}`, { v: 1, state: "moving", team: { id: move.team.id, name: move.team.name } }); }
    catch (error) { return failed(io, move, error, true); }
    if (answer.status === 409 && typeof answer.body?.busy === "string") { later(BUSY_POLL_MS); return null; }
    if (!answer.ok || !record(answer.body?.movedTo)) return failed(io, move, new Error(sentence(answer.body?.error) ?? "My Cloud could not hold the bot."), true);
    return update(move.bot.id, { phase: "final", held: Array.isArray(answer.body.movedTo.held) ? answer.body.movedTo.held : [], frozenAt: now() });
  }

  async function final(io, move) {
    try { await io.engine.move({ final: true }); }
    catch (error) { return failed(io, move, error, true); }
    return update(move.bot.id, { phase: "check", passes: 1 });
  }

  async function check(io, move) {
    let passes = move.passes ?? 1;
    try {
      for (let report = await io.engine.check(); report?.ok !== true; report = await io.engine.check()) {
        if (passes >= CHECK_PASSES) throw new Error(`Some of ${move.bot.name} did not reach ${move.team.name}.`);
        await io.engine.move({ final: true });
        passes += 1;
        update(move.bot.id, { passes });
      }
    } catch (error) { return failed(io, { ...move, passes }, error, true); }
    return update(move.bot.id, { phase: "switch", passes, checkedAt: now() });
  }

  /** The point of no return: the team switches on what was on, then My Cloud keeps the bot as its line. */
  async function switchOver(io, move) {
    try {
      if (!move.teamDone) {
        await io.team.done(routinesOn(move.held));
        move = update(move.bot.id, { teamDone: true });
      }
      const kept = await io.myCloud.call("POST", `/api/bot-moves/${move.bot.id}`, { v: 1, state: "moved", team: { id: move.team.id, name: move.team.name } });
      if (!kept.ok) throw Object.assign(new Error(sentence(kept.body?.error) ?? "My Cloud did not keep the bot's line."), { status: kept.status });
    } catch (error) {
      log(`team move: switching ${move.bot.name} over goes on later (${error?.message ?? error})`);
      update(move.bot.id, { error: sentence(error?.message) ?? undefined, retryAt: now() + SWITCH_RETRY_MS });
      later(SWITCH_RETRY_MS);
      return null;
    }
    return update(move.bot.id, { phase: "done", doneAt: now(), error: undefined, failing: undefined, retryAt: undefined, tries: undefined, told: undefined });
  }

  async function runOne(move) {
    const io = deps.open(move);
    try {
      if (move.thaw) {
        if (!(await thaw(io, move))) { later(MINUTE); return; }
        move = update(move.bot.id, { thaw: undefined });
      }
      for (let step = 0; move && move.phase !== "done" && step < 12 && !closed; step++) {
        if (move.phase === "copy") move = await copy(io, move);
        else if (move.phase === "freeze") move = await freeze(io, move);
        else if (move.phase === "final") move = await final(io, move);
        else if (move.phase === "check") move = await check(io, move);
        else if (move.phase === "switch") move = await switchOver(io, move);
        if (move?.retryAt > now()) break;
      }
    } finally { await io.close().catch(() => {}); }
  }

  async function run() {
    for (const move of read().moves) {
      if (closed || move.phase === "done") continue;
      // Someone no longer in the team moves nothing into it; a bot held for the move goes on on My Cloud.
      if (move.phase !== "switch" && !deps.inTeam(move.team.id)) {
        if (FROZEN.has(move.phase) || move.thaw) {
          const io = deps.open(move);
          try { if (!(await thaw(io, move))) { later(MINUTE); continue; } } finally { await io.close().catch(() => {}); }
        }
        update(move.bot.id, { phase: "copy", failing: true, stopped: true, error: `You're no longer in ${move.team.name}.`, thaw: undefined, retryAt: undefined });
        continue;
      }
      if (move.stopped) continue;
      if (move.retryAt > now()) { later(move.retryAt - now()); continue; }
      await runOne(move);
      const after = read().moves.find((entry) => entry.bot.id === move.bot.id);
      if (after?.retryAt > now()) later(after.retryAt - now());
    }
  }

  /** Goes on from where the journal is: at launch, on account changes, when a wait is over. One run at a time. */
  async function kick() {
    if (closed) return;
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try { await run(); } catch (error) { log(`team move: ${error?.message ?? error}`); later(MINUTE); }
      } while (again && !closed);
    })().finally(() => { running = null; publish(); });
    return running;
  }

  return {
    kick,
    view,
    /** Starts moving a bot into a team; a bot already moving there goes on. */
    start({ bot, team }) {
      const journal = read();
      const held = journal.moves.find((move) => move.bot.id === bot.id);
      if (held && held.phase !== "done" && !held.stopped) {
        if (held.team.id !== team.id) throw new Error(`${held.bot.name} is moving to ${held.team.name}.`);
        return kick();
      }
      const moves = journal.moves.filter((move) => move.bot.id !== bot.id).map((move) => (move.phase === "done" ? { ...move, told: true } : move));
      deps.journal.write({ v: 1, moves: [...moves, { bot, team, phase: "copy", startedAt: now() }] });
      publish();
      return kick();
    },
    /** Try again: now, not at the next try. */
    retry() {
      const journal = read();
      for (const move of journal.moves) if (move.phase !== "done" && (move.retryAt || move.stopped)) { delete move.retryAt; delete move.stopped; }
      deps.journal.write(journal);
      publish();
      return kick();
    },
    /** The line was closed: a move that failed goes on trying by itself, and says so again once it is done. */
    seen() {
      const journal = read();
      for (const move of journal.moves) if (move.phase === "done" || move.failing) move.told = true;
      deps.journal.write(journal);
      publish();
      return view();
    },
    /** The bot this move carries, or null: a moving bot's menu offers no second move. */
    moving: (botId) => read().moves.find((move) => move.bot.id === botId && move.phase !== "done") ?? null,
    close() { closed = true; if (timer) timers.clear(timer); },
  };
}
