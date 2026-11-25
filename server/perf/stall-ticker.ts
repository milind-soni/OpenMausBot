// When the stall watch's thread (stall-watch.worker.ts) takes a record, from its own once-a-second ticks and the main
// thread's heartbeat, both on the monotonic clock. Pure, so every rule is tested without a thread:
//  - a record once the heartbeat is `thresholdMs` old, again every `repeatMs` while it stays old, `perStall` at most per
//    stall, and `recordsPerHour` at most across stalls;
//  - a profile (the costly part) `profilesPerHour` at most across stalls;
//  - a tick of its own that comes late while the heartbeat was fresh at the tick before means the whole process was
//    paused (a computer asleep, a stopped process), not its main thread stuck: the heartbeat's age counts from there on.
//    A late tick while the main thread was already stuck changes nothing, so a starved machine still records.

const HOUR_MS = 3_600_000;

export interface StallTickerOptions {
  thresholdMs: number;
  repeatMs: number;
  perStall: number;
  recordsPerHour: number;
  profilesPerHour: number;
  /** The tick's own interval, and how late one may come before the process counts as paused. */
  intervalMs?: number;
  lateMs?: number;
}

export function createStallTicker(options: StallTickerOptions) {
  const intervalMs = options.intervalMs ?? 1_000, lateMs = options.lateMs ?? 1_500;
  // `previousBeatAge`: the heartbeat's own age at the tick before, never counted from a resume.
  let lastTick: number | null = null, resumedAt = -Infinity, previousBeatAge = 0, taken = 0, lastTakenAt = -Infinity;
  let records: number[] = [], profiles: number[] = [];
  const ageAt = (now: number, beat: number) => now - Math.max(beat, resumedAt);
  return {
    /** One tick at `now` with the heartbeat last at `beat`: whether to take a record now. */
    tick(now: number, beat: number): boolean {
      const late = lastTick === null ? 0 : now - lastTick - intervalMs;
      lastTick = now;
      const fresh = previousBeatAge < lateMs;
      previousBeatAge = now - beat;
      if (late > lateMs && fresh) { resumedAt = now; return false; }
      const age = ageAt(now, beat);
      if (age < options.thresholdMs) { taken = 0; return false; }
      records = records.filter((at) => now - at < HOUR_MS);
      if (taken >= options.perStall || records.length >= options.recordsPerHour || now - lastTakenAt < options.repeatMs) return false;
      taken += 1;
      lastTakenAt = now;
      records.push(now);
      return true;
    },
    /** How long the main thread has been stuck, as the last tick saw it. */
    age: (now: number, beat: number) => ageAt(now, beat),
    /** Whether a profile may be taken now; counted when it says yes. */
    mayProfile(now: number): boolean {
      profiles = profiles.filter((at) => now - at < HOUR_MS);
      if (profiles.length >= options.profilesPerHour) return false;
      profiles.push(now);
      return true;
    },
  };
}
