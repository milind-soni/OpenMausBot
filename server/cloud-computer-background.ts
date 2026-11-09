// Boat (docs.boat.dev/openapi/boat-v1.yaml): POST /sandboxes/{id}/commands with `detached: true` answers at once with an
// integer processId; GET /sandboxes/{id}/commands/{processId} answers `running`, `status` (running, exited or lost),
// `exitCode` and the end of each log, cut to `tailBytes`. A processId means something only on the sandbox that started it.
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertBoatNotDeleting, boatAccount, boatErrorMessage, boatFetch, isolatedRemoteCommand } from "./boat.ts";
import type { CloudComputerResult } from "./cloud-computer-tools.ts";
import type { AppConfig } from "./config.ts";

const PROCESS_ID = /^bg-([1-9][0-9]{0,15})-([0-9a-f]{8})$/;
export const PROCESS_ID_PATTERN = PROCESS_ID.source;
export const STATUS_WAIT_MAX_SECONDS = 60;
export const STDOUT_TAIL_CHARS = 4_000;
export const STDERR_TAIL_CHARS = 2_000;
const POLL_MS = 2_000;
const MAX_LAST_READ_WINDOW_MS = 1_000;
/** Bounds what a forgotten background server can cost: Boat bills while a computer is on. */
export const BACKGROUND_KEEPS_AWAKE_MS = 2 * 60 * 60_000;
const MAX_TRACKED_PER_COMPUTER = 20;
const AWAKE_CHECK_MS = 20_000;
const MAX_UTF8_BYTES_PER_UTF16_UNIT = 3;
const TAIL_BYTES = MAX_UTF8_BYTES_PER_UTF16_UNIT * STDOUT_TAIL_CHARS;

const CHECK_BEFORE_RERUN = "Check before starting it again, for example with exec `pgrep -af '<part of the command>'` or by looking at the files it writes";
export const EXEC_LATE = "The command did not finish within this call's time limit. It may still be running on the cloud computer, so do not run it "
  + `again blindly: a second copy can collide with the first, for example by reading its half-written files. ${CHECK_BEFORE_RERUN}. `
  + "Start a command that may run long (downloads, installs, builds, data jobs) with background: true, then follow it with exec_status.";
const START_LATE = `The cloud computer did not confirm the start in time. The command may have started. ${CHECK_BEFORE_RERUN}.`;
const STATUS_LATE = "The cloud computer did not answer in time. Nothing was changed; call exec_status again.";
const OTHER_COMPUTER = "That process_id is not from this cloud computer. Use the process_id that exec with background: true returned on this computer.";
const UNKNOWN_PROCESS = "This cloud computer has no background command with that process_id; it may have restarted since. "
  + "Look at the files the command writes to see how far it got.";
const LOST = "The cloud computer restarted or lost track of this command, so its exit code may be unknown. Look at the files it writes to see how far it got.";
const CUT = "Only the end of the output is shown. Write long output to a file and read the part you need with exec.";
const STALE = "No newer status was confirmed before the wait ended. This is the last observed status; it may have changed. Call exec_status again.";

type StatusClock = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  timeout: (ms: number) => AbortSignal;
};
const statusClock: StatusClock = {
  now: Date.now,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  timeout: ms => AbortSignal.timeout(ms),
};

const text = (value: string, isError = false): CloudComputerResult => ({ ...(isError ? { isError } : {}), content: [{ type: "text", text: value }] });
const included = (cfg: AppConfig) => boatAccount(cfg)?.included === true;

/** Security: a process_id names the computer it was started on, so one read through another computer is refused rather
 * than answered with whatever process holds that number there. */
const computerTag = (boxId: string) => createHash("sha256").update(boxId).digest("hex").slice(0, 8);
export const processIdOn = (boxId: string, processId: number) => `bg-${processId}-${computerTag(boxId)}`;

function processIdFrom(boxId: string, value: string): number | null {
  const match = PROCESS_ID.exec(value);
  const processId = Number(match?.[1]);
  return match && match[2] === computerTag(boxId) && Number.isSafeInteger(processId) ? processId : null;
}

