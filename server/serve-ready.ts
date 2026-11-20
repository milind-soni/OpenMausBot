import { stallLimitMs } from "./turn-watchdog.ts";

const DEFAULT_READY_LIMIT_MS = 5 * 60_000;
const STILL_STARTING_AFTER_MS = 60_000;
const POLL_MS = 250;

export const serveReadyLimitMs = (env: NodeJS.ProcessEnv): number => stallLimitMs(env.OMB_SERVE_READY_TIMEOUT_MS, DEFAULT_READY_LIMIT_MS);

export interface ReadyWait {
  limitMs: number;
  up: () => Promise<boolean>;
  stopped: () => boolean;
  stillStarting: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForServer({ limitMs, up, stopped, stillStarting, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }: ReadyWait): Promise<void> {
  const startedAt = now();
  let noted = false;
  while (now() - startedAt < limitMs && !stopped()) {
    if (await up()) return;
    if (!noted && now() - startedAt >= STILL_STARTING_AFTER_MS) {
      noted = true;
      stillStarting();
    }
    await sleep(POLL_MS);
  }
}

export function serverNotReadyMessage(limitMs: number, logPath?: string): string {
  const details = logPath ? `Details: ${logPath}.` : "Anything it printed is above.";
  return `OpenMausBot was still starting after ${Math.ceil(limitMs / 1000)} seconds, so it was stopped. ${details} To wait longer, set OMB_SERVE_READY_TIMEOUT_MS (in milliseconds).`;
}
