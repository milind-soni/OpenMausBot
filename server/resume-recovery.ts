// Replay safety is classified from the driver's protocol state, never from provider error text (reworded, localized).

export type ResumeFailureClass =
  | "before-accept"
  | "after-accept"
  /** Treated exactly like after-accept: an unproven guess is not a licence to repeat side effects. */
  | "unknown";

export interface ResumeAttemptState {
  attempted: boolean;
  rejected: boolean;
  promptSubmitted: boolean;
  producedOutput: boolean;
}

export function classifyResumeFailure(state: ResumeAttemptState): ResumeFailureClass {
  if (state.producedOutput || state.promptSubmitted) return "after-accept";
  if (state.attempted && state.rejected) return "before-accept";
  return "unknown";
}

export function mayReplay(failure: ResumeFailureClass): boolean {
  return failure === "before-accept";
}

export interface RecoveryPromptInput {
  recoveryText: string | undefined;
  currentText: string;
  failure: ResumeFailureClass;
}

export interface RecoveryPrompt {
  text: string;
  replayed: boolean;
}

export function recoveryPromptFor(input: RecoveryPromptInput): RecoveryPrompt {
  if (!mayReplay(input.failure)) return { text: input.currentText, replayed: false };
  const replay = input.recoveryText?.trim();
  if (!replay || replay === input.currentText.trim()) return { text: input.currentText, replayed: false };
  return { text: replay, replayed: true };
}

export function rebuiltSessionNotice(engine: string): string {
  return `${engine} could not reopen this conversation's session, so it went on in a new one started from the chat; results of earlier tool calls did not carry over.`;
}
