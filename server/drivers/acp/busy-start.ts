// session/new on a starved Cloud: OpenCode 1.19 on a 2 GB shared-CPU Cloud whose memory was held by a bot's commands took
// 26–46 s to answer it and then refused with its own `Internal error: Internal service failure (session/new,
// ServiceUnavailableError)`. A transient refusal on a live process is asked once more (after a pause while the machine is
// pressed). One that still fails on a Cloud found pressed during the start, when it is that refusal of the engine's own or
// its first answer was slow, shows one plain line in the failed task: out of CPU (chat.notice.cloudOutOfCpu) when CPU
// presses it, else too busy (chat.notice.cloudBusyStart). Its message stays the engine's, so it is handled exactly as
// before: a provider outage (a 429, "503 overloaded") keeps its own words, and a backup AI still starts where one may.
// Our own limits stay as they are (session/new may take NEW_SESSION_TIMEOUT); a timeout is never asked again, which would
// double the wait.
import { clearStartFailure, noteStartFailure } from "../../engine-start-failures.ts";
import { engineMemory } from "../../engine-memory.ts";
import { machinePressure } from "../../machine-pressure.ts";
import { classifyError } from "../retry.ts";
import { RuntimeNoticeError, runtimeErrorText } from "../runtime-notice-error.ts";

/** Before asking again while the machine is pressed: room for what holds it to ease. */
export const BUSY_RETRY_PAUSE_MS = 10_000;
/** A first answer to session/new this slow came from a starved machine, whatever it said. */
export const SLOW_FIRST_ANSWER_MS = 20_000;
/** The engine's own refusal when it could not get its services up in time (OpenCode's `ServiceUnavailableError`). */
const OWN_BUSY_REFUSAL = /\bServiceUnavailableError\b|\binternal service failure\b/i;

export interface BusyStartDeps {
  /** Why the machine is pressed now, null when it is not (machine-pressure.ts). */
  pressure: () => string | null;
  /** This server is a Cloud home, whose plan the plain line names. */
  cloud: () => boolean;
  pause: (ms: number) => Promise<void>;
  now: () => number;
}

const defaults: BusyStartDeps = {
  pressure: () => machinePressure.reason(),
  cloud: () => engineMemory.enabled && !engineMemory.selfHosted(),
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A refusal worth one more ask: transient, not a sign-in, not a timeout. */
function askAgain(error: unknown): boolean {
  if ((error as { acpSignInRequired?: unknown } | null)?.acpSignInRequired === true || /\btimed? out\b/i.test(text(error))) return false;
  return classifyError({ text: text(error) }).transient;
}

/** The plain line for a start the Cloud was too busy for (`why`: the pressure read during the start, null for none;
 * `slow`: its first answer took SLOW_FIRST_ANSWER_MS or more), as the failed task's words; the error is otherwise the same
 * (its message, code and data), so it is retried, classified and handed to a backup exactly as before. */
export function busyStartFailure(error: unknown, why: string | null, slow: boolean, deps: Pick<BusyStartDeps, "cloud"> = defaults): unknown {
  if (why === null || !deps.cloud() || !(error instanceof Error) || (error as { acpSignInRequired?: unknown }).acpSignInRequired === true) return error;
  if (!classifyError({ text: error.message }).transient || !(OWN_BUSY_REFUSAL.test(error.message) || slow)) return error;
  const key = /^(?:cpu|event loop)\b/.test(why) ? "chat.notice.cloudOutOfCpu" : "chat.notice.cloudBusyStart";
  const { code, data, acpSessionFailure } = error as { code?: unknown; data?: unknown; acpSessionFailure?: unknown };
  return Object.assign(new RuntimeNoticeError(error.message, key), {
    ...(code !== undefined ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(acpSessionFailure !== undefined ? { acpSessionFailure } : {}),
  });
}

/** Why this start failed, for the health report's code (engine-start-failures.ts): the machine too busy (the plain line
 * above), or the engine's or its provider's own transient refusal (a 5xx, an overload, a timeout); a sign-in or anything
 * else keeps its code as before. */
export function startFailureClass(error: unknown): "overloaded" | "provider" | null {
  const key = runtimeErrorText(error)?.key;
  if (key === "chat.notice.cloudOutOfCpu" || key === "chat.notice.cloudBusyStart") return "overloaded";
  if (!(error instanceof Error) || (error as { acpSignInRequired?: unknown }).acpSignInRequired === true) return null;
  return classifyError({ text: error.message }).transient ? "provider" : null;
}

/** session/new, asked once more after a transient refusal while its process lives. `threadId`: the turn's thread, whose
 * failed row the health report codes by why the start failed (`startFailureClass`); one map write on a failed start only. */
export async function sessionNewRetried<T>(send: () => Promise<T>, alive: () => boolean, deps: BusyStartDeps = defaults, threadId?: string): Promise<T> {
  const atStart = deps.pressure(), startedAt = deps.now();
  /** The pressure read at the start, else now: a Cloud pressed at any point of the start. */
  const during = () => atStart ?? deps.pressure();
  const failed = (error: unknown) => {
    if (threadId === undefined) return error;
    // A start that failed for another reason (a sign-in, a request problem) takes back an earlier start's note on the thread
    // (the backup AI's start after a provider refusal): its row keeps its own code.
    const why = startFailureClass(error);
    if (why) noteStartFailure(threadId, why, deps.now()); else clearStartFailure(threadId);
    return error;
  };
  try {
    return await send();
  } catch (first) {
    const slow = deps.now() - startedAt >= SLOW_FIRST_ANSWER_MS;
    if (!askAgain(first) || !alive()) throw failed(busyStartFailure(first, during(), slow, deps));
    const afterFirst = during();
    if (afterFirst !== null) await deps.pause(BUSY_RETRY_PAUSE_MS);
    if (!alive()) throw failed(busyStartFailure(first, afterFirst ?? deps.pressure(), slow, deps));
    try {
      return await send();
    } catch (second) {
      throw failed(busyStartFailure(second, afterFirst ?? deps.pressure(), slow, deps));
    }
  }
}
