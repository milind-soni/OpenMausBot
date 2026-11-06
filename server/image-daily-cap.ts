// The most images bots make on this installation in one day, so a bot left looping cannot run up the image key's bill.
// Counted on disk, so a restart never resets it; the day is local (a Cloud runs in its owner's zone: server/time-zone.ts)
// and starts again at midnight. Avatars a person makes in Settings are not counted: they are a person's own clicks.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const IMAGE_DAILY_CAP = 50;
export const IMAGE_DAY_FILE = "image-generation-day.json";

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export interface ImageDailyCap {
  readonly cap: number;
  /** Holds one of today's images while it is made; false once today's are all made or held. */
  reserve(): boolean;
  /** Ends a hold: an image the provider made counts, one it did not make frees its place. */
  settle(made: boolean): void;
}

export function createImageDailyCap(dataDir: string, options: { cap?: number; now?: () => Date } = {}): ImageDailyCap {
  const cap = options.cap ?? IMAGE_DAILY_CAP;
  const now = options.now ?? (() => new Date());
  const file = join(dataDir, IMAGE_DAY_FILE);
  let held = 0;
  const madeToday = (): number => {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { day?: unknown; count?: unknown } | null;
      const count = saved?.count;
      return saved?.day === localDay(now()) && typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
    } catch {
      return 0;
    }
  };
  return {
    cap,
    reserve() {
      if (madeToday() + held >= cap) return false;
      held += 1;
      return true;
    },
    settle(made) {
      held = Math.max(0, held - 1);
      if (!made) return;
      try {
        writeFileAtomic(file, `${JSON.stringify({ day: localDay(now()), count: madeToday() + 1 })}\n`, { mode: 0o600 });
      } catch (error) {
        console.warn(`image generation: could not count today's image in ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
