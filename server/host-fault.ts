// A failure whose cause is this server, one of its tool servers or a sign-in, not the AI's work: starting the same work
// again meets it again and spends the person's AI budget for nothing. Read from the failure's own words, so every caller
// (a routine's second start, a Chief's incident, a hand-off's resume, the turn admission) judges one failure one way.
import { classifyError } from "./drivers/retry.ts";

/** process_start: the server could not start another process (out of processes, file handles or memory);
 * disk_full: no room left to write; tool_server: an MCP server did not start, died or needs its own sign-in;
 * signed_out: the bot's AI needs signing in again. */
export type HostFault = "process_start" | "disk_full" | "tool_server" | "signed_out";

const EXHAUSTED = String.raw`(?:EAGAIN|EMFILE|ENFILE|ENOMEM)`;
const PROCESS_START = new RegExp(
  String.raw`\b(?:posix_)?spawn(?:Sync)?\b[^\n]*\b${EXHAUSTED}\b|\b${EXHAUSTED}\b[^\n]*\b(?:posix_)?spawn\b` +
  String.raw`|\bfork\b[^\n]*\b(?:resource temporarily unavailable|cannot allocate memory)\b|\btoo many open files\b|\bcannot allocate memory\b`, "i");
const DISK_FULL = /\bno space left on device\b|\bENOSPC\b|\bdisk quota exceeded\b|\bEDQUOT\b/i;
const TOOL_SERVER = new RegExp(
  String.raw`\bMCP server\b[^\n]*\b(?:could not start|couldn't be set up|failed to start|exited|input closed|stdin (?:is )?closed|is not connected|session expired|needs (?:a sign-in|authentication)|refused the sign-in)\b` +
  String.raw`|\bMCP (?:request|startup) timed out\b|\bMCP session closed\b|\bCould not reach this MCP server\b`, "i");

/** Which such fault a failure's words name; null for anything else, the AI's own errors and its provider's among them. */
export function hostFaultOf(failure: string, stopReason?: string | null): HostFault | null {
  if (PROCESS_START.test(failure)) return "process_start";
  if (DISK_FULL.test(failure)) return "disk_full";
  if (TOOL_SERVER.test(failure)) return "tool_server";
  if (stopReason === "auth_required" || classifyError({ text: failure }).reason === "auth") return "signed_out";
  return null;
}

/** The fault in the words a model is given, to follow "because". */
export const HOST_FAULT_WHY: Readonly<Record<HostFault, string>> = {
  process_start: "this server could not start another process",
  disk_full: "this server's disk is full",
  tool_server: "one of its tool servers is not running or not signed in",
  signed_out: "its AI is signed out",
};
