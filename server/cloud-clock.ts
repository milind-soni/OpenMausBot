// A Cloud home's clock against the outside world (docs/cloud-pro.md, "The home's clock"). A provider that suspends a home
// and resumes it usually sets its clock on resume, and once in a while does not: the home then runs hours behind (Nov 2026:
// 6 h for 8+ h after a 6-hour suspend), the Admin's signed reads are refused as `stale_request` so it calls the Cloud down,
// and routines run hours late. Its wall clock and its monotonic clock both stopped while it was suspended, so it can't tell
// by itself; only the outside world can.
//
// The outside world here is the `Date` header of HTTPS answers from independent hosts (the Admin, the account service, a
// phone relay), read fresh each time. A signed request from the Admin whose timestamp is far from this clock is a reason to
// look, never a source: the amount always comes from two or more of those answers agreeing within CLOCK_AGREE_MS. So an
// old signed request replayed, one host with a wrong clock, or a proxy's cached answer moves nothing.
//
// Two processes use this module. The server (createCloudClock) measures when something looks off, reports the error in its
// health answer, judges the Admin's signed requests by the measured time while its clock is measured off, and asks the root
// supervisor to check (a payload-free "check" line on an inherited pipe, CLOCK_FD_ENV). The supervisor
// (server/cloud-clock-keeper.ts) measures again by itself and only then sets the system clock: nothing `maus` sends it is
// ever a time.
import { write } from "node:fs";
import { performance } from "node:perf_hooks";

/** Hosts this home reaches anyway and that keep their own clocks, besides its Admin: the account service and a phone relay. */
export const CLOCK_HOSTS = ["https://accounts.openmausbot.com", "https://relay1.openmausbot.com"] as const;
/** Errors smaller than this are left alone. Above cloud-power.ts's resume jump (20 s), so the server sees a step as a resume. */
export const CLOCK_STEP_MS = 30_000;
/** Answers must agree within this (each `Date` is whole seconds, and half the round trip is a guess). */
export const CLOCK_AGREE_MS = 3_000;
/** An answer slower than this says too little about when it was written. */
export const CLOCK_MAX_TRIP_MS = 4_000;
const CLOCK_TIMEOUT_MS = 5_000;
/** Measurements at most this often (each is one HEAD request per host). */
export const CLOCK_CHECK_GAP_MS = 60_000;
/** A measurement is trusted this long on the monotonic clock, and never across a wake (the monotonic clock stops too). */
export const CLOCK_TRUST_MS = 10 * 60_000;
/** The supervisor's inherited pipe for "check" lines; only a Cloud home's supervisor sets it. */
export const CLOCK_FD_ENV = "OMB_CLOUD_CLOCK_FD";

export interface ClockClocks { wall(): number; mono(): number }
export const systemClocks: ClockClocks = { wall: () => Date.now(), mono: () => performance.now() };

/** One host's answer: how far its clock is ahead of this one (positive: this one is behind). */
export interface ClockReading { origin: string; offsetMs: number; tripMs: number }
export type ClockVerdict = { state: "agreed"; offsetMs: number; readings: ClockReading[] } | { state: "too-few" | "disagree"; readings: ClockReading[] };

/** The hosts to ask: this home's Admin first, then CLOCK_HOSTS, each host once. */
export function clockSources(adminOrigin: string, extra: readonly string[] = CLOCK_HOSTS): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const origin of [adminOrigin, ...extra]) {
    let host: string;
    try { host = new URL(origin).host; } catch { continue; }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(new URL(origin).origin);
  }
  return out;
}

/** One HEAD request: null when it fails, is slow, has no usable `Date`, or came from a cache (`Age`). */
export async function readClock(origin: string, fetcher: typeof fetch, clocks: ClockClocks = systemClocks): Promise<ClockReading | null> {
  const sent = clocks.wall(), started = clocks.mono();
  let response: Response;
  try {
    response = await fetcher(`${origin}/`, { method: "HEAD", redirect: "manual", cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(CLOCK_TIMEOUT_MS) });
  } catch { return null; }
  const tripMs = clocks.mono() - started;
  void response.body?.cancel().catch(() => {});
  const age = response.headers.get("age");
  if (age !== null && age.trim() !== "0") return null;
  const date = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(date) || tripMs < 0 || tripMs > CLOCK_MAX_TRIP_MS) return null;
  // `Date` is the second it was written, rounded down: its middle, against this clock half way through the trip.
  return { origin, offsetMs: Math.round(date + 500 - (sent + tripMs / 2)), tripMs };
}

/** Pure: two or more answers, all within CLOCK_AGREE_MS of each other, give the offset (their middle); anything else nothing. */
export function agree(readings: readonly ClockReading[]): ClockVerdict {
  const list = [...readings];
  if (list.length < 2) return { state: "too-few", readings: list };
  const offsets = list.map((reading) => reading.offsetMs).sort((a, b) => a - b);
  if (offsets[offsets.length - 1]! - offsets[0]! > CLOCK_AGREE_MS) return { state: "disagree", readings: list };
  return { state: "agreed", offsetMs: Math.round((offsets[0]! + offsets[offsets.length - 1]!) / 2), readings: list };
}

