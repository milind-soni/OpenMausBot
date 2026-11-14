// A trial Cloud's AI keys that came over with the move: saved, but no bot runs on them while the trial's Claude credit
// lasts, since the person's own engine would end the credit at once. When the credit runs out they count as signed in,
// and the bots move to them (cloud-credit-moves.ts). Kept under providers/, which never travels in a backup or a move.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { TRIAL_KEY_HELD } from "./trial-credit.ts";

const ENGINE = /^[\w.:-]{1,128}$/u;

export type HeldKeys = ReturnType<typeof createHeldKeys>;

export function createHeldKeys({ dataDir, lasts }: { dataDir: string; lasts(): boolean }) {
  const file = join(dataDir, "providers", "trial-credit", "held-keys.json");
  const read = (): Set<string> => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { engines?: unknown };
      return new Set(Array.isArray(raw.engines) ? raw.engines.filter((id): id is string => typeof id === "string" && ENGINE.test(id)) : []);
    } catch { return new Set(); }
  };
  let held = read();
  return {
    /** Holds these engines' keys while the credit lasts; false when there is no credit to keep, so the keys run now. */
    hold(engines: readonly string[]): boolean {
      if (!lasts()) return false;
      const next = new Set([...held, ...engines.filter((id) => ENGINE.test(id))]);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileAtomic(file, JSON.stringify({ engines: [...next].sort() }), { mode: 0o600 });
      held = next;
      return true;
    },
    refusal: (instanceId: string): string | undefined => (held.has(instanceId) && lasts() ? TRIAL_KEY_HELD : undefined),
  };
}
