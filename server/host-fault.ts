// A failure whose cause is this server, one of its tool servers or a sign-in, not the AI's work: starting the same work
// again meets it again and spends the person's AI budget for nothing. Read from the failure's own words, so every caller
// (a routine's second start, a Chief's incident, a hand-off's resume, the turn admission) judges one failure one way.

/** process_start: the server could not start another process (out of processes or file handles);
 * out_of_room: no memory to start an engine, or an engine that had started was stopped for memory, killed by the kernel,
 * or never sent its first output; disk_full: no room left to write; tool_server: an MCP server did not start, died or
 * needs its own sign-in; signed_out: the engine says the bot's AI needs signing in again; bot_memory: the bot used more
 * memory than this server allows one bot, and was stopped (bot-memory-cap.ts). */
export type HostFault = "process_start" | "out_of_room" | "disk_full" | "tool_server" | "signed_out" | "bot_memory";

const EXHAUSTED = String.raw`(?:EAGAIN|EMFILE|ENFILE)`;
/** An engine that started but could not start its own threads, which counts against the same pids limit: grok 1.0.x's
 * "grok: failed to start tokio runtime: blocking pool pre-warm stalled after 14 of 16 threads", Rust's "failed to spawn
 * thread: Os { code: 11, kind: WouldBlock, … }", glibc's and Go's pthread_create or new-OS-thread failure with EAGAIN. */
const THREAD_START = new RegExp(
  String.raw`\bblocking pool pre-warm stalled\b` +
  String.raw`|\b(?:failed to start tokio runtime|failed to (?:spawn|create) (?:a |new )?(?:OS )?thread|pthread_create)\b[^\n]*` +
  String.raw`(?:\bresource temporarily unavailable\b|\bos error 11\b|\berrno=11\b|\bEAGAIN\b|\bWouldBlock\b)`, "i");
const PROCESS_START = new RegExp(
  String.raw`\b(?:posix_)?spawn(?:Sync)?\b[^\n]*\b${EXHAUSTED}\b|\b${EXHAUSTED}\b[^\n]*\b(?:posix_)?spawn\b` +
  String.raw`|\bfork\b[^\n]*\bresource temporarily unavailable\b|\btoo many open files\b` +
  String.raw`|^There is no room to start another program \(${EXHAUSTED}\)|${THREAD_START.source}`, "i");

/** Whether a line an engine wrote says it could not start its threads for want of room (the pids limit or RLIMIT_NPROC),
 * as a refused spawn's EAGAIN does. */
export const threadsRefused = (line: string): boolean => THREAD_START.test(line);
const OUT_OF_ROOM = new RegExp(
  String.raw`\bENOMEM\b|\bcannot allocate memory\b|^There is no room to start another program \(ENOMEM\)` +
  String.raw`|^Ran out of room, so I (?:closed the browser|stopped this task)\b|\bran out of memory\b|\bout of memory\b|\bOOM[- ]kill` +
  String.raw`|\bexited null\b|\bexited 137\b|\(signal SIGKILL\)|\bkilled by (?:the kernel|signal SIGKILL)\b` +
  String.raw`|\b(?:never sent|sent nothing|did not send) (?:its|a|any) first (?:frame|event|output|message)\b`, "i");
/** bot-memory-cap.ts's own line (chat.notice.botMemoryCap), after the bot's name. */
const BOT_MEMORY = /\bused more memory than this computer allows for one bot\b/i;
const DISK_FULL = /\bno space left on device\b|\bENOSPC\b|\bdisk quota exceeded\b|\bEDQUOT\b/i;
const TOOL_SERVER = new RegExp(
  String.raw`\bMCP server\b[^\n]*\b(?:could not start|couldn't be set up|failed to start|exited|input closed|stdin (?:is )?closed|is not connected|session expired|needs (?:a sign-in|authentication)|refused the sign-in)\b` +
  String.raw`|\bMCP startup timed out\b|\bMCP session closed\b|\bCould not reach this MCP server\b`, "i");
/** The engine's own words for a sign-in it needs: Claude Code's "Not logged in · Please run /login", a provider's
 * "API Error: 401", "HTTP 401", "(status 401 …)", Codex's "unexpected status 401", "authentication_error", "invalid x-api-key". A 401 or "forbidden"
 * anywhere else (a tool's answer, a routine's name) is not a sign-in. */
const SIGNED_OUT = new RegExp(
  String.raw`\bnot logged in\b|\bplease run /login\b|\blogged out\b|\bauthentication_error\b|\binvalid (?:api key|x-api-key|bearer token)\b` +
  String.raw`|\bmissing bearer\b|\bauthentication required\b|\bOAuth token (?:has )?expired\b|(?:^API Error:? |\bHTTP |\(status |\bunexpected status |\bstatus code:? )401\b`, "i");
/** An engine that exited before its result: its stderr tail follows the colon, and names a cause only for what an
 * exit itself shows (memory, disk, processes), never a tool server it merely mentions. */
const ENGINE_EXIT = /^([\w.-]+ exited (?:-?\d+|null)(?: \(signal \w+\))? before [\w/]+)[:;]/;

/** Which such fault a failure's own words name; null for anything else, the AI's own errors and its provider's among
 * them. Classify the system's failure text and stop reason only: never a name, a request or a model's reply. */
export function hostFaultOf(failure: string, stopReason?: string | null): HostFault | null {
  if (BOT_MEMORY.test(failure)) return "bot_memory";
  if (PROCESS_START.test(failure)) return "process_start";
  if (DISK_FULL.test(failure)) return "disk_full";
  if (OUT_OF_ROOM.test(failure)) return "out_of_room";
  const head = ENGINE_EXIT.exec(failure)?.[1] ?? failure;
  if (TOOL_SERVER.test(head)) return "tool_server";
  if (stopReason === "auth_required" || SIGNED_OUT.test(head)) return "signed_out";
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
  bot_memory: "it used more memory than this computer allows for one bot",
};
