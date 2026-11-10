// What a refused chat-completions response means, in the order the turn reacts to it. Kept out of
// openai-chat.ts, which sits at its size ratchet.

import type { EffortLevel } from "../../shared/wire.ts";
import { noteKeyRejected, rejectsKey } from "../key-rejections.ts";
import { refusesRequestSize, RequestTooLargeError } from "./chat-size-limit.ts";
import { httpErrorDetail, refusedToolCall, refusesReasoningEffort, rejectsReasoningReplay, rejectsToolsParameter, RejectedToolCallError, UnsupportedChatToolsError, UnsupportedReasoningEffortError, UnsupportedReasoningReplayError } from "./openai-chat-refusals.ts";
import { ModelRouteRefused, routeRefusal, type ModelRoute } from "./openai-responses.ts";

export interface ChatFailureContext {
  /** The endpoint's name, as it appears at the front of an HTTP error. */
  label: string;
  route: ModelRoute;
  apiUrl: string;
  apiKey: string;
  /** Size of the body that was refused, for a provider that rejects the request itself. */
  payloadBytes: number;
  /** Whether the request listed tools, so a refusal can name the route as unsupported. */
  offersTools: boolean;
  /** The reasoning effort this request asked for, if any. */
  effort?: EffortLevel;
  /** Whether the request replayed reasoning, so a refusal of it is the provider's, not the bot's. */
  replaysReasoning: boolean;
}

/** Build the classifier for a refused response: each check names the error the turn knows how to recover from. */
export function classifyFailure(context: ChatFailureContext): (status: number, body: string) => Error {
  return (status, body) => {
    const message = `${context.label} HTTP ${status}${body ? `: ${httpErrorDetail(body)}` : ""}`;
    const refused = context.offersTools ? routeRefusal(context.route, status, body) : null;
    if (refused) return new ModelRouteRefused(refused, message);
    if (rejectsKey(status, body)) noteKeyRejected(context.apiUrl, context.apiKey);
    if (refusesRequestSize(status, body)) return new RequestTooLargeError(message, context.payloadBytes);
    if (context.effort && refusesReasoningEffort(status, body)) return new UnsupportedReasoningEffortError(message);
    if (rejectsToolsParameter(status, body)) return new UnsupportedChatToolsError(message);
    const refusal = refusedToolCall(status, body);
    if (refusal) return new RejectedToolCallError(message, refusal);
    if (context.replaysReasoning && rejectsReasoningReplay(status, body)) return new UnsupportedReasoningReplayError(message);
    return new Error(message);
  };
}
