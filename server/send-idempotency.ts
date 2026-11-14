import type { Message } from "./store.ts";
import { z } from "zod";

const sendIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/).optional();

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
      // SAFETY: one key is one endpoint receipt, so every coalesced caller shares the owner's result type.
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

/** A Stop's `stopId`: the same client-generated form as a `sendId`. Null when one is sent but malformed. */
export function parseStopId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const parsed = sendIdSchema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? parsed.data : null;
}

/** One answer per Stop. A phone resends a POST when its pooled connection dies, so a Stop it resends must not stop the
 * turn that started after the first one did: every resend of a key within `keepMs` gets the first one's answer. An
 * attempt that throws keeps no answer, so its resend runs again. */
export class StopReceipts<T> {
  private readonly receipts = new Map<string, { at: number; answer: Promise<T> }>();
  private readonly keepMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: { keepMs?: number; max?: number; now?: () => number } = {}) {
    this.keepMs = options.keepMs ?? 10 * 60_000;
    this.max = options.max ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  run(key: string | undefined, stop: () => Promise<T>): Promise<T> {
    if (!key) return stop();
    const now = this.now();
    for (const [old, receipt] of this.receipts) {
      if (now - receipt.at < this.keepMs) break;
      this.receipts.delete(old);
    }
    const kept = this.receipts.get(key);
    if (kept) return kept.answer;
    const entry = { at: now, answer: stop() };
    this.receipts.set(key, entry);
    if (this.receipts.size > this.max) this.receipts.delete(this.receipts.keys().next().value!);
    entry.answer.catch(() => {
      if (this.receipts.get(key) === entry) this.receipts.delete(key);
    });
    return entry.answer;
  }
}
