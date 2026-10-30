import { TurnAuthenticationRefusedError, TurnUsageLimitRefusedError, type RuntimeEvent, type SendTurnInput } from "../contracts.ts";
import { classifyError, USAGE_LIMIT } from "./retry.ts";

type Frame = {
  type?: string; subtype?: string; error?: unknown; is_api_error_message?: unknown; api_error?: unknown;
  is_error?: unknown; isReplay?: unknown; total_cost_usd?: unknown;
  message?: { model?: unknown; content?: unknown };
};
type Refusal = { text: string; kind: "auth" | "limit"; said?: string; resetsAt?: number; scope?: "engine" | "model" | "credits" };
type Pending = { refusal?: Refusal; refused?: boolean; buffered: RuntimeEvent[]; settle: (error?: Error) => void };

/** Only CLI-marked API errors count; assistant prose about signing out does not. */
export function claudeAuthFailure(frame: { error?: unknown; is_api_error_message?: unknown }, text: string): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return frame.error === "authentication_failed" || classifyError({ text }).reason === "auth";
}

/** Claude Code 2.1.295 refuses a signed-out turn with an `authentication_failed` error, and a turn past its usage limit
 * with a `usage_limit_reached` api error (a `rate_limit` error), each as a synthetic api-error frame. */
function syntheticRefusal(frame: Frame): Refusal | undefined {
  const content = frame.message?.content;
  if (frame.type !== "assistant" || frame.message?.model !== "<synthetic>" ||
      frame.is_api_error_message !== true || !Array.isArray(content) || content.length === 0 ||
      !content.every(block => block?.type === "text" && typeof block.text === "string")) return undefined;
  const text = content.map(block => block.text).join("");
  if (frame.error === "authentication_failed") return { text, kind: "auth" };
  if (frame.api_error === "usage_limit_reached" || (frame.error === "rate_limit" && USAGE_LIMIT.test(text))) return { text, kind: "limit" };
}

// Claude Code 2.1.296 sends `system/status "requesting"` before a signed-out refusal, and 2.1.272 a `rate_limit_event`
// before a usage-limit one; none of them, nor init, is model activity.
const preamble = (frame: Frame) =>
  frame.type === "system" && (frame.subtype === "init" || frame.subtype === "status") || frame.type === "user" && frame.isReplay === true ||
  frame.type === "rate_limit_event";

const refusedStop = { auth: "auth_required", limit: "quota" } as const;

/** Holds a recoverable turn's ACK and events until its first model activity, so a signed-out or usage-limit refusal
 * rejects it once its process has stopped. */
export function claudeAuthRecovery(
  publish: (event: RuntimeEvent) => void,
  retire: (threadId: string) => Promise<boolean>,
  busy: (threadId: string) => boolean,
) {
  const pending = new Map<string, Pending>();
  const accept = (threadId: string, held: Pending) => {
    if (pending.get(threadId) !== held) return;
    pending.delete(threadId);
    held.settle();
    for (const event of held.buffered) publish(event);
  };
  return {
    frame(threadId: string, frame: Frame, priorCost?: number | null) {
      const held = pending.get(threadId);
      if (!held || preamble(frame)) return;
      const refusal = syntheticRefusal(frame);
      if (refusal) held.refusal = refusal;
      else if (held.refusal && frame.type === "result" && frame.is_error === true &&
          (frame.total_cost_usd === undefined || frame.total_cost_usd === 0 || frame.total_cost_usd === priorCost)) held.refused = true;
      else accept(threadId, held);
    },
    emit(event: RuntimeEvent) {
      const held = pending.get(event.threadId);
      if (!held || event.type === "turn.started" || event.type === "session.started") return publish(event);
      const refusal = held.refusal;
      if (refusal?.kind === "auth" && event.type === "runtime.error" && event.setup && event.message === refusal.text) return void held.buffered.push(event);
      if (refusal?.kind === "limit" && event.type === "runtime.error" && !event.setup) {
        Object.assign(refusal, { said: event.message, resetsAt: event.limitResetsAt, scope: event.limit });
        return void held.buffered.push(event);
      }
      if (refusal && held.refused && event.type === "turn.completed" && !event.ok && event.stopReason === refusedStop[refusal.kind] && typeof event.turnId === "string") {
        const turnId = event.turnId;
        held.buffered.push(event);
        return void retire(event.threadId).then(stopped => {
          if (pending.get(event.threadId) !== held) return;
          if (!stopped) return accept(event.threadId, held);
          pending.delete(event.threadId);
          held.settle(refusal.kind === "auth" ? new TurnAuthenticationRefusedError(turnId, refusal.text)
            : new TurnUsageLimitRefusedError(turnId, refusal.said ?? refusal.text, refusal.resetsAt, refusal.scope));
        }, () => accept(event.threadId, held));
      }
      accept(event.threadId, held);
      publish(event);
    },
    async send(turn: SendTurnInput, dispatch: (turn: SendTurnInput) => Promise<{ turnId: string }>) {
      if (!turn.startupRecovery || pending.has(turn.threadId) || busy(turn.threadId)) return dispatch(turn);
      let settle!: Pending["settle"];
      const done = new Promise<void>((resolve, reject) => { settle = error => error ? reject(error) : resolve(); });
      void done.catch(() => {});
      const held: Pending = { buffered: [], settle };
      pending.set(turn.threadId, held);
      try {
        const result = await dispatch(turn);
        await done;
        return result;
      } catch (error) {
        accept(turn.threadId, held);
        throw error;
      }
    },
  };
}
