import type { Message } from "./store.ts";
import { z } from "zod";

const sendIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/).optional();

/** Parse an optional client-generated identity at the HTTP boundary. */
export function parseSendId(value: string | null | undefined): string | undefined {
  const parsed = sendIdSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error("sendId must be a client-generated id"), { status: 400 });
  }
  return parsed.data;
}

export type AcceptedSendMatch =
  | { kind: "none" }
  | { kind: "match"; message: Message }
  | { kind: "conflict" };

/** Match a retry to the canonical user message already persisted for it. */
export function acceptedSendMatch(
  messages: Message[],
  sendId: string,
  text: string,
  replyToId?: string,
  channelMode?: "chat" | "goal",
): AcceptedSendMatch {
  const message = messages.find((candidate) => candidate.sendId === sendId);
  if (!message) return { kind: "none" };
  if (
    message.role !== "user" ||
    message.kind !== "text" ||
    message.text !== text ||
    message.replyToId !== replyToId ||
    (message.channelMode ?? "chat") !== (channelMode ?? "chat")
  ) {
    return { kind: "conflict" };
  }
  return { kind: "match", message };
}

/** Coalesces simultaneous retries onto the first request's exact outcome. */
export class SendSequencer {
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<unknown> }>();

  async run<T>(
    key: string | undefined,
    fingerprint: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!key) return work();
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
      }
      // SAFETY: one key identifies one HTTP endpoint receipt, so every
      // coalesced caller has the same result contract as the owner.
      return existing.result as Promise<T>;
    }
    const current = work();
    const entry = { fingerprint, result: current };
    this.inFlight.set(key, entry);
    const clear = () => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    };
    void current.then(clear, clear);
    return current;
  }
}

export function sendFingerprint(text: string, replyToId?: string, channelMode?: "chat" | "goal"): string {
  return JSON.stringify([text, replyToId ?? null, channelMode ?? null]);
}
