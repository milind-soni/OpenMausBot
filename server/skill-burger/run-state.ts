// Paused Skill Burger runs, one small file each, found by the run's id. Security invariant: a resume is taken once (the
// file is moved aside before the run goes on, so two resumes of one pause never both run its side effects), only by the
// bot that started it, and only within a day.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import type { RunState } from "./runner.ts";

export const RUN_STATE_TTL_MS = 24 * 60 * 60_000;
const ID = /^[0-9a-f-]{36}$/;

export function createRunStates(dir: string, now: () => number = Date.now) {
  const file = (id: string) => join(dir, `${id}.json`);
  const sweep = () => {
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name !== "history.json" && now() - statSync(path).mtimeMs > RUN_STATE_TTL_MS) rmSync(path, { force: true });
      }
    } catch {
      // Nothing saved yet.
    }
  };
  return {
    save(state: RunState): void {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(file(state.id), JSON.stringify(state), { mode: 0o600 });
      sweep();
    },
    /** The newest run in `threadId` paused on the teammates' replies to `handoffs`, if any: the turn those replies resume
     * is pointed back into it. A run waiting on other hand-offs, or abandoned, is never named. */
    waitingIn(threadId: string, handoffs: readonly string[]): RunState | null {
      let newest: RunState | null = null;
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".json") || name === "history.json") continue;
          try {
            const seen = JSON.parse(readFileSync(join(dir, name), "utf8")) as RunState;
            const ours = seen.delegation?.requests.some((request) => handoffs.includes(request.requestId));
            if (seen.threadId === threadId && seen.waiting?.type === "teammates" && ours && now() - seen.createdAt <= RUN_STATE_TTL_MS && (!newest || seen.createdAt > newest.createdAt)) newest = seen;
          } catch {
            // Not a run's file.
          }
        }
      } catch {
        // Nothing saved yet.
      }
      return newest;
    },
    /** The paused run, taken so nobody else can resume it; null when it is gone, too old, or another bot's. */
    take(id: string, botId: string): RunState | null {
      if (!ID.test(id)) return null;
      const read = (path: string): RunState | null => {
        try { return JSON.parse(readFileSync(path, "utf8")) as RunState; } catch { return null; }
      };
      const seen = read(file(id));
      if (!seen || seen.botId !== botId || now() - seen.createdAt > RUN_STATE_TTL_MS) return null;
      const taken = `${file(id)}.taken-${now()}`;
      try {
        renameSync(file(id), taken);
      } catch {
        return null;
      }
      try {
        return read(taken);
      } finally {
        rmSync(taken, { force: true });
      }
    },
  };
}
export type RunStates = ReturnType<typeof createRunStates>;
