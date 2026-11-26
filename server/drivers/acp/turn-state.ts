// What the ACP driver keeps for each thread: its session on an agent process (alone or shared with other threads'
// sessions) and the turn running in it.
import type { RequestOutcome, SendTurnInput } from "../../contracts.ts";
import type { spawnCli } from "../../procs.ts";
import { noticeFailure } from "../../chat-notices.ts";
import { errorReplyFailure, quotesErrorBody, type ErrorReplyFailure } from "../engine-errors.ts";
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

export type IncompleteEnding = "tool_call_fragment" | "announced_action";

const TOOL_CALL_TAIL_TAGS = ["</parameter>", "</invoke>", "<tool_call>"];
const ANNOUNCED_ACTION = /^(?:i['’]ll|running|now\s+i['’]ll|assigning)\s/i;

/** True when `s` opens a JSON value that never closes: quotes and escapes respected, only JSON
 * characters so far, still inside a string or container at the end, with a string or key seen. */
function unterminatedJson(s: string): boolean {
  let inString = false; let escape = false; let depth = 0; let evidence = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') { inString = true; evidence = true; }
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { if (--depth <= 0) return false; }
    else if (ch === ":") evidence = true;
    else if (!" \t\r\n,0123456789.+-eEtruefalsn".includes(ch)) return false;
  }
  return evidence && (inString || depth > 0);
}

/** True when the reply's tail is a JSON object or array: parsed to the very end, or cut off inside one. */
function endsOnTrailingJson(text: string): boolean {
  const tail = text.length > 2000 ? text.slice(-2000) : text;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] !== "{" && tail[i] !== "[") continue;
    const candidate = tail.slice(i);
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      if (unterminatedJson(candidate)) return true;
    }
  }
  return false;
}

/** True when the reply's end sits inside a ``` fence that never closed: a cut-off example block, not a leak. */
function endsInsideUnclosedFence(text: string): boolean {
  const fences = text.match(/```/g);
  return fences !== null && fences.length % 2 === 1;
}

function endsOnToolCallTag(text: string): boolean {
  const tail = text.slice(-64).toLowerCase();
  if (TOOL_CALL_TAIL_TAGS.some((tag) => tail.endsWith(tag))) return true;
  return /<parameter(?:\s[^<>]*)?>?$/i.test(text);
}

function announcesUnrunAction(text: string): boolean {
  const last = text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).findLast(Boolean) ?? "";
  return ANNOUNCED_ACTION.test(last);
}

/** How a reply ends without the work being done, when no tool ran in the turn: `tool_call_fragment` for a raw
 * tool-call tail (`</parameter>`, `</invoke>`, `<tool_call>`, an unclosed `<parameter`, a trailing JSON object or
 * array), `announced_action` for a last sentence announcing an action ("I'll run X") instead of reporting a result.
 * A reply ending inside an unclosed ``` fence reads as a cut-off example, not a leak. */
export function incompleteEnding(text: string, toolRan: boolean): IncompleteEnding | null {
  if (toolRan) return null;
  const trimmed = text.trimEnd();
  if (!trimmed || endsInsideUnclosedFence(trimmed)) return null;
  if (endsOnToolCallTag(trimmed) || endsOnTrailingJson(trimmed)) return "tool_call_fragment";
  if (announcesUnrunAction(trimmed)) return "announced_action";
  return null;
}

/** How a settling turn ends, once its last text is out. A Stop the agent answers with end_turn (OpenCode does) is the
 * person's stop. A reply that is only a provider's error body fails the turn in plain words. Otherwise `end_turn` with
 * nothing to show is a lost turn: a provider may cut a reasoning-only stream and still answer end_turn, and a turn that
 * was talking, then streamed reasoning after its tools without landing a reply after it, went out midstream. A turn
 * whose reply ends on a raw tool-call fragment, or whose last sentence announces an action no tool ran, fails too: the
 * model wrote the call as text or promised work it never did. Tool-only turns that never said anything, and turns that
 * plainly end on their tools, stay successes. */
export function endTurn(current: AcpTurn, ok: boolean, stopReason: string | null, ai: string): AcpTurnEnd {
  const ended = ok && stopReason === null;
  const failedBody = ended && !current.state.stopped ? errorReplyFailure(ai, current.state.text) : null;
  const errorReply = failedBody && !current.state.repliedText ? failedBody : null;
  const incomplete = ended && !current.state.stopped && !failedBody && !quotesErrorBody(current.state.text)
    ? incompleteEnding(current.state.text, current.runningTools.size > 0 || current.endedToolIds.size > 0)
    : null;
  if (!errorReply && !incomplete) current.flushAssistantText();
  if (ended && current.state.stopped) return { ok, stopReason: "cancelled" };
  if (errorReply) {
    const { stopReason: failed, ...error } = errorReply;
    return { ok: false, stopReason: failed, error };
  }
  if (incomplete === "tool_call_fragment") return { ok: false, stopReason: "tool_call_fragment", error: noticeFailure("chat.notice.acpToolCallFragment", { provider: ai }) };
  if (incomplete === "announced_action") return { ok: false, stopReason: "announced_action", error: noticeFailure("chat.notice.acpAnnouncedAction", { provider: ai }) };
  if (ended && !current.state.producedItem) return { ok: false, stopReason: "empty_turn", error: noticeFailure("chat.notice.acpEmpty", { provider: ai }) };
  if (ended && current.state.repliedText && current.state.thoughtSinceTool) return { ok: false, stopReason: "ended_after_tools", error: noticeFailure("chat.notice.acpEndedAfterTools", { provider: ai }) };
  return { ok, stopReason };
}
