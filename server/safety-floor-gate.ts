// Applies the safety floor only where the server would allow a command with nobody looking. A card a person answers
// is never overridden; the floor is one more condition before an automatic allow. Inert on a Windows server, where
// too many lines need two shells to read. It cannot reach an engine that never asks: Claude Code under
// bypassPermissions, Codex with approvals off, an ACP agent in its own yolo mode.
import { homedir } from "node:os";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { AutoVerdict } from "./auto-approve.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import type { ProviderAdapter } from "./contracts.ts";
import { appendDecision } from "./decision-log.ts";
import { floorReading, type FloorRule } from "./safety-floor.ts";

/** Off by default. config.json `safetyFloor.enabled` or OMB_SAFETY_FLOOR=1 turns it on; the variable cannot turn it off. */
export function safetyFloorEnabled(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_SAFETY_FLOOR?.trim() === "1" || cfg.safetyFloor?.enabled === true;
}

/** Read per request, so a settings save applies to the next one. */
let config: () => AppConfig = () => ({});
let read: typeof floorReading = floorReading;
let host: NodeJS.Platform = process.platform;
let windowsNoticeGiven = false;

/** Binds the live config at startup. An enabled floor does nothing on Windows, so that is said once, not silently. */
export function bindSafetyFloor(provider: () => AppConfig, reader: typeof floorReading = floorReading, platform: NodeJS.Platform = process.platform): void {
  config = provider;
  read = reader;
  host = platform;
  if (host === "win32" && !windowsNoticeGiven && safetyFloorEnabled(config())) {
    windowsNoticeGiven = true;
    console.warn("[safety-floor] the safety floor is switched on, but it is not applied on a Windows server yet: no command is checked here");
  }
}

/** Whether the floor is in force now; always false on Windows. */
export function safetyFloorOn(): boolean {
  return host !== "win32" && safetyFloorEnabled(config());
}

export interface FloorBlock {
  /** `unreadable`: a command the floor could not read where nobody can be asked instead. */
  rule: FloorRule | "unreadable";
  label: string;
  /** The line a person sees. */
  line: string;
  /** What the engine is told in place of an approval. */
  reason: string;
}

function blockOf(rule: FloorBlock["rule"], label: string, advice: string): FloorBlock {
  const line = `Blocked by the safety floor: ${label}`;
  // The model reads `reason` as the tool result: it must report the block, not try a spelling the floor does not know.
  return { rule, label, line, reason: `${line}. ${advice}` };
}

let unreadableLogged = false;

/** A command the floor could not read is neither blocked nor clear. Off, or with no command, everything is clear. */
function finding(command: string | undefined): { state: "clear" } | { state: "blocked" | "unreadable"; block: FloorBlock } {
  if (!command || !safetyFloorOn()) return { state: "clear" };
  let reading: ReturnType<typeof floorReading>;
  try {
    reading = read(command, host, homedir());
  } catch {
    reading = { read: false };
  }
  if (reading.read) {
    return reading.verdict
      ? { state: "blocked", block: blockOf(reading.verdict.rule, reading.verdict.label, "This command is never approved automatically, at any approval level. Do not retry it or look for another way to do the same thing; tell the person what you were trying to do.") }
      : { state: "clear" };
  }
  if (!unreadableLogged) {
    unreadableLogged = true;
    // Once, and without the command: its text may hold a credential.
    console.error("[safety-floor] A command could not be read, so nothing approved it automatically. Later ones are not logged.");
  }
  return { state: "unreadable", block: blockOf("unreadable", "a command it could not read", "Nothing approves a command automatically when the safety floor could not read it. Tell the person what you were trying to run so they can run it themselves.") };
}

/** The never-list block a command meets, or null; null for an unreadable command too. */
export function safetyFloorBlock(command: string | undefined): FloorBlock | null {
  const found = finding(command);
  return found.state === "blocked" ? found.block : null;
}

/** False for a never-list command and for one that could not be read. */
export function safetyFloorClears(command: string | undefined): boolean {
  return finding(command).state === "clear";
}

type PermissionRequest = Pick<Extract<RuntimeEvent, { type: "request.opened" }>, "threadId" | "tool" | "summary" | "command" | "commandLine"> & { turnId?: string };

/** Never the display summary: cut at 200 characters, a path can read as the directory above it. */
const commandLineOf = (event: PermissionRequest): string | undefined => event.commandLine ?? event.command?.command;

/** An automatic allow for a command the floor could not read becomes no answer, so a person decides on a card. */
export function heldAtSafetyFloor(event: PermissionRequest, verdict: AutoVerdict): AutoVerdict {
  return verdict.approve && finding(commandLineOf(event)).state === "unreadable" ? { approve: null, source: "safety-floor" } : verdict;
}

/** Call after a grant decides to allow and before the allow is delivered. True when the command is on the never-list:
 * it is already denied, announced and logged, and the caller must neither allow it nor show a card. */
export function denyAtSafetyFloor(input: {
  event: PermissionRequest;
  requestId: string;
  bot: { id: string; name: string };
  adapter: Pick<ProviderAdapter, "respondToRequest" | "interruptTurn"> | undefined;
  /** Whether the turn that asked is still the one running on its thread. */
  isCurrent: () => boolean;
  say: (message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } }) => unknown;
  /** Called once the request has been answered, or could not be. */
  release: () => void;
}): boolean {
  const { event, requestId, bot, adapter } = input;
  const block = safetyFloorBlock(commandLineOf(event));
  if (!block) return false;
  input.say({ role: "bot", kind: "activity", tool: { name: `notice: ${block.line}`, ok: true } });
  appendDecision(DATA_DIR, {
    threadId: event.threadId,
    requestId,
    botId: bot.id,
    botName: bot.name,
    tool: event.tool,
    summary: event.summary,
    decision: "auto-denied",
    source: "safety-floor",
    rule: block.rule,
  });
  void (async () => {
    try {
      await adapter?.respondToRequest(event.threadId, requestId, { behavior: "deny", message: block.reason });
    } catch {
      // No card was shown, so the engine would wait forever: stop the turn unless a newer one owns the thread.
      if (event.turnId && input.isCurrent()) await adapter?.interruptTurn(event.threadId, event.turnId).catch(() => {});
    }
    if (input.isCurrent()) input.release();
  })().catch(() => {
    // The denial is already on the transcript and in the decision log.
    console.error("[safety-floor] Could not finish delivering a denial.");
  });
  return true;
}

/** The string under `command` or `cmd`, as every mounted shell tool takes it. No other argument is read, so words
 * in a message or a file body are never a command. */
export function shellCommandOfToolCall(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** For a runtime about to run a tool call without asking anyone: the block, already logged, or null. An unreadable
 * command is refused too, since such a runtime has no card to fall back on. */
export function floorBlockForToolCall(call: {
  threadId: string;
  botId?: string;
  tool: string;
  /** The bounded, redacted preview of the call's arguments. */
  summary?: string;
  input: Record<string, unknown>;
}): FloorBlock | null {
  const found = finding(shellCommandOfToolCall(call.input));
  if (found.state === "clear") return null;
  appendDecision(DATA_DIR, {
    threadId: call.threadId,
    botId: call.botId,
    tool: call.tool,
    summary: call.summary,
    decision: "auto-denied",
    source: "safety-floor",
    rule: found.block.rule,
  });
  return found.block;
}
