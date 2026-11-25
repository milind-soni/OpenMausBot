// The root supervisor's half of the home's clock (server/cloud-clock.ts): the one process allowed to set it. It measures by
// itself, from fresh HTTPS answers of independent hosts, and sets the clock only forward, only when two or more agree and say
// it is CLOCK_STEP_MS or more behind. What wakes it: the server's "check" lines (a valid signed request far from this clock,
// or a wake), and a slow look of its own (one host every CLOCK_LOOK_MS, all of them when that one says the clock is off), so
// a home whose server is down still comes right. A line is only a reason to look: anything `maus` writes there can make it
// measure at most once a minute, never choose a time.
//
// Setting it: `date -u -s @<seconds>` (clock_settime), which needs CAP_SYS_TIME. A Fly machine is its own VM and the
// supervisor is its root, so it has it; a Docker container (Hetzner, a team's own server) has not, and those never suspend:
// there it logs once and only measures. No time daemon ships in the image and none is needed for this.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { CLOCK_CHECK_GAP_MS, CLOCK_STEP_MS, clockSources, measureClock, readClock, systemClocks, type ClockClocks } from "./cloud-clock.ts";

/** The supervisor's own look, one host at a time. */
export const CLOCK_LOOK_MS = 10 * 60_000;
const CAP_SYS_TIME = 25;
const DATE = "/bin/date";

/** A capability's bit in /proc/self/status's effective set. */
export function hasEffectiveCapability(status: string, bit: number): boolean {
  const hex = /^CapEff:\s*([0-9a-f]+)$/m.exec(status)?.[1];
  return hex ? ((BigInt(`0x${hex}`) >> BigInt(bit)) & 1n) === 1n : false;
}

/** What this machine offers for time, logged once at start so the first real machine answers it: its clock source, a
 * paravirtual PTP clock, and whether this process may set the clock. */
export function clockFacts(read: (path: string) => string = (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
  exists: (path: string) => boolean = existsSync): { source: string; ptp: boolean; canSet: boolean } {
  return {
    source: read("/sys/devices/system/clocksource/clocksource0/current_clocksource").trim() || "unknown",
    ptp: exists("/dev/ptp0"),
    canSet: hasEffectiveCapability(read("/proc/self/status"), CAP_SYS_TIME),
  };
}

export function setSystemClock(wallMs: number): { ok: boolean; why?: string } {
  const result = spawnSync(DATE, ["-u", "-s", `@${(wallMs / 1000).toFixed(3)}`], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? { ok: true } : { ok: false, why: String(result.stderr ?? "").trim().split("\n")[0] || result.error?.message || `exit ${result.status}` };
}

/** The supervisor's keeper: logs what the machine offers, checks once now, then looks every CLOCK_LOOK_MS. */
export function startClockKeeper(adminOrigin: string, log: (line: string) => void = (line) => console.log(line)) {
  const facts = clockFacts();
  log(`cloud home: clock source ${facts.source}, ${facts.ptp ? "a PTP clock at /dev/ptp0" : "no PTP clock"}, ${facts.canSet ? "may set the clock" : "can't set the clock (no CAP_SYS_TIME)"}`);
  const keeper = createClockKeeper({ origins: clockSources(adminOrigin), canSet: facts.canSet, log });
  keeper.start();
  return keeper;
}

export function createClockKeeper(options: {
  origins: readonly string[]; canSet: boolean; fetch?: typeof fetch; clocks?: ClockClocks;
  set?: (wallMs: number) => { ok: boolean; why?: string }; log: (line: string) => void;
}) {
  const clocks = options.clocks ?? systemClocks, fetcher = options.fetch ?? fetch, set = options.set ?? setSystemClock;
  let checking: Promise<void> | null = null, checkedAt = -Infinity, turn = 0, canSet = options.canSet, toldCannot = false, lastLine = "";
  const log = (line: string) => { if (line !== lastLine) { lastLine = line; options.log(line); } };

  const run = async () => {
    checkedAt = clocks.mono();
    const verdict = await measureClock(options.origins, fetcher, clocks);
    if (verdict.state !== "agreed") { log(`cloud home: clock not checked (${verdict.state === "disagree" ? "the hosts disagree" : "too few hosts answered"}); left as it is`); return; }
    const minutes = Math.round(Math.abs(verdict.offsetMs) / 60_000);
    if (verdict.offsetMs < CLOCK_STEP_MS) {
      log(verdict.offsetMs <= -CLOCK_STEP_MS ? `cloud home: the clock is ${minutes} min ahead; only a clock behind is set, so it is left as it is` : "cloud home: the clock is right");
      return;
    }
    if (!canSet) {
      if (!toldCannot) { toldCannot = true; options.log(`cloud home: the clock is ${minutes} min behind and this machine can't set it (no CAP_SYS_TIME); a restart sets it`); }
      return;
    }
    // This clock now plus the measured error: the true time at the moment it is set.
    const result = set(clocks.wall() + verdict.offsetMs);
    lastLine = "";
    if (result.ok) options.log(`cloud home: the clock was ${minutes} min behind (${verdict.readings.length} hosts agree); set forward`);
    else { canSet = false; options.log(`cloud home: the clock is ${minutes} min behind and could not be set (${result.why}); a restart sets it`); }
  };
  const check = (): Promise<void> => {
    if (checking) return checking;
    if (clocks.mono() - checkedAt < CLOCK_CHECK_GAP_MS) return Promise.resolve();
    checking = run().catch(() => {}).finally(() => { checking = null; });
    return checking;
  };
  /** The slow look: one host, in turn; a clock off by CLOCK_STEP_MS or more there is checked against all of them. */
  const look = async () => {
    const origin = options.origins[turn++ % options.origins.length];
    if (!origin) return;
    const reading = await readClock(origin, fetcher, clocks);
    if (reading && Math.abs(reading.offsetMs) >= CLOCK_STEP_MS) await check();
  };
  return {
    check, look,
    /** "check" lines from the server's pipe; anything else on it is ignored. */
    listen(pipe: Readable) {
      let buffered = "";
      pipe.setEncoding("utf8");
      pipe.on("data", (chunk: string) => {
        buffered = (buffered + chunk).slice(-256);
        if (!buffered.includes("\n")) return;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        if (lines.some((line) => line === "check")) void check();
      });
      pipe.on("error", () => {});
    },
    start(intervalMs = CLOCK_LOOK_MS) {
      void check();
      const timer = setInterval(() => void look().catch(() => {}), intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
