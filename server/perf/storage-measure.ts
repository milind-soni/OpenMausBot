// What Settings → Storage reads beside the storage report: the volume as it is now (the report's figures are from the end of
// the last pass, up to PASS_EVERY_MS old), and "Measure again", a pass started on the owner's word at most once per
// MEASURE_GAP_MS, counted from the last pass's end or the last start asked for, whichever is later.
import { statfs as nodeStatfs } from "node:fs/promises";

import type { VolumeBytes } from "./disk-usage.ts";

export const MEASURE_GAP_MS = 10 * 60_000;

type Statfs = (path: string) => Promise<{ blocks: number; bsize: number; bavail: number; bfree: number }>;

/** The volume holding `path` now; null when the filesystem can't be read. */
export async function readVolumeNow(path: string, statfs: Statfs = nodeStatfs): Promise<VolumeBytes | null> {
  try {
    const stats = await statfs(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize, usedBytes: (stats.blocks - stats.bfree) * stats.bsize };
  } catch {
    return null;
  }
}

export interface StorageMeasureDeps {
  /** The sampler's own: a pass is due at its next tick. */
  passNow(): void;
  /** Runs that tick now, so a sampler sleeping until its next scheduled pass starts this one. */
  tick(): Promise<void>;
  running(): boolean;
  /** When the last full pass ended; null before the first. */
  lastPassAt(): number | null;
  now?: () => number;
  gapMs?: number;
}

export interface MeasureAnswer { started: boolean; running: boolean; inS: number }

export function createStorageMeasure(deps: StorageMeasureDeps) {
  const now = deps.now ?? Date.now;
  const gapMs = deps.gapMs ?? MEASURE_GAP_MS;
  let askedAt: number | null = null;
  /** Seconds until a pass may be asked for: 0 now, never while one runs (its end restarts the wait). */
  const inS = (): number => {
    if (deps.running()) return Math.ceil(gapMs / 1000);
    const since = Math.max(deps.lastPassAt() ?? -Infinity, askedAt ?? -Infinity);
    return Math.max(0, Math.ceil((since + gapMs - now()) / 1000));
  };
  return {
    inS,
    measure(): MeasureAnswer {
      const wait = inS();
      if (wait > 0) return { started: false, running: deps.running(), inS: wait };
      askedAt = now();
      deps.passNow();
      void deps.tick().catch(() => {});
      return { started: true, running: true, inS: Math.ceil(gapMs / 1000) };
    },
  };
}
export type StorageMeasure = ReturnType<typeof createStorageMeasure>;
