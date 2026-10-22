/** Canonical runtime-event shapes, as they ride the live wire and the
 * inspector log. */
import type { AskQuestion } from "./ask-question.ts";

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

export interface ModelVariantOption {
  id: string;
  label: string;
}

export interface ModelVariantState {
  options: ModelVariantOption[];
  currentValue?: string;
}

// A subset of upstream's ProviderRuntimeEvent union, sharing one base. `raw`
// carries the native protocol message behind the normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
  /** Text the provider's own client produced instead of the model (an API
   * error it reports as a reply). Rendered like any other item, but not a
   * sign that the model received or acted on the prompt. */
  synthetic?: boolean;
}

export type RuntimeEvent = RuntimeEventBase &
  (
    | {
        type: "session.started"; sessionId: string | null; model?: string | null;
        /** the provider refused the turn's resumeCursor and this new session
         * was started from the turn's recoveryText */
        rebuilt?: boolean;
      }
    | { type: "session.model-variants"; model: string; variants: ModelVariantState }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.retrying";
        /** 1-based: the retry about to be launched (1 = first relaunch). */
        attempt: number;
        delayMs: number;
        /** Why this failure was judged retry-worthy. */
        reason: string;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        /** THIS turn's token total, as the provider reports it at the end: the
         * one figure the harness accumulates. thread.token-usage.updated means
         * something different per driver and must never be summed. */
        usage?: { input: number; output: number; cachedInput?: number };
      }
    | {
        /** A resumable terminal: the turn exhausted its model/tool budget and
         * a structured handoff was persisted. */
        type: "cap.exhausted";
        /** Absolute path to the persisted handoff for the dead turn. */
        handoffPath: string;
        /** What stopped the turn without a final answer. */
        reason: "cap";
      }
    | {
        type: "turn.wait_started";
        /** The computer resource this turn queued behind (e.g. "computer:box:bx_…"). */
        resource: string;
        /** Where this turn sat in the resource's arrival-ordered waitlist when
         * the wait began. */
        position?: number;
        /** Who held the computer when the wait began, if the holder was known. */
        holder?: { name: string; task?: string };
      }
    | {
        type: "turn.wait_ended";
        resource: string;
        holder?: { name: string; task?: string };
        /** How long the turn actually waited. */
        waitedMs: number;
        /** acquired: the claim landed; stopped: the turn was stopped or
         * cancelled while waiting; parked: the wait ceiling settled the turn
         * for resume; gave_up: only in older recorded logs. */
        outcome: "acquired" | "gave_up" | "parked" | "stopped";
      }
    | {
        type: "item.started";
        itemType: "tool" | "reasoning";
        title?: string;
        /** The shell command the call runs, on one redacted line of at most
         * 200 characters, for the chip and the Verify card. Absent for calls
         * that run no command (a Read, a fetch). */
        summary?: string;
        /** Bounded, redacted display preview; never raw tool arguments. */
        input?: string;
      }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean; output?: string }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    /** Provider-generated raster bytes, folded into the private attachment
     * store and never forwarded to renderer SSE. */
    | { type: "item.completed"; itemType: "assistant_image"; data: string; alt?: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        /** Complete native shell input and its effective working directory.
         * Used for exact-command grants; never reconstructed from a display
         * summary, tool title, or argv. Absent when either value is unknown. */
        command?: { command: string; cwd: string };
        /** The shell command line exactly as the engine sent it, even when `command` is absent for want of a cwd.
         * Read only by the safety floor; no grant is ever made from it, and like `command` it is never broadcast. */
        commandLine?: string;
        choices?: string[];
        /** A provider's structured ask (Claude's AskUserQuestion): the whole
         * set of questions, each with its own options, so the card can offer
         * them instead of an Allow/Deny a person cannot answer. */
        questions?: AskQuestion[];
        /** "tool" (or absent): a harness tool call; "output": a block parsed
         * from model-authored final output. Untrusted-input rules apply either
         * way. */
        origin?: "tool" | "output";
        approvalScope?: "local-computer";
        /** Provider asks to widen its configured sandbox. Only explicit Full
         * access may answer this automatically; Auto/remembered grants may not. */
        requiresExplicitApproval?: boolean;
        /** Whether the provider's own automatic reviewer was running when it
         * raised this request. Claude reports its effective permission mode in
         * its init frame and silently starts in Manual when Auto is unavailable
         * for the model. "inactive": the app's own safe-Auto rules may answer;
         * unset: nobody knows. */
        nativeReview?: "active" | "inactive";
        /** The provider can keep an allow for the rest of its session
         * ("Always allow this session"): Claude through its own suggested
         * permission rules, ACP agents through `allow_always` or the
         * driver's per-session memory. Unset when answers are one-shot. */
        allowSession?: boolean;
      }
    | {
        type: "request.resolved";
        behavior: "allow" | "deny" | "answer";
        /** who decided: a person, auto mode, the ask's own timeout, the
         * harness (turn ended / settings changed), or nobody — the answerer
         * was already gone and the action never ran */
        source: "user" | "auto" | "timeout" | "system" | "unavailable" | "peer";
        approvalScope?: "local-computer";
      }
    | {
        type: "thread.token-usage.updated"; input: number; output: number; cachedInput?: number;
        /** What the model's window held on the most recent model call — the
         * whole prompt, cache reads included — and the window's size when the
         * driver knows it. The figure that predicts the next message's cost. */
        contextTokens?: number; contextWindow?: number;
        /** The part of `output` spent reasoning, where the engine reports it. A per-call report carries the call's own
         * message id in `itemId`, repeated on every frame of that call. */
        reasoning?: number;
      }
    // `setup`: fixed by installing or configuring something, not by retrying.
    // `terminal`: the complete turn failed, not a transient error.
    // `claudeUpdate`: this Claude Code is too old for the model.
    // `trialCredit`: the trial's Claude credit refused the call.
    // `stalled`: the engine went silent and the turn was stopped as stuck.
    // `limitResetsAt`: epoch ms when the usage limit refusing this account resets, when the engine says.
    | { type: "runtime.error"; message: string; setup?: boolean; terminal?: boolean; claudeUpdate?: boolean; trialCredit?: "used_up" | "ended" | "paused" | "too_low";
        stalled?: boolean; limitResetsAt?: number }
    /** Something the person should know that did not fail the turn — for
     * example, a saved model the engine no longer offers was replaced. */
    | { type: "runtime.notice"; message: string }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;
