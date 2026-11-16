// This desktop's own computer for the Chat Completions runtime: its tools are listed even when its helper is slow to
// start, and a turn whose helper did not start says so through a tool instead of having no computer tools.
import { noticeFailure } from "../chat-notices.ts";

const HOST_COMPUTER_STARTUP_MS = 20_000;
/** Windows: each turn starts the gate proxy as Electron and cua-driver.exe behind it, beside every other built-in;
 * a cold start there (Defender scanning both executables on a busy disk) runs well past the general budget. */
const WINDOWS_HOST_COMPUTER_STARTUP_MS = 45_000;

/** How long this computer's helper gets to start; past the turn's own budget it starts in the background. */
export function hostComputerStartupMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? WINDOWS_HOST_COMPUTER_STARTUP_MS : HOST_COMPUTER_STARTUP_MS;
}

/** Tool name, under the "computer" server, the model sees while the computer's real tools are not listed. */
export const HOST_COMPUTER_STAND_IN = "computer_tools_status";

type Server = { command: string; args: string[]; env: Record<string, string> };

/** The driver behind the turn's gate, never the turn's own capability, so every turn on the same driver shares it. */
export function hostComputerKey(server: Server): string {
  const { OMB_CUA_COMMAND, OMB_CUA_ARGS, OMB_CUA_PLATFORM } = server.env;
  return JSON.stringify(OMB_CUA_COMMAND === undefined ? [server.command, server.args] : [OMB_CUA_COMMAND, OMB_CUA_ARGS ?? "", OMB_CUA_PLATFORM ?? ""]);
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

/** Waits for the listing up to `turnMs` once this driver has listed or failed before; on its first start, for the
 * whole listing, which `list` bounds by hostComputerStartupMs. */
export async function startHostComputer(key: string, list: (include: (tool: unknown) => boolean) => Promise<unknown[]>,
  include: (tool: unknown) => boolean, turnMs: number, signal: AbortSignal): Promise<HostComputerStart> {
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
  const late = cached || lastFailed.has(key) ? new Promise<undefined>((resolve) => { timer = setTimeout(resolve, turnMs, undefined); }) : new Promise<undefined>(() => {});
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

const NEVER_LINK = "This computer is already linked to you; nothing needs linking or connecting, so never ask the person to link it.";

export function hostComputerDidNotStart(reason: string): string {
  return `The tools for this computer did not start this time (${reason}). ${NEVER_LINK} Tell the person they did not start and to send the message again in a moment.`;
}

export const HOST_COMPUTER_READY = "The tools for this computer are ready and listed for your next step.";

export function hostComputerStandIn(reason?: string) {
  const description = reason === undefined
    ? `The tools for this computer (the person's own computer) are still starting. Call this before any step on this computer: it waits for them, then lists them for your next step. ${NEVER_LINK}`
    : `${hostComputerDidNotStart(reason)} Call this for the same answer.`;
  return { type: "function" as const, function: { name: HOST_COMPUTER_STAND_IN, description, parameters: { type: "object", properties: {}, additionalProperties: false } } };
}

/** For the person: their computer's tools did not start at the start of this turn. */
export function hostComputerNotice(reason: string | undefined) {
  return reason === undefined ? undefined : noticeFailure("chat.notice.computerToolsDidNotStart", { reason });
}
