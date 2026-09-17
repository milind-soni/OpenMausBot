/** Canonical runtime-event shapes, as they ride the live wire and the
 * inspector log. Single home in shared/ so the server contracts, the client
 * store, and the inspector panel cannot drift; server/contracts.ts and
 * server/thread-events.ts re-export these under their historical names. */
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

// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
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
        /** Why this failure was judged retry-worthy (classifyError's reason). */
        reason: string;
      }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        /** THIS turn's token total, as the provider reports it at the end.
         * The one figure the harness accumulates — thread.token-usage.updated
         * is a live indicator whose meaning differs per driver (a per-call
         * delta, a thread total, a per-step figure) and must never be summed. */
        usage?: { input: number; output: number; cachedInput?: number };
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
    /** Provider-generated raster bytes. This event is folded into the
     * private attachment store and is never forwarded to renderer SSE: a
     * multi-megabyte base64 result belongs in one durable message URL, not
     * duplicated through every connected window. */
    | { type: "item.completed"; itemType: "assistant_image"; data: string; alt?: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
        /** A provider's structured ask (Claude's AskUserQuestion): the whole
         * set of questions, each with its own options, so the card can offer
         * them instead of an Allow/Deny a person cannot answer. */
        questions?: AskQuestion[];
        approvalScope?: "local-computer";
        /** Provider asks to widen its configured sandbox. Only explicit Full
         * access may answer this automatically; Auto/remembered grants may not. */
        requiresExplicitApproval?: boolean;
        /** Whether the provider's own automatic reviewer was running when it
         * raised this request. Only providers that can tell set it: Claude
         * reports the effective permission mode in its init frame, and starts
         * in Manual without a word when Auto is unavailable for the model.
         * "inactive" means this ask is not a reviewer's verdict, so the app's
         * own safe-Auto rules may answer it; unset means nobody knows. */
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
      }
    // `setup: true` marks a failure the user fixes by installing or
    // configuring something, not by retrying — the UI offers setup instead.
    // `terminal: true` records failure of the complete turn, rather than a
    // transient error or a legacy provider's diagnostic during cancellation.
    | { type: "runtime.error"; message: string; setup?: boolean; terminal?: boolean }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