/** Never starts on a lone low surrogate: half a character is an invalid string some providers reject. */
function tail(value: unknown, chars: number): { text: string; cut: boolean } {
  const whole = typeof value === "string" ? value : "";
  if (whole.length <= chars) return { text: whole, cut: false };
  const kept = whole.slice(-chars);
  const first = kept.charCodeAt(0);
  return { text: first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept, cut: true };
}

/** An Admin relay that does not forward `detached` has Boat run the command to the end and answer with its result. */
function ranInForeground(body: any): CloudComputerResult {
  const stdout = tail(body.stdout, STDOUT_TAIL_CHARS), stderr = tail(body.stderr, STDERR_TAIL_CHARS);
  return text(JSON.stringify({
    status: "finished", exitCode: body.exitCode, stdout: stdout.text, stderr: stderr.text,
    ...(stdout.cut || stderr.cut ? { outputCut: CUT } : {}), note: "The cloud computer ran this command to the end instead of in the background.",
  }), body.exitCode !== 0);
}

/** Process ids started on each computer, by box id, with when they started: its idle sleep waits for them. */
const started = new Map<string, Map<number, number>>();

function track(boxId: string, processId: number): void {
  const mine = started.get(boxId) ?? new Map<number, number>();
  mine.set(processId, Date.now());
  while (mine.size > MAX_TRACKED_PER_COMPUTER) mine.delete(mine.keys().next().value!);
  started.set(boxId, mine);
}

function untrack(boxId: string, processId: number): void {
  const mine = started.get(boxId);
  mine?.delete(processId);
  if (mine?.size === 0) started.delete(boxId);
}

/** An answer that does not say it ended counts as running; BACKGROUND_KEEPS_AWAKE_MS still ends the wait. */
async function mayStillRun(cfg: AppConfig, boxId: string, processId: number): Promise<boolean> {
  try {
    const response = await boatFetch(cfg, `/sandboxes/${boxId}/commands/${processId}?tailBytes=1`, { signal: AbortSignal.timeout(AWAKE_CHECK_MS) });
    const body: any = await response.json().catch(() => null);
    return response.status !== 404 && !(response.ok && body?.running === false);
  } catch {
    return true;
  }
}

export async function backgroundCommandRunning(cfg: AppConfig, boxId: string): Promise<boolean> {
  for (const [processId, at] of started.get(boxId) ?? []) {
    if (Date.now() - at < BACKGROUND_KEEPS_AWAKE_MS && await mayStillRun(cfg, boxId, processId)) return true;
    untrack(boxId, processId);
  }
  return false;
}

export async function startInBackground(cfg: AppConfig, boxId: string, command: string, signal: AbortSignal): Promise<CloudComputerResult> {
  assertBoatNotDeleting(boxId);
  const response = await boatFetch(cfg, `/sandboxes/${boxId}/commands`, {
    method: "POST", body: JSON.stringify({ command: isolatedRemoteCommand(command), detached: true }), signal,
  });
  const body: any = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = boatErrorMessage(response.status, "Starting the command", body, included(cfg));
    return text(response.status >= 500 ? `${refusal} The command may have started. ${CHECK_BEFORE_RERUN}.` : refusal, true);
  }
  const processId = body?.processId;
  if (Number.isInteger(body?.exitCode) && processId === undefined) return ranInForeground(body);
  if (!Number.isSafeInteger(processId) || processId < 1) return text(`The cloud computer did not say which process it started. The command may have started. ${CHECK_BEFORE_RERUN}.`, true);
  track(boxId, processId);
  return text(JSON.stringify({ processId: processIdOn(boxId, processId), status: "running", next: "It keeps running after this call, but its completion will not automatically resume this turn or notify a delegator. If its result is needed for this task, use exec_status with wait_seconds in this turn until it finishes, then check its exit code and output. If you cannot finish checking in this turn, report it as unfinished with the process_id; do not start another copy blindly." }));
}

