// A downloaded update installs by itself at a quiet moment, through the same install the person's Restart starts:
// nothing under way here, nobody typing in the app, and the person away. Only where the updater installs without
// asking anything: macOS (Squirrel.Mac, from the ZIP) and Windows (the per-user NSIS installer, run with /S). The
// window comes back only if it was open, and the first launch on the new version says once that the app updated itself.
import { QUIET_MS } from "./one-home.mjs";
import { isNewerVersion } from "./updater-coordinator.mjs";

/** Nobody has touched this computer's keyboard or mouse for this long: the person is away. */
export const AWAY_MS = 10 * 60_000;
/** The app's window has been closed or hidden this long: the app can restart out of sight. */
export const OUT_OF_SIGHT_MS = 2 * 60_000;
export const LOOK_EVERY_MS = 30_000;
/** Installs of one version that may go wrong by themselves; after that only the person's Restart or quit installs it. */
export const QUIET_TRIES = 3;
/** An install reopens the app within this long; a later launch is the person's own, and opens its window as always. */
export const REOPEN_MS = 5 * 60_000;

/** Why the person counts as away now, or null. */
export function awayNow({ locked, idleMs, outOfSightMs }) {
  if (locked) return "locked";
  if (idleMs >= AWAY_MS) return "away";
  if (outOfSightMs >= OUT_OF_SIGHT_MS && idleMs >= QUIET_MS) return "out of sight";
  return null;
}

const text = (value) => (typeof value === "string" && value ? value : null);

/** The record a quiet install leaves for the launches after it, kept to its known shape. An attempt names the version it
 * left (`from`), the one it installs (`to`), how often that one was tried, and, until the next launch, when it started
 * and whether the window was open. Once the new version runs, only `updated` stays, until the person has seen the line. */
export function parseRecord(value) {
  if (!value || typeof value !== "object" || value.v !== 1) return null;
  const updated = text(value.updated), from = text(value.from), to = text(value.to);
  if (from && to) {
    return { v: 1, from, to, tries: Number.isSafeInteger(value.tries) && value.tries > 0 ? value.tries : 1,
      ...(Number.isSafeInteger(value.at) ? { at: value.at } : {}), ...(typeof value.window === "boolean" ? { window: value.window } : {}) };
  }
  return updated ? { v: 1, updated } : null;
}

/** What this launch learns from the last quiet install: whether it is that install's reopening with the window closed
 * (`hidden`), and the version the app updated itself to while the person has not seen the line (`updated`). */
export function launchAfter(record, { version, now = Date.now }) {
  const was = parseRecord(record.read());
  if (!was) return { hidden: false, updated: null };
  if (!was.to) return { hidden: false, updated: was.updated === version ? version : null };
  const since = now() - (was.at ?? -Infinity);
  const hidden = since >= 0 && since <= REOPEN_MS && was.window === false;
  if (isNewerVersion(version, was.from)) {
    record.write({ v: 1, updated: version });
    return { hidden, updated: version };
  }
  record.write({ v: 1, from: was.from, to: was.to, tries: was.tries });
  return { hidden, updated: null };
}

/**
 * @param {{
 *   updater: { installable(): { version: string } | null, install(): void },
 *   signals: { locked(): boolean, idleMs(): number, typedAt(): number, shown(): boolean, busy(): string | null,
 *     work(): Promise<string | null> },
 *   record: { read(): unknown, write(value: unknown): void },
 *   version: string,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `signals`: the screen locked, how long since anyone touched this computer, when someone last typed in the
 * app, whether its window is open, work under way in the app itself (a move, a lending job, a backup), and work under
 * way on the servers this app talks to (a bot's turn, a routine run, a sign-in, a Live call), each a name or null.
 */
export function createQuietInstall({ updater, signals, record, version, now = Date.now, log = () => {} }) {
  let outOfSightSince = null, looking = null;
  const tries = (target) => {
    const was = parseRecord(record.read());
    return was?.to === target ? was.tries : 0;
  };

  /** What holds the install back now, or null once it may go. */
  function holds(target) {
    if (!target) return "nothing to install";
    if (tries(target.version) >= QUIET_TRIES) return "tried enough";
    try {
      const at = now(), shown = signals.shown();
      if (shown) outOfSightSince = null;
      else outOfSightSince ??= at;
      if (at - signals.typedAt() < QUIET_MS) return "typing";
      if (!awayNow({ locked: signals.locked(), idleMs: signals.idleMs(), outOfSightMs: shown ? 0 : at - outOfSightSince })) return "here";
      return signals.busy() || null;
    } catch {
      return "unknown";
    }
  }

  /** Installs the downloaded update if this is a quiet moment; true once it started. Quiet is checked again after the
   * servers answered, right before installing. */
  function look() {
    looking ??= (async () => {
      const target = updater.installable();
      if (holds(target)) return false;
      let work;
      try { work = await signals.work(); } catch { work = "unknown"; }
      if (work) return false;
      const again = updater.installable();
      if (again?.version !== target.version || holds(again)) return false;
      record.write({ v: 1, from: version, to: target.version, tries: tries(target.version) + 1, at: now(), window: signals.shown() });
      log(`installing ${target.version} by itself at a quiet moment`);
      updater.install();
      return true;
    })().catch((error) => {
      log(`a quiet install did not start (${error?.message ?? error})`);
      return false;
    }).finally(() => { looking = null; });
    return looking;
  }

  return {
    look,
    /** This version still installs by itself at a quiet moment. */
    promises: (target) => typeof target === "string" && tries(target) < QUIET_TRIES,
  };
}

/** The install did not reach a restart: a launch soon after is the person's own. */
export function installFailed(record) {
  const was = parseRecord(record.read());
  if (was?.to && (was.at !== undefined || was.window !== undefined)) record.write({ v: 1, from: was.from, to: was.to, tries: was.tries });
}

/** The person saw that the app updated itself. */
export function updateSeen(record) {
  if (parseRecord(record.read())?.updated) record.write(null);
}
