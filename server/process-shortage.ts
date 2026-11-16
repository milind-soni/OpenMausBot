// A spawn the operating system refused for want of room (a container's pids limit, open files, memory) is this server's
// shortage, never the AI's failure: nothing was sent to a model, so nothing is retried on one or handed to a backup.
import { hostFaultOf } from "./host-fault.ts";

/** spawn(2)/fork(2) failures that mean "no room now": EAGAIN (the pids limit or RLIMIT_NPROC), EMFILE and ENFILE (open
 * files), ENOMEM. */
const SHORTAGE_CODES: ReadonlySet<string> = new Set(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"]);
export type ShortageCode = "EAGAIN" | "EMFILE" | "ENFILE" | "ENOMEM";

export function shortageCode(error: unknown): ShortageCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SHORTAGE_CODES.has(code) ? (code as ShortageCode) : null;
}

/** Whether a failed turn's cause is such a refused spawn, chat.notice.outOfProcesses's words among them, as the shared
 * reading of failures that are the server's own (host-fault.ts) names it. */
export const outOfProcesses = (cause: string): boolean => hostFaultOf(cause) === "process_start";
