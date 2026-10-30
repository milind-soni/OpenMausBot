import { readFileSync, writeFileSync } from "node:fs";

/** Linux's OOM killer takes the process with the highest score first, and `oom_score_adj` (-1000 to 1000) moves a process
 * up or down that order. On a Cloud home everything a bot runs goes first: its engine and the tools and MCP servers that
 * engine starts, the MCP servers the server runs for it, the helper engines, and its browser (agent-browser's daemon and
 * Chrome, whose tabs Chrome then scores 200 and up itself). The server and the edge, which answer the health check, go last,
 * and the root supervisor that restarts them never. */
export const OOM_SCORE = { bot: 1000, server: -800, edge: -900, supervisor: -1000 } as const;

const OWN = "/proc/self/oom_score_adj";

type ScoreFile = { read: (path: string) => string; write: (path: string, data: string) => void };
const procFile: ScoreFile = { read: (path) => readFileSync(path, "utf8"), write: writeFileSync };

/**
 * Runs `spawn` with this process's own score set to `score` for that instant. A child takes its parent's score when it is
 * forked, so the process is born with it, and so is everything it starts, however soon. Raising a score needs no privilege;
 * going back down needs root, or a score no lower than the one root last set, which is where it goes back to.
 */
export function spawnWithOomScore<T>(score: number, spawn: () => T, file: ScoreFile = procFile): T {
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

/** A bot's own work (its browser, a helper engine, a tool): started with OOM_SCORE.bot, so memory runs out on it first. */
export const spawnBotWork = <T>(spawn: () => T, file: ScoreFile = procFile): T => spawnWithOomScore(OOM_SCORE.bot, spawn, file);

/** The root supervisor's own score, set once at start: root may lower it, and the kernel then never picks it. False where
 * it can't be set (not Linux, not root). */
export function protectSupervisor(file: ScoreFile = procFile): boolean {
  if (process.platform !== "linux") return false;
  try {
    file.write(OWN, String(OOM_SCORE.supervisor));
    return file.read(OWN).trim() === String(OOM_SCORE.supervisor);
  } catch {
    return false;
  }
}