function describeStatus(processId: string, body: any, observedAt?: number): CloudComputerResult {
  const stdout = tail(body.stdout, STDOUT_TAIL_CHARS), stderr = tail(body.stderr, STDERR_TAIL_CHARS);
  const status = body.running ? "running" : body.status === "lost" ? "lost" : "finished";
  return text(JSON.stringify({
    processId, status, exitCode: body.running ? null : (Number.isInteger(body.exitCode) ? body.exitCode : null),
    ...(!body.running && typeof body.signal === "string" && body.signal ? { signal: body.signal } : {}),
    ...(body.oomKilled === true ? { outOfMemory: true } : {}),
    stdout: stdout.text, stderr: stderr.text,
    ...(stdout.cut || stderr.cut || body.stdoutTruncated === true || body.stderrTruncated === true ? { outputCut: CUT } : {}),
    ...(status === "lost" ? { note: LOST } : {}),
    ...(observedAt === undefined ? {} : { observedAt: new Date(observedAt).toISOString(), note: STALE }),
  }));
}

function statusError(message: string, processId: string, last?: { body: any; observedAt: number }): CloudComputerResult {
  if (!last) return text(message, true);
  const stdout = tail(last.body.stdout, STDOUT_TAIL_CHARS), stderr = tail(last.body.stderr, STDERR_TAIL_CHARS);
  return text(JSON.stringify({
    error: message,
    lastObserved: {
      processId, status: "running", observedAt: new Date(last.observedAt).toISOString(), stdout: stdout.text, stderr: stderr.text,
      ...(stdout.cut || stderr.cut || last.body.stdoutTruncated === true || last.body.stderrTruncated === true ? { outputCut: CUT } : {}),
      note: "This status and output were last observed at this time and may have changed.",
    },
  }), true);
}

export async function backgroundStatus(
  cfg: AppConfig,
  boxId: string,
  args: { process_id: string; wait_seconds?: number },
  signal: AbortSignal,
  clock: StatusClock = statusClock,
): Promise<CloudComputerResult> {
  const processId = processIdFrom(boxId, args.process_id);
  if (processId === null) return text(OTHER_COMPUTER, true);
  const waitMs = Math.min(args.wait_seconds ?? 0, STATUS_WAIT_MAX_SECONDS) * 1_000;
  const until = clock.now() + waitMs;
  const lastReadWindow = Math.min(MAX_LAST_READ_WINDOW_MS, waitMs / 2);
  let last: { body: any; observedAt: number } | undefined;
  let finalRead = false;
  for (;;) {
    signal.throwIfAborted();
    assertBoatNotDeleting(boxId);
    if (last && clock.now() >= until) return describeStatus(args.process_id, last.body, last.observedAt);
    const deadline = waitMs && last ? clock.timeout(Math.max(1, until - clock.now())) : null;
    const readSignal = deadline ? AbortSignal.any([signal, deadline]) : signal;
    let response: Response, body: any;
    try {
      response = await boatFetch(cfg, `/sandboxes/${boxId}/commands/${processId}?tailBytes=${TAIL_BYTES}`, { signal: readSignal });
      body = await response.json().catch(() => null);
      readSignal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if (deadline?.aborted) return last ? describeStatus(args.process_id, last.body, last.observedAt) : text(STATUS_LATE, true);
      throw error;
    }
    if (response.status === 404) return statusError(UNKNOWN_PROCESS, args.process_id, last);
    if (!response.ok) return statusError(boatErrorMessage(response.status, "Reading the command's status", body, included(cfg)), args.process_id, last);
    if (typeof body?.running !== "boolean") return statusError("The cloud computer gave an unreadable answer about this command. Call exec_status again.", args.process_id, last);
    if (!body.running) untrack(boxId, processId);
    const observedAt = clock.now();
    last = { body, observedAt };
    const remaining = until - observedAt;
    if (!body.running || remaining <= 0 || finalRead) return describeStatus(args.process_id, body);
    const inLastWindow = remaining <= lastReadWindow;
    finalRead = inLastWindow;
    await clock.sleep(inLastWindow ? Math.max(1, Math.floor(remaining / 2)) : Math.min(POLL_MS, remaining - lastReadWindow), signal);
    signal.throwIfAborted();
    if (clock.now() >= until) return describeStatus(args.process_id, body, observedAt);
  }
}

export function commandLateText(name: unknown, args: unknown): string | undefined {
  if (name === "exec_status") return STATUS_LATE;
  if (name !== "exec") return undefined;
  return (args as { background?: unknown }).background === true ? START_LATE : EXEC_LATE;
}
