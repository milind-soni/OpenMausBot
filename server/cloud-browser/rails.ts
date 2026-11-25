// The cost and failure rails of a personal Cloud's browser on its bot's cloud computer (server/cloud-browser/index.ts).
// Every start (a resume of a stopped computer) is counted here before it is sent, refused ones included, since the
// provider bills a refused resume as a start. Kept on disk, so a restart neither forgets the day's count nor a hold.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CloudLimit } from "../../shared/place-view.ts";

/** Resumes a Cloud may spend on its bots' browsers in one UTC day; past it, every browser opens in the home. */
export const CLOUD_BROWSER_DAILY_RESUMES = 100;
/** Minutes the Cloud's browser sandbox may be awake in one UTC day; past it, every browser opens in the home. */
export const CLOUD_BROWSER_DAILY_AWAKE_MINUTES = 1_080;
/** Failed starts in a row before the back-off. */
export const CLOUD_BROWSER_FAILURES_IN_ROW = 2;
export const CLOUD_BROWSER_BACKOFF_MS = 15 * 60_000;

/** Why a browser session opened in the home instead: names only, for the log and the health report. */
export type HomeReason =
  | "lever" | "team" | "not-eligible" | "own-key" | "sign-ins" | "no-machine" | "no-policy" | "not-set-up" | "busy" | "lent-connection"
  | "old-relay" | "unavailable" | "budget" | "minutes-used" | "sandbox-full" | "backoff" | "account-limit" | "hours-used" | "at-once" | "no-route" | "start-failed" | "unreachable";

interface Day {
  day: string;
  resumes: number;
  /** Awake time of the sandbox this day, ended spells only (the running one is added when read). */
  awakeMs: number;
  computer: number;
  home: number;
  fallbacks: Partial<Record<HomeReason, number>>;
}

interface State extends Day {
  failuresInRow: number;
  backoffUntil: number;
  /** The provider or the Admin said the account's starts are used up: no Cloud's start is sent before this. */
  accountUntil: number;
  /** This Cloud's cloud computer hours are used up. */
  hoursUntil: number;
  /** Neither way to reach a port on the computer worked today: no start is spent on it again before tomorrow. */
  noRouteDay: string | null;
  /** Since when the sandbox was woken here and not yet let sleep; 0 when asleep. */
  awakeSince: number;
  /** The Cloud's relay does not know the browser sandbox: nothing is started before this. */
  oldRelayUntil: number;
  /** The relay said no browser sandbox may start (the fleet's day spent, switched off): nothing is started before this. */
  unavailableUntil: number;
  /** Per sandbox and bot's profile key (`<box id>:<key>`): when the home's saved sign-ins last carried in, or were last
   * written back, by the home file's time. A replaced sandbox has none, so the home's copy is carried into it. */
  carried: Record<string, number>;
  /** Per bot's profile key: the home copy (by file time) Chrome would not take, not tried again until it changes. */
  carryBad: Record<string, number>;
  /** Since when the operator lever has kept every browser in the home; 0 when it does not. */
  leverSince: number;
}

export const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
const nextUtcMidnight = (at: number): number => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
};

/** When a limit the Admin or the provider named lifts: its own `resetsAt` when it gave one in the future, else the next UTC day. */
function liftsAt(limit: CloudLimit | undefined, now: number): number {
  const said = limit?.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
  return Number.isFinite(said) && said > now ? said : nextUtcMidnight(now);
}

export interface CloudBrowserRailsOptions {
  dataDir: string;
  now?: () => number;
  budget?: number;
  awakeMinutes?: number;
}

