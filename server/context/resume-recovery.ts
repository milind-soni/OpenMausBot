// Deciding whether a turn may be sent a second time.
//
// When a native session cannot be resumed, the harness still holds the
// canonical transcript and can rebuild the conversation. The question is not
// whether it CAN — it is whether doing so is safe. If the provider already
// accepted the prompt, the model may have run tools, written files, or sent
// messages. Replaying that turn would do it all again.
//
// So the boundary is classified from the driver's own protocol state — which
// request was in flight, whether the prompt was submitted, whether anything
// streamed — and never from error text. Provider error strings are prose:
// they get reworded between releases, they are localized, and a retry
// decision that turns on a regex over them is a duplicate side effect
// waiting for a vendor copy-edit.
import type { TurnContextPlan } from "./types.ts";

export type ResumeFailureClass =
  /** the session was rejected before the provider saw the prompt. The turn
   * has caused nothing, so it is safe to start fresh and send it once. */
  | "before-accept"
  /** the provider had the prompt. It may already have acted on it. */
  | "after-accept"
  /** the driver cannot prove which side of the boundary it is on. Treated
   * exactly like after-accept: an unproven guess is not a licence to repeat
   * side effects. */
  | "unknown";

export interface ResumeAttemptState {
  /** the provider was asked to continue an existing session. */
  attempted: boolean;
  /** that request came back rejected, or returned nothing usable. */
  rejected: boolean;
  /** the user's prompt has been handed to the provider. */
  promptSubmitted: boolean;
  /** the provider emitted any turn-scoped output — text, reasoning, a tool
   * call, usage. Output means the prompt was not merely accepted but acted
   * on, whatever the driver believes about its own submission bookkeeping. */
  producedOutput: boolean;
}

export function classifyResumeFailure(state: ResumeAttemptState): ResumeFailureClass {
  // Output is the strongest evidence available and outranks everything: if
  // the model spoke, the prompt landed.
  if (state.producedOutput || state.promptSubmitted) return "after-accept";
  if (state.attempted && state.rejected) return "before-accept";
  return "unknown";
}

/** Whether this failure may be recovered by sending the turn again. */
export function mayReplay(failure: ResumeFailureClass): boolean {
  return failure === "before-accept";
}

export interface RecoveryPromptInput {
  /** the turn's context plan, when dispatch supplied one. */
  plan: TurnContextPlan | undefined;
  /** what the driver would otherwise send. */
  currentText: string;
  failure: ResumeFailureClass;
}

export interface RecoveryPrompt {
  text: string;
  /** true when history was rebuilt into the prompt. */
  replayed: boolean;
}

/** The prompt a recovered turn should carry.
 *
 * A fresh session started after a rejected resume has NO history: sending
 * only the current message drops the entire conversation silently, which
 * looks to the user like the bot forgot everything. The replay prompt is the
 * rebuild, and it already contains the current message exactly once. */
export function recoveryPromptFor(input: RecoveryPromptInput): RecoveryPrompt {
  if (!mayReplay(input.failure)) return { text: input.currentText, replayed: false };
  const replay = input.plan?.replayPrompt?.trim();
  // No plan, or a plan with nothing to replay (a thread whose only history
  // is the message being sent): the current text is already the whole turn.
  if (!replay || replay === input.currentText.trim()) return { text: input.currentText, replayed: false };
  return { text: replay, replayed: true };
}
