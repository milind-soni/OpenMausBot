// A deterministic model for exercising the owned loop without a provider.
//
// This is a test fixture that must produce exactly what the Pi agent core
// consumes, so it is the one file besides pi-runtime.ts that imports Pi.
// It scripts responses in order; each call to the stream function consumes
// the next one and records the context it was shown, so a test can assert
// both what the loop did and what the model saw.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeResponse {
  text?: string;
  reasoning?: string;
  toolCalls?: FakeToolCall[];
  /** fail this call instead of answering. */
  error?: string;
  usage?: { input: number; output: number };
  /** hold the stream open until the signal aborts — for cancellation tests. */
  hang?: boolean;
}

export interface FakeModel {
  streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ReturnType<typeof createAssistantMessageEventStream>;
  /** every context the model was shown, in order. */
  calls: Context[];
  /** the api key each call was given, so a test can prove it arrived
   * explicitly and only there. */
  keys: Array<string | undefined>;
}

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Split text into two deltas so streaming order is actually exercised. */
const halves = (text: string): string[] => {
  if (text.length < 2) return [text];
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
};

export function makeFakeModel(script: FakeResponse[]): FakeModel {
  const queue = [...script];
  const fake: FakeModel = { calls: [], keys: [], streamFn: undefined as never };

  fake.streamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    // Snapshot, never the reference: the agent core appends its own reply
    // to context.messages after the call, and a test asserting what the
    // model was SHOWN must not see what it went on to say.
    fake.calls.push({ ...context, messages: [...context.messages] });
    fake.keys.push(options?.apiKey);
    const response = queue.shift() ?? { text: "(script exhausted)" };
    const signal = options?.signal;

    const base = (): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const fail = (reason: "aborted" | "error", message: string) => {
      const error = base();
      error.stopReason = reason;
      error.errorMessage = message;
      stream.push({ type: "error", reason, error });
      stream.end(error);
    };

    queueMicrotask(() => {
      if (signal?.aborted) return fail("aborted", "aborted before start");
      if (response.hang) {
        signal?.addEventListener("abort", () => fail("aborted", "aborted while streaming"), { once: true });
        return;
      }
      if (response.error) return fail("error", response.error);

      const message = base();
      stream.push({ type: "start", partial: message });

      if (response.reasoning) {
        stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
        for (const delta of halves(response.reasoning)) {
          stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: message });
        }
        message.content.push({ type: "thinking", thinking: response.reasoning });
        stream.push({ type: "thinking_end", contentIndex: 0, content: response.reasoning, partial: message });
      }
      if (response.text) {
        const index = message.content.length;
        stream.push({ type: "text_start", contentIndex: index, partial: message });
        for (const delta of halves(response.text)) {
          stream.push({ type: "text_delta", contentIndex: index, delta, partial: message });
        }
        message.content.push({ type: "text", text: response.text });
        stream.push({ type: "text_end", contentIndex: index, content: response.text, partial: message });
      }
      for (const [i, call] of (response.toolCalls ?? []).entries()) {
        const index = message.content.length;
        const id = `call-${fake.calls.length}-${i}`;
        stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
        message.content.push({ type: "toolCall", id, name: call.name, arguments: call.args });
        stream.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: { type: "toolCall", id, name: call.name, arguments: call.args },
          partial: message,
        });
      }
      if (response.usage) {
        message.usage.input = response.usage.input;
        message.usage.output = response.usage.output;
        message.usage.totalTokens = response.usage.input + response.usage.output;
      }
      message.stopReason = response.toolCalls?.length ? "toolUse" : "stop";
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });

    return stream;
  };

  return fake;
}