export function createCloudBrowserRails(options: CloudBrowserRailsOptions) {
  const now = options.now ?? Date.now;
  const budget = options.budget ?? CLOUD_BROWSER_DAILY_RESUMES;
  const awakeCapMs = (options.awakeMinutes ?? CLOUD_BROWSER_DAILY_AWAKE_MINUTES) * 60_000;
  const file = join(options.dataDir, "cloud-browser", "rails.json");
  const fresh = (day: string): Day => ({ day, resumes: 0, awakeMs: 0, computer: 0, home: 0, fallbacks: {} });
  let state: State = { ...fresh(utcDay(now())), failuresInRow: 0, backoffUntil: 0, accountUntil: 0, hoursUntil: 0, noRouteDay: null, awakeSince: 0, leverSince: 0, oldRelayUntil: 0, unavailableUntil: 0, carried: {}, carryBad: {} };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    state = {
      day: typeof saved.day === "string" ? saved.day : state.day,
      resumes: number(saved.resumes), awakeMs: number(saved.awakeMs), computer: number(saved.computer), home: number(saved.home),
      fallbacks: saved.fallbacks && typeof saved.fallbacks === "object" ? saved.fallbacks : {},
      failuresInRow: number(saved.failuresInRow), backoffUntil: number(saved.backoffUntil),
      accountUntil: number(saved.accountUntil), hoursUntil: number(saved.hoursUntil),
      noRouteDay: typeof saved.noRouteDay === "string" ? saved.noRouteDay : null,
      awakeSince: number(saved.awakeSince), leverSince: number(saved.leverSince),
      oldRelayUntil: number(saved.oldRelayUntil), unavailableUntil: number(saved.unavailableUntil),
      carried: Object.fromEntries(Object.entries(saved.carried && typeof saved.carried === "object" ? saved.carried : {})
        .filter(([key, at]) => /^bx_[a-z0-9]{8}:[a-f0-9]{16}$/.test(key) && typeof at === "number" && Number.isFinite(at))),
      carryBad: Object.fromEntries(Object.entries(saved.carryBad && typeof saved.carryBad === "object" ? saved.carryBad : {})
        .filter(([key, at]) => /^[a-f0-9]{16}$/.test(key) && typeof at === "number" && Number.isFinite(at))),
    };
  } catch {
    // None yet, or unreadable: a fresh day. The holds it may have had end by the next day anyway.
  }

  const today = (): State => {
    const at = now(), day = utcDay(at);
    if (state.day !== day) {
      // A spell that runs over midnight: its part before midnight is yesterday's, and the new day counts from midnight.
      if (state.awakeSince) state.awakeSince = Math.max(state.awakeSince, Date.parse(`${day}T00:00:00.000Z`));
      state = { ...state, ...fresh(day) };
    }
    return state;
  };
  const awakeToday = (current: State) => current.awakeMs + (current.awakeSince ? Math.max(0, now() - current.awakeSince) : 0);
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state));
      renameSync(`${file}.tmp`, file);
    } catch {
      // The rails still hold in memory; only a restart would forget today's count.
    }
  };

  return {
    /** Why no start may be sent for a browser now, or null. `resume`: this open needs one (the computer is stopped). */
    refusal(resume: boolean): HomeReason | null {
      const current = today(), at = now();
      if (at < current.oldRelayUntil) return "old-relay";
      if (at < current.unavailableUntil) return "unavailable";
      if (at < current.accountUntil) return "account-limit";
      if (at < current.hoursUntil) return "hours-used";
      if (at < current.backoffUntil) return "backoff";
      if (current.noRouteDay === current.day) return "no-route";
      if (awakeToday(current) >= awakeCapMs) return "minutes-used";
      if (resume && current.resumes >= budget) return "budget";
      return null;
    },
    /** The sandbox is awake from now (woken or found awake here). */
    awake(): void {
      const current = today();
      if (current.awakeSince) return;
      current.awakeSince = now();
      save();
    },
    /** It was let sleep: its spell ends now. */
    asleep(): void {
      const current = today();
      if (!current.awakeSince) return;
      current.awakeMs += Math.max(0, now() - current.awakeSince);
      current.awakeSince = 0;
      save();
    },
    /** Whether a spell is open, so a restarted server lets the sandbox sleep again. */
    leftAwake: (): boolean => today().awakeSince > 0,
    /** The operator lever's state; true once it has kept browsers in the home for more than a day. */
    lever(on: boolean): boolean {
      const current = today();
      if (!on) {
        if (current.leverSince) { current.leverSince = 0; save(); }
        return false;
      }
      if (!current.leverSince) { current.leverSince = now(); save(); }
      return now() - current.leverSince > 24 * 60 * 60_000;
    },
    /** Before the resume is sent: it counts whatever the answer. */
    resumed(): void {
      today().resumes += 1;
      save();
    },
    opened(): void {
      const current = today();
      current.computer += 1;
      current.failuresInRow = 0;
      save();
    },
    home(reason: HomeReason): void {
      const current = today();
      current.home += 1;
      current.fallbacks[reason] = (current.fallbacks[reason] ?? 0) + 1;
      save();
    },
    /** A start or a launch that failed: two in a row hold every start off for CLOUD_BROWSER_BACKOFF_MS. */
    failed(): void {
      const current = today();
      current.failuresInRow += 1;
      if (current.failuresInRow >= CLOUD_BROWSER_FAILURES_IN_ROW) {
        current.backoffUntil = now() + CLOUD_BROWSER_BACKOFF_MS;
        current.failuresInRow = 0;
      }
      save();
    },
    /** The account's starts are used up (the Admin's `too_many_starts` for the day, or the provider's own 429). */
    accountLimit(limit: CloudLimit | undefined): void {
      today().accountUntil = liftsAt(limit, now());
      save();
    },
    hoursUsed(limit: CloudLimit | undefined): void {
      today().hoursUntil = liftsAt(limit, now());
      save();
    },
    /** A refusal that is not this computer's fault and should not be asked again soon (the plan's computers at once, a
     * minute or hour start limit, usage that cannot be checked): the same back-off as two failures. */
    holdOff(): void {
      const current = today();
      current.backoffUntil = Math.max(current.backoffUntil, now() + CLOUD_BROWSER_BACKOFF_MS);
      save();
    },
    carried: (key: string): number => today().carried[key] ?? 0,
    carryBad: (key: string): number | null => today().carryBad[key] ?? null,
    setCarryBad(key: string, at: number | null): void {
      const current = today();
      if (at === null) delete current.carryBad[key]; else current.carryBad[key] = at;
      save();
    },
    setCarried(key: string, at: number): void {
      today().carried[key] = at;
      save();
    },
    /** An Admin from before the browser sandbox: asked again in a week. */
    oldRelay(): void {
      today().oldRelayUntil = now() + 7 * 24 * 60 * 60_000;
      save();
    },
    /** The relay's no, until its `resetsAt` (the fleet's starts, this Cloud's, or switched off), else for the back-off. */
    unavailable(reason: string, resetsAt: string | null): HomeReason {
      const current = today();
      // A day's budget names its reset; the fleet's sandboxes at once, or usage that can't be read, pass sooner: the back-off.
      current.unavailableUntil = resetsAt ? liftsAt({ reason: "too_many_starts", resetsAt }, now()) : now() + CLOUD_BROWSER_BACKOFF_MS;
      save();
      return reason === "cloud_minutes" ? "minutes-used" : reason === "cloud_starts" ? "budget" : "unavailable";
    },
    noRoute(): void {
      const current = today();
      current.noRouteDay = current.day;
      save();
    },
    /** Today's counts for the health report: numbers and reason names only. */
    report() {
      const current = today(), at = now();
      return {
        day: current.day,
        sessions: { sandbox: current.computer, home: current.home },
        resumes: current.resumes,
        budget,
        awakeMinutes: Math.floor(awakeToday(current) / 60_000),
        awakeMinutesCap: Math.round(awakeCapMs / 60_000),
        fallbacks: { ...current.fallbacks },
        held: at < current.oldRelayUntil ? "old-relay" as const : at < current.unavailableUntil ? "unavailable" as const
          : awakeToday(current) >= awakeCapMs ? "minutes-used" as const : at < current.accountUntil ? "account-limit" as const : at < current.hoursUntil ? "hours-used" as const
          : at < current.backoffUntil ? "backoff" as const : current.noRouteDay === current.day ? "no-route" as const : null,
      };
    },
  };
}
export type CloudBrowserRails = ReturnType<typeof createCloudBrowserRails>;
export type CloudBrowserReport = ReturnType<CloudBrowserRails["report"]>;
