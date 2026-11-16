// A failure whose cause is this server, one of its tool servers or a sign-in, not the AI's work: starting the same work
// again meets it again and spends the person's AI budget for nothing. Read from the failure's own words, so every caller
// (a routine's second start, a Chief's incident, a hand-off's resume, the turn admission) judges one failure one way.
import { classifyError } from "./drivers/retry.ts";

/** process_start: the server could not start another process (out of processes, file handles or memory);
 * out_of_room: an engine that had started was stopped for memory, killed by the kernel, or never sent its first output;
 * disk_full: no room left to write; tool_server: an MCP server did not start, died or needs its own sign-in;
 * signed_out: the bot's AI needs signing in again. */
export type HostFault = "process_start" | "out_of_room" | "disk_full" | "tool_server" | "signed_out";

const EXHAUSTED = String.raw`(?:EAGAIN|EMFILE|ENFILE|ENOMEM)`;
const PROCESS_START = new RegExp(
  String.raw`\b(?:posix_)?spawn(?:Sync)?\b[^\n]*\b${EXHAUSTED}\b|\b${EXHAUSTED}\b[^\n]*\b(?:posix_)?spawn\b` +
  String.raw`|\bfork\b[^\n]*\b(?:resource temporarily unavailable|cannot allocate memory)\b|\btoo many open files\b|\bcannot allocate memory\b` +
  String.raw`|^There is no room to start another program\b`, "i");
const OUT_OF_ROOM = new RegExp(
  String.raw`^Ran out of room, so I (?:closed the browser|stopped this task)\b|\bran out of memory\b|\bout of memory\b|\bOOM[- ]kill` +
  String.raw`|\bexited (?:null|137) \(signal SIGKILL\)|\bexited 137\b|\bkilled by (?:the kernel|signal SIGKILL)\b` +
  String.raw`|\b(?:never sent|sent nothing|did not send) (?:its|a|any) first (?:frame|event|output|message)\b`, "i");
const DISK_FULL = /\bno space left on device\b|\bENOSPC\b|\bdisk quota exceeded\b|\bEDQUOT\b/i;
const TOOL_SERVER = new RegExp(
  String.raw`\bMCP server\b[^\n]*\b(?:could not start|couldn't be set up|failed to start|exited|input closed|stdin (?:is )?closed|is not connected|session expired|needs (?:a sign-in|authentication)|refused the sign-in)\b` +
  String.raw`|\bMCP (?:request|startup) timed out\b|\bMCP session closed\b|\bCould not reach this MCP server\b`, "i");

/** Which such fault a failure's words name; null for anything else, the AI's own errors and its provider's among them. */
export function hostFaultOf(failure: string, stopReason?: string | null): HostFault | null {
  if (PROCESS_START.test(failure)) return "process_start";
  if (DISK_FULL.test(failure)) return "disk_full";
  if (OUT_OF_ROOM.test(failure)) return "out_of_room";
  if (TOOL_SERVER.test(failure)) return "tool_server";
  if (stopReason === "auth_required" || classifyError({ text: failure }).reason === "auth") return "signed_out";
  return null;
}

/** Whether starting the same work again soon meets the fault again. An engine stopped for room is the exception: the
 * memory and process admission holds its next start until there is room, so that start may pass. */
export const retryCannotFix = (fault: HostFault): boolean => fault !== "out_of_room";

/** The fault in the words a model is given, to follow "because". */
export const HOST_FAULT_WHY: Readonly<Record<HostFault, string>> = {
  process_start: "this server could not start another process",
  out_of_room: "this server ran out of room for the AI's engine",
  disk_full: "this server's disk is full",
  tool_server: "one of its tool servers is not running or not signed in",
  signed_out: "its AI is signed out",
};
