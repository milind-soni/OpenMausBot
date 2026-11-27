// What the ACP driver keeps for each thread: its session on an agent process (alone or shared with other threads'
// sessions) and the turn running in it.
import type { RequestOutcome, SendTurnInput } from "../../contracts.ts";
import type { spawnCli } from "../../procs.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { errorReplyFailure, type ErrorReplyFailure } from "../engine-errors.ts";
import type { AcpConfig } from "./core.ts";
import type { AcpDriverHooks } from "./driver-hooks.ts";
import type { AcpHost, AcpLink } from "./host.ts"; import type { AppliedConfig } from "./applied-config.ts";
import type { AcpTurnSteering } from "./steer.ts";

export type AcpAskFinish = (
  behavior: string,
  source?: "user" | "timeout" | "system",
  message?: string,
  always?: boolean,
) => RequestOutcome;

export interface AcpTurn {
  turnId: string;
  turn: SendTurnInput;
  turnConfig: AcpConfig;
  controlsHost: boolean;
  state: {
    settled: boolean; promptSent: boolean; text: string; textMessageId: string | null; producedItem: boolean; repliedText: boolean; startupActivity: boolean; stopped: boolean;
    /** A tool call ended, and no reply reached the chat since (text or image). The turn still runs, but its end is wordless. */
    toolsSinceShown: boolean;
    /** Reasoning streamed in that wordless window, and no reply followed it: the model was answering and never landed it. */
    thoughtSinceTool: boolean;
    usagePeak: number | null;
    usageLast: number | null;
    usageCompacted: boolean;
    /** A chunk the driver read as a failed model call, kept out of `text` while it is the agent's last words. */
    failedChunk: { chunk: string; failure: string } | null;
    /** Stop went unanswered: only the cancel timeout settles the turn, once its session is closed or its process gone. */
    cancelling: boolean;
  };
  acknowledge: () => void;
  asks: Map<string, AcpAskFinish>;
  /** Tool calls started and not yet finished: a tool such as `sleep` sends nothing while it runs. */
  runningTools: Set<string>;
  unkeyedToolIds: string[];
  endedToolIds: Set<string>;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  stopQuietWatch: (() => void) | null;
  flushAssistantText: () => void;
  receiveModelVariants: (result: any) => void;
  steering?: AcpTurnSteering;
}

export interface AcpSession {
  child: ReturnType<typeof spawnCli>;
  host: AcpHost;
  acp: AcpLink;
  launch: { command: string; args?: string[] };
  env: Record<string, string | undefined>;
  cwd: string;
  contractKey: string;
  /** mcpServers the native session was built with. They ride session/new and session/load, not argv,
   *  and bearer tokens rotate every turn, so a change re-establishes the session on the same child. */
  sessionKey: string | null;
  sessionId: string | null;
  sessionConfigResult: any;
  /** Monotonic counter incremented on live `current_mode_update` notifications so an in-flight `session/set_mode` response cannot overwrite a newer server update. */
  modeVersion: number;
  initResult: any;
  authenticated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The config option values this live session confirmed, so an unchanged one is not sent again. */
  appliedConfig: AppliedConfig;
  closing: boolean;
  /** Set when a shared process's session closes through `session/close`: true once the agent confirms it. */
  closeConfirmed?: Promise<boolean>;
  dead: boolean;
  readonly stderr: string;
  current: AcpTurn | null;
  /** When a turn of ours last settled on this session. */
  settledAt?: number;
  /** The slash commands the agent last advertised for this session. */
  commands?: ReadonlySet<string>;
  fallbackNotice?: string;
  launchModel?: string;
  /** The effort the session runs: its process's launch argv's, or the last one configureSession applied. */
  effort?: SendTurnInput["effort"];
}

/** A `tool_call` without a status is pending (ACP's default); a `tool_call_update` without one leaves the call as it was. */
export function trackRunningTool(current: AcpTurn, update: { toolCallId?: unknown; status?: unknown }, defaultStatus?: "pending"): void {
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return;
  const status = update.status ?? defaultStatus;
  if (status === "completed" || status === "failed") current.runningTools.delete(update.toolCallId);
  else if (status === "pending" || status === "in_progress") current.runningTools.add(update.toolCallId);
}

/** Adds a text chunk to the unsent reply and gives the text to stream. A chunk `read` names a failed model call is held
 * back from both, so no flush sends it; later words return it ahead of themselves, as it was not the agent's last. */
export function receiveText(state: AcpTurn["state"], delta: string, read: AcpDriverHooks["replyFailure"]): string {
  const released = state.failedChunk?.chunk ?? "";
  const failure = read?.(delta) ?? null;
  state.failedChunk = failure === null ? null : { chunk: delta, failure };
  const received = failure === null ? released + delta : released;
  state.text += received;
  return received;
}

/** Words the person can see: the turn has replied, and the wordless window after a tool is closed. */
export function trackAssistantWords(state: AcpTurn["state"]): void {
  state.producedItem = true;
  state.repliedText = true;
  state.toolsSinceShown = false;
  state.thoughtSinceTool = false;
}

/** An assistant image is itself a reply the person sees, so it closes the wordless window after a tool. */
export function trackAssistantImage(state: AcpTurn["state"]): void {
  state.producedItem = true;
  state.toolsSinceShown = false;
  state.thoughtSinceTool = false;
}

/** A tool end that is actually emitted opens the wordless window; a repeat that names an already-ended tool emits nothing. */
export function trackToolEndShown(state: AcpTurn["state"]): void {
  state.producedItem = true;
  state.toolsSinceShown = true;
  state.thoughtSinceTool = false;
}

/** Reasoning in the wordless window: if no reply lands after it, the turn ends midstream and the person sees nothing. */
export function trackThoughtAfterTool(state: AcpTurn["state"]): void {
  if (state.toolsSinceShown) state.thoughtSinceTool = true;
}

export interface AcpTurnEnd {
  ok: boolean;
  stopReason: string | null;
  error?: Omit<ErrorReplyFailure, "stopReason">;
}

/** How a settling turn ends, once its last text is out. A Stop the agent answers with end_turn (OpenCode does) is the
 * person's stop. A reply that is only a provider's error body fails the turn in plain words. Otherwise `end_turn` with
 * nothing to show is a lost turn: a provider may cut a reasoning-only stream and still answer end_turn, and a turn that
 * was talking, then streamed reasoning after its tools without landing a reply after it, went out midstream. Tool-only
 * turns that never said anything, and turns that plainly end on their tools, stay successes. */
export function endTurn(current: AcpTurn, ok: boolean, stopReason: string | null, ai: string): AcpTurnEnd {
  const ended = ok && stopReason === null;
  const errorReply = ended && !current.state.stopped && !current.state.repliedText ? errorReplyFailure(ai, current.state.text) : null;
  if (!errorReply) current.flushAssistantText();
  if (ended && current.state.stopped) return { ok, stopReason: "cancelled" };
  if (errorReply) {
    const { stopReason: failed, ...error } = errorReply;
    return { ok: false, stopReason: failed, error };
  }
  if (ended && !current.state.producedItem) return { ok: false, stopReason: "empty_turn", error: noticeFailure("chat.notice.acpEmpty", { provider: ai }) };
  if (ended && current.state.repliedText && current.state.thoughtSinceTool) return { ok: false, stopReason: "ended_after_tools", error: noticeFailure("chat.notice.acpEndedAfterTools", { provider: ai }) };
  return { ok, stopReason };
}