export async function measureClock(origins: readonly string[], fetcher: typeof fetch = fetch, clocks: ClockClocks = systemClocks): Promise<ClockVerdict> {
  const readings = await Promise.all(origins.map((origin) => readClock(origin, fetcher, clocks)));
  return agree(readings.filter((reading): reading is ClockReading => reading !== null));
}

/** What the health answer says about this clock (`clock`): its error when last measured and still trusted (positive: behind),
 * and when that was, in true time. Both null when nothing measured it lately. */
export interface CloudClockReport { v: 1; errorMs: number | null; measuredAt: number | null }

export interface CloudClockGate {
  /** A request with a valid signature carried this timestamp (seconds) far from this clock: measure. */
  noteSigned(timestampS: number): void;
  /** Whether a timestamp fits the measured true time (within the usual window), while this clock is measured CLOCK_STEP_MS or
   * more off; null while it is not (or nothing measured it lately), and the plain clock decides. */
  fits(timestampS: number): boolean | null;
}

/** The pipe to the supervisor (CLOCK_FD_ENV), taken out of the environment; null on any server it did not start. A write
 * never blocks the server (one at a time, asynchronous), and a failed one is dropped. */
export function clockKicker(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const named = env[CLOCK_FD_ENV];
  if (named === undefined) return null;
  delete env[CLOCK_FD_ENV];
  const fd = Number(named);
  if (!Number.isInteger(fd) || fd < 3 || fd > 1024) return null;
  let pending = false, broken = false;
  return () => {
    if (pending || broken) return;
    pending = true;
    write(fd, "check\n", (error) => { pending = false; if (error) broken = true; });
  };
}

/**
 * The server's side. `check` measures (at most once per CLOCK_CHECK_GAP_MS, except right after a wake); an error of
 * CLOCK_STEP_MS or more behind asks the supervisor (`kick`) to set the clock. Ahead is reported and left alone: a suspend
 * only ever leaves a clock behind, and no measurement can move it backwards.
 */
export function createCloudClock(options: { origins: readonly string[]; fetch?: typeof fetch; clocks?: ClockClocks; kick?: (() => void) | null; log?: (line: string) => void; skewS: number }) {
  const clocks = options.clocks ?? systemClocks, fetcher = options.fetch ?? fetch;
  let trusted: { offsetMs: number; wall: number; mono: number } | null = null;
  let checking: Promise<void> | null = null, checkedAt = -Infinity, logged = "";
  const note = (line: string) => { if (line !== logged) { logged = line; options.log?.(line); } };

  /** The error now: the measured one, less whatever the wall clock moved beyond the monotonic clock since (a step corrects it). */
  const errorNow = (): number | null => {
    if (!trusted) return null;
    const monoSince = clocks.mono() - trusted.mono;
    if (monoSince < 0 || monoSince > CLOCK_TRUST_MS) return null;
    return Math.round(trusted.offsetMs - ((clocks.wall() - trusted.wall) - monoSince));
  };
  const run = async () => {
    checkedAt = clocks.mono();
    const verdict = await measureClock(options.origins, fetcher, clocks);
    if (verdict.state !== "agreed") {
      note(`cloud clock: not measured (${verdict.state === "disagree" ? "the hosts disagree" : "too few hosts answered"}); left as it is`);
      return;
    }
    trusted = { offsetMs: verdict.offsetMs, wall: clocks.wall(), mono: clocks.mono() };
    const minutes = Math.round(Math.abs(verdict.offsetMs) / 60_000);
    if (verdict.offsetMs >= CLOCK_STEP_MS) {
      note(`cloud clock: ${minutes} min behind (${verdict.readings.length} hosts agree); asking the supervisor to set it`);
      options.kick?.();
    } else if (verdict.offsetMs <= -CLOCK_STEP_MS) note(`cloud clock: ${minutes} min ahead (${verdict.readings.length} hosts agree); left as it is`);
    else note("cloud clock: right");
  };
  const check = (force = false): Promise<void> => {
    if (checking) return checking;
    if (!force && clocks.mono() - checkedAt < CLOCK_CHECK_GAP_MS) return Promise.resolve();
    checking = run().catch(() => {}).finally(() => { checking = null; });
    return checking;
  };

  return {
    check,
    /** It woke (a resume, a boot from sleep, or the clock stepped): the monotonic clock stopped meanwhile, so the last
     * measurement no longer holds; measure again now. */
    woke() { trusted = null; void check(true); },
    noteSigned(timestampS: number) {
      if (Math.abs(timestampS * 1000 - clocks.wall()) >= CLOCK_STEP_MS) void check();
    },
    fits(timestampS: number): boolean | null {
      const error = errorNow();
      if (error === null || Math.abs(error) < CLOCK_STEP_MS) return null;
      return Math.abs(timestampS * 1000 - (clocks.wall() + error)) <= options.skewS * 1000;
    },
    report(): CloudClockReport {
      const error = errorNow();
      return { v: 1, errorMs: error, measuredAt: error === null || !trusted ? null : trusted.wall + trusted.offsetMs };
    },
  };
}
export type CloudClock = ReturnType<typeof createCloudClock>;

/** The running home's clock watch, for cloud-power.ts's wake path; null on any server that is not a Cloud home. */
let registered: Pick<CloudClock, "woke"> | null = null;
export function registerCloudClock(clock: Pick<CloudClock, "woke"> | null) { registered = clock; }
export function cloudClockWoke() { registered?.woke(); }
