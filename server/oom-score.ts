import { readFileSync, writeFileSync } from "node:fs";

/** Linux's OOM killer takes the process with the highest score first, and `oom_score_adj` (-1000 to 1000) moves a process
 * up or down that order. On a Cloud home the engines (and the MCP servers they start) go first, Chrome's tabs next (Chrome
 * scores them 200 and up itself), and the server and the edge, which answer the health check, last. */
export const OOM_SCORE = { engine: 1000, server: -800, edge: -900 } as const;

const OWN = "/proc/self/oom_score_adj";

/**
 * Runs `spawn` with this process's own score set to `score` for that instant. A child takes its parent's score when it is
 * forked, so the process is born with it, and so is everything it starts, however soon. Raising a score needs no privilege;
 * going back down needs root, or a score no lower than the one root last set, which is where it goes back to.
 */
export function spawnWithOomScore<T>(score: number, spawn: () => T,
  file: { read: (path: string) => string; write: (path: string, data: string) => void } = { read: (path) => readFileSync(path, "utf8"), write: writeFileSync }): T {
  if (process.platform !== "linux") return spawn();
  let own: string | null = null;
  try {
    own = file.read(OWN).trim();
    file.write(OWN, String(score));
  } catch {
    own = null;
  }
  try {
    return spawn();
  } finally {
    if (own !== null) try { file.write(OWN, own); } catch {}
  }
}
