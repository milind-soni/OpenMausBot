// A send shows at once as an optimistic user message; the server's copy, which carries the same sendId, replaces it.
import { ApiError } from "./api";
import type { Message } from "./store";

export const optimisticMessageId = (sendId: string): string => `optimistic-${sendId}`;

export function optimisticUserMessage(
  text: string,
  sendId: string,
  replyToId?: string,
  parentId?: string | null,
  channelMode?: "chat" | "goal",
): Message {
  return {
    id: optimisticMessageId(sendId),
    role: "user",
    kind: "text",
    text,
    at: Date.now(),
    parentId: parentId ?? null,
    replyToId,
    sendId,
    channelMode,
  };
}

/** Whether the server's copy of a send is in these messages. */
export function sendArrived(messages: readonly Message[] | undefined, sendId: string): boolean {
  return Boolean(messages?.some((message) => message.sendId === sendId && message.id !== optimisticMessageId(sendId)));
}

export const LOST_SEND_RETRY_MS = [1_000, 3_000] as const;

/** A send whose answer was lost may still have reached the server. It is asked again with the same sendId, which the
 * server never delivers twice, until it answers, refuses, or its copy arrives on the live stream. */
export async function sendReconciled<T>(
  post: () => Promise<T>,
  arrived: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ body: T } | { arrived: true }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { body: await post() };
    } catch (error) {
      const lost = !(error instanceof ApiError) && (error as { name?: unknown } | null)?.name !== "AbortError";
      if (!lost) throw error;
      if (arrived()) return { arrived: true };
      const delay = LOST_SEND_RETRY_MS[attempt];
      if (delay === undefined) throw error;
      await wait(delay);
      if (arrived()) return { arrived: true };
    }
  }
}
