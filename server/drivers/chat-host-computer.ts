// This desktop's own computer for the Chat Completions runtime: its tools are listed even when its helper is slow to
// start, and a turn whose helper did not start says so through a tool instead of having no computer tools.
import { noticeFailure, type ChatNoticeKey } from "../chat-notices.ts";
import type { ServerText } from "../../shared/server-text.ts";

const HOST_COMPUTER_STARTUP_MS = 20_000;
/** Windows: each turn starts the gate proxy as Electron and cua-driver.exe behind it, beside every other built-in;
 * a cold start there (Defender scanning both executables on a busy disk) runs well past the general budget. */
const WINDOWS_HOST_COMPUTER_STARTUP_MS = 45_000;
/** How long a turn waits before going on with an earlier list, or with the stand-in after a failed start. */
export const HOST_COMPUTER_QUICK_MS = 1_500;

/** How long this computer's helper gets to start; past the turn's own wait it starts in the background. */
export function hostComputerStartupMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? WINDOWS_HOST_COMPUTER_STARTUP_MS : HOST_COMPUTER_STARTUP_MS;
}

/** Tool name, under the "computer" server, the model sees while the computer's real tools are not listed. */
export const HOST_COMPUTER_STAND_IN = "computer_tools_status";

type Server = { command: string; args: string[]; env: Record<string, string> };

/** The driver behind the turn's gate, never the turn's own capability, so every turn on the same driver shares it. */
export function hostComputerKey(server: Server): string {
  const { OMB_CUA_COMMAND, OMB_CUA_ARGS, OMB_CUA_PLATFORM, OMB_HOST_FILES } = server.env;
  return JSON.stringify(OMB_CUA_COMMAND === undefined ? [server.command, server.args] : [OMB_CUA_COMMAND, OMB_CUA_ARGS ?? "", OMB_CUA_PLATFORM ?? "", OMB_HOST_FILES ?? ""]);
}

const lastListed = new Map<string, unknown[]>();
const lastFailed = new Set<string>();

export type HostComputerStart =
  | { state: "listed"; tools: unknown[] }
  /** Slow this turn: its last start's tools are listed, and a call waits for `ready`. */
  | { state: "pending"; tools: unknown[]; ready: Promise<void> }
  /** Slow with no earlier list to show: the stand-in waits for `ready`. */
  | { state: "starting"; ready: Promise<unknown[]> }
  | { state: "failed"; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "its helper did not start";
}

/** The turn waits `quickMs` once this driver has listed or failed before, `firstMs` on its first start; `list` bounds
 * the start itself by hostComputerStartupMs, and past the wait it goes on in the background. */
export async function startHostComputer(key: string, list: (include: (tool: unknown) => boolean) => Promise<unknown[]>,
  include: (tool: unknown) => boolean, wait: { quickMs: number; firstMs: number }, signal: AbortSignal): Promise<HostComputerStart> {
  const seen: unknown[] = [];
  const listing = list((tool) => { seen.push(tool); return include(tool); }).then((tools) => {
    lastListed.set(key, seen);
    lastFailed.delete(key);
    return tools;
  }, (error: unknown) => {
    if (!signal.aborted) lastFailed.add(key);
    throw error;
  });
  listing.catch(() => {});
  const cached = lastListed.get(key);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, cached || lastFailed.has(key) ? wait.quickMs : wait.firstMs, undefined); });
  const outcome = await Promise.race([listing.then((tools) => ({ tools }), (error: unknown) => ({ error })), late]);
  clearTimeout(timer);
  if (outcome && "tools" in outcome) return { state: "listed", tools: outcome.tools };
  if (outcome) return { state: "failed", reason: reasonOf(outcome.error) };
  console.warn("chat-mcp: this computer's tools are still starting; the turn goes on and its first computer call waits for them");
  if (cached) return { state: "pending", tools: cached.filter(include), ready: listing.then(() => undefined) };
  return { state: "starting", ready: listing };
}

/** The cause, waiting for `ready` unless the turn or the call is stopped first; undefined once it has started. */
export function hostComputerFailure(ready: Promise<unknown>, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("MCP operation cancelled"));
    const stop = () => reject(new Error("MCP operation cancelled"));
    signal.addEventListener("abort", stop, { once: true });
    ready.then(() => resolve(undefined), (error: unknown) => resolve(reasonOf(error))).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Whether or not this bot was given this computer, a slow helper is never a missing link. */
const NOT_A_LINK = "This is a start-up problem of the computer's tools, not a missing link: never ask the person to link or connect this computer.";

export function hostComputerDidNotStart(reason: string): string {
  return `The tools for this computer did not start this time (${reason}). ${NOT_A_LINK} Tell the person they did not start and to try again in a moment.`;
}

export const HOST_COMPUTER_READY = "The tools for this computer are ready and listed for your next step.";

export function hostComputerStandIn(reason?: string) {
  const description = reason === undefined
    ? `The tools for this computer are still starting. If the person's request needs this computer, call this first: it waits for them, then lists them for your next step. ${NOT_A_LINK}`
    : `The tools for this computer are unavailable this time (${reason}). Only mention it if the person's request needs this computer; then tell them its tools did not start and to try again in a moment. ${NOT_A_LINK}`;
  return { type: "function" as const, function: { name: HOST_COMPUTER_STAND_IN, description, parameters: { type: "object", properties: {}, additionalProperties: false } } };
}

/** A catalog piece for the cause, so the person's line is worded in their language rather than carrying the English. */
function why(reason: string): string {
  if (/timed out/i.test(reason)) return "chat.notice.part.computerToolsTookTooLong";
  if (/exited|could not start|input closed|stopped/i.test(reason)) return "chat.notice.part.computerToolsHelperStopped";
  return "chat.notice.part.computerToolsHelperFailed";
}

const NOTICED_KEPT = 500;
const noticed = new Set<string>();

/** The person's line for a start that failed: in full once per conversation, then a short one while it keeps failing. */
export function hostComputerNotice(conversation: string | undefined, reason: string): { message: string; text: ServerText } {
  const repeat = conversation !== undefined && noticed.has(conversation);
  if (conversation !== undefined && !repeat) {
    noticed.add(conversation);
    if (noticed.size > NOTICED_KEPT) noticed.delete(noticed.values().next().value!);
  }
  const key: ChatNoticeKey = repeat ? "chat.notice.computerToolsStillNotStarting" : "chat.notice.computerToolsDidNotStart";
  return noticeFailure(key, repeat ? undefined : { why: why(reason) });
}

/** The computer started in this conversation, so its next failure is told in full again. */
export function hostComputerStarted(conversation: string | undefined): void {
  if (conversation !== undefined) noticed.delete(conversation);
}

/** Tells the person when a start the turn went on without fails, unless the turn ended first. */
export function watchHostComputerStart(ready: Promise<unknown>, conversation: string | undefined, notice: ((line: { message: string; text: ServerText }) => void) | undefined,
  open: () => boolean): void {
  ready.then(() => hostComputerStarted(conversation), (error: unknown) => {
    if (open()) notice?.(hostComputerNotice(conversation, reasonOf(error)));
  });
}
