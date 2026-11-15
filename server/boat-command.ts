// Boat's synchronous POST /sandboxes/{id}/commands answers 502 once a command has run for about 40 s, and the command
// keeps running on the sandbox (seen 2026-11-15 through a relay whose own limit is 180 s: every failed command took
// 40.05 to 40.21 s, the slowest that succeeded 39.9 s). So a command that may run that long is never sent that way: it
// is started `detached`, which answers at once with a processId, and followed with GET /sandboxes/{id}/commands/{id}
// until it ends or the caller's own time is up. A relay that does not forward `detached` runs the command to the end
// and answers with its result, which is taken as it comes.
// Unverified: how many bytes of output `tailBytes` may ask for. A longer output arrives cut, and says so.
import { setTimeout as delay } from "node:timers/promises";

import { assertBoatNotDeleting, boatFetch, probeBoat } from "./boat.ts";
import { boatHealth, unansweredStatus } from "./boat-health.ts";
import type { AppConfig } from "./config.ts";

export const COMMAND_WALL = {
  /** A command given no more time than this by its caller is sent the synchronous way: it cannot reach the 40 s wall,
   * and it answers in one round trip. */
  syncSafeMs: 30_000,
  /** The end of each output stream that is read back: 256 KiB. */
  tailBytes: 262_144,
  /** Before each status read: short at first, so a command that takes a fifth of a second gains about a tenth. */
  pollMs: [40, 80, 150, 300, 600, 1_200, 2_000],
  readTimeoutMs: 15_000,
  /** Commands a computer may have still running after their calls' time ran out, before another long one is refused. */
  leftRunningMax: 5,
} as const;

export interface CommandOutcome {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The caller's time ran out. With `processId`, the command is still running on the computer and was not stopped. */
  timedOut?: true;
  processId?: number;
  /** The gateway could not reach the machine (502, 504, 52x) when the command was sent. */
  unanswered?: true;
  /** A 503, which may be a relay's account-wide refusal rather than this machine. */
  busy?: true;
  /** Only the end of the output came back. */
  outputCut?: true;
  /** The computer restarted or lost track of the command, so how it ended is not known. */
  lost?: true;
}

export const COMMAND_LOST = "The cloud computer restarted or lost track of this command, so its exit code is unknown. Look at the files it writes to see how far it got.";

/** Process ids started on each computer, with when: its idle sleep waits for them, up to a limit the reader sets. */
const started = new Map<string, Map<number, number>>();
const MAX_TRACKED_PER_COMPUTER = 20;
/** The ones whose foreground call gave up waiting. */
const leftRunning = new Map<string, Set<number>>();

export function trackProcess(boxId: string, processId: number): void {
  const mine = started.get(boxId) ?? new Map<number, number>();
  mine.set(processId, Date.now());
  while (mine.size > MAX_TRACKED_PER_COMPUTER) mine.delete(mine.keys().next().value!);
  started.set(boxId, mine);
}

export function untrackProcess(boxId: string, processId: number): void {
  const mine = started.get(boxId);
  mine?.delete(processId);
  if (mine?.size === 0) started.delete(boxId);
  const left = leftRunning.get(boxId);
  left?.delete(processId);
  if (left?.size === 0) leftRunning.delete(boxId);
}

export const trackedProcesses = (boxId: string): ReadonlyMap<number, number> => started.get(boxId) ?? new Map();

/** An answer that does not say it ended counts as running. */
export async function processMayStillRun(cfg: AppConfig, boxId: string, processId: number, timeoutMs = 20_000): Promise<boolean> {
  try {
    const response = await boatFetch(cfg, `/sandboxes/${boxId}/commands/${processId}?tailBytes=1`, { signal: AbortSignal.timeout(timeoutMs) });
    const body: any = await response.json().catch(() => null);
    return response.status !== 404 && !(response.ok && body?.running === false);
  } catch {
    return true;
  }
}

