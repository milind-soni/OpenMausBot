// session/new on a starved Cloud: OpenCode 1.19 on a 2 GB shared-CPU Cloud whose memory was held by a bot's commands took
// 26–46 s to answer it and then refused with its own `Internal error: Internal service failure (session/new,
// ServiceUnavailableError)`. A transient refusal on a live process is asked once more (after a pause while the machine is
// pressed); one that still fails on a Cloud found pressed during the start ends the task with one plain line
// instead of the engine's words: out of CPU (chat.notice.cloudOutOfCpu) when CPU presses it, else too busy
// (chat.notice.cloudBusyStart). Our own limits stay as they are (session/new may take
// NEW_SESSION_TIMEOUT); a timeout is never asked again, which would double the wait.
import { CHAT_NOTICE } from "../../chat-notices.ts";
import { engineMemory } from "../../engine-memory.ts";
import { machinePressure } from "../../machine-pressure.ts";
import { classifyError } from "../retry.ts";
import { RuntimeNoticeError } from "../runtime-notice-error.ts";

/** Before asking again while the machine is pressed: room for what holds it to ease. */
export const BUSY_RETRY_PAUSE_MS = 10_000;
export interface BusyStartDeps {
  /** Why the machine is pressed now, null when it is not (machine-pressure.ts). */
  pressure: () => string | null;
  /** This server is a Cloud home, whose plan the plain line names. */
  cloud: () => boolean;
  pause: (ms: number) => Promise<void>;
}

const defaults: BusyStartDeps = {
  pressure: () => machinePressure.reason(),
  cloud: () => engineMemory.enabled && !engineMemory.selfHosted(),
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A refusal worth one more ask: transient, not a sign-in, not a timeout. */
function askAgain(error: unknown): boolean {
  if ((error as { acpSignInRequired?: unknown } | null)?.acpSignInRequired === true || /\btimed? out\b/i.test(text(error))) return false;
  return classifyError({ text: text(error) }).transient;
}

/** The plain line for a start the Cloud was too busy for (`why`: the pressure read during the start, null for none), keeping
 * the fields the turn's own handling reads (the JSON-RPC code, and whether the process is fit for more sessions); any
 * other failure, or one on a calm machine (a provider outage, which a backup AI may carry), as it was. */
export function busyStartFailure(error: unknown, why: string | null, deps: Pick<BusyStartDeps, "cloud"> = defaults): unknown {
  if (why === null || !deps.cloud() || (error as { acpSignInRequired?: unknown } | null)?.acpSignInRequired === true) return error;
  if (!classifyError({ text: text(error) }).transient) return error;
  const key = why !== null && /^(?:cpu|event loop)\b/.test(why) ? "chat.notice.cloudOutOfCpu" : "chat.notice.cloudBusyStart";
  const fields = error && typeof error === "object" ? error as { code?: unknown; acpSessionFailure?: unknown } : {};
  return Object.assign(new RuntimeNoticeError(CHAT_NOTICE[key], key), {
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    ...(fields.acpSessionFailure !== undefined ? { acpSessionFailure: fields.acpSessionFailure } : {}),
  });
}

/** session/new, asked once more after a transient refusal while its process lives. */
export async function sessionNewRetried<T>(send: () => Promise<T>, alive: () => boolean, deps: BusyStartDeps = defaults): Promise<T> {
  const atStart = deps.pressure();
  /** The pressure read at the start, else now: a Cloud pressed at any point of the start. */
  const during = () => atStart ?? deps.pressure();
  try {
    return await send();
  } catch (first) {
    if (!askAgain(first) || !alive()) throw busyStartFailure(first, during(), deps);
    const afterFirst = during();
    if (afterFirst !== null) await deps.pause(BUSY_RETRY_PAUSE_MS);
    if (!alive()) throw busyStartFailure(first, afterFirst ?? deps.pressure(), deps);
    try {
      return await send();
    } catch (second) {
      throw busyStartFailure(second, afterFirst ?? deps.pressure(), deps);
    }
  }
}