/** How many commands, left running when their call's time ran out, still run; the finished ones are forgotten here. */
export async function commandsLeftRunning(cfg: AppConfig, boxId: string): Promise<number> {
  const running = await Promise.all([...(leftRunning.get(boxId) ?? [])].map(async (processId) => {
    if (await processMayStillRun(cfg, boxId, processId, 5_000)) return true;
    untrackProcess(boxId, processId);
    return false;
  }));
  return running.filter(Boolean).length;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Runs `command` to its end however long it takes, within `timeoutMs`. Whether it ran is always known once it started:
 * the provider's processId answers that, so nothing here sends a command twice. */
export async function runToEnd(
  cfg: AppConfig, boxId: string, command: string, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<CommandOutcome> {
  assertBoatNotDeleting(boxId);
  const deadline = Date.now() + timeoutMs;
  const within = (ms: number) => { const limit = AbortSignal.timeout(Math.max(1, ms)); return signal ? AbortSignal.any([signal, limit]) : limit; };
  const suspect = () => { if (!signal?.aborted) boatHealth.suspect(boxId, () => probeBoat(cfg, boxId)); };
  const res = await boatFetch(cfg, `/sandboxes/${boxId}/commands`, { method: "POST", body: JSON.stringify({ command, detached: true }), signal: within(timeoutMs) })
    .catch((error: unknown) => { suspect(); throw error; });
  const body: any = await res.json().catch(() => null);
  if (unansweredStatus(res.status)) {
    suspect();
    return { ok: false, exitCode: null, stdout: "", stderr: "", unanswered: true };
  }
  if (!res.ok) return { ok: false, exitCode: null, stdout: text(body?.stdout), stderr: text(body?.stderr), ...(res.status === 503 ? { busy: true as const } : {}) };
  const processId = body?.processId;
  if (processId === undefined && (typeof body?.exitCode === "number" || body?.timedOut === true)) {
    if (typeof body.exitCode === "number") boatHealth.answered(boxId);
    return { ok: body.exitCode === 0, exitCode: body.exitCode ?? null, stdout: text(body.stdout), stderr: text(body.stderr), ...(body.timedOut === true ? { timedOut: true as const } : {}) };
  }
  if (!Number.isSafeInteger(processId) || processId < 1) {
    return { ok: false, exitCode: null, stdout: "", stderr: "The cloud computer did not say which process it started, so the command may be running." };
  }
  trackProcess(boxId, processId);
  let last: any = null;
  for (let read = 0; ; read++) {
    const pause = COMMAND_WALL.pollMs[Math.min(read, COMMAND_WALL.pollMs.length - 1)]!;
    await delay(Math.min(pause, Math.max(0, deadline - Date.now())), undefined, { signal }).catch(() => undefined);
    signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      const left = leftRunning.get(boxId) ?? new Set<number>();
      left.add(processId);
      leftRunning.set(boxId, left);
      return { ok: false, exitCode: null, stdout: text(last?.stdout), stderr: text(last?.stderr), timedOut: true, processId };
    }
    let status: Response;
    let seen: any;
    try {
      status = await boatFetch(cfg, `/sandboxes/${boxId}/commands/${processId}?tailBytes=${COMMAND_WALL.tailBytes}`,
        { signal: within(Math.min(COMMAND_WALL.readTimeoutMs, deadline - Date.now())) });
      seen = await status.json().catch(() => null);
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    if (status.status === 404) {
      untrackProcess(boxId, processId);
      return { ok: false, exitCode: null, stdout: text(last?.stdout), stderr: COMMAND_LOST, lost: true };
    }
    // A read the gateway failed says nothing about the command: it is read again.
    if (!status.ok || typeof seen?.running !== "boolean") continue;
    last = seen;
    if (seen.running) continue;
    untrackProcess(boxId, processId);
    const exitCode = Number.isInteger(seen.exitCode) ? seen.exitCode as number : null;
    const lost = seen.status === "lost";
    // Only the machine's own answer counts toward its health: an exit code it reported.
    if (exitCode !== null && !lost) boatHealth.answered(boxId);
    return {
      ok: exitCode === 0, exitCode, stdout: text(seen.stdout), stderr: lost && !text(seen.stderr) ? COMMAND_LOST : text(seen.stderr),
      ...(seen.stdoutTruncated === true || seen.stderrTruncated === true ? { outputCut: true as const } : {}), ...(lost ? { lost: true as const } : {}),
    };
  }
}
