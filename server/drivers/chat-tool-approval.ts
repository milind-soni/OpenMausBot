// Per-turn ask gate, adapted from the approval lifecycle in #780.
// Register before publishing: a harness listener may answer synchronously.
import { newId, type RequestOutcome } from "../contracts.ts";
import type { AskQuestion } from "../../shared/ask-question.ts";

/** `grant`: what "Always allow this session" on this card would keep allowed
 * (ChatToolCallView.grant). Absent when the card can only allow once. */
interface Ask { id: string; tool: string; summary: string; grant?: string }
type Source = "user" | "timeout" | "system";

interface Card {
  kind: "permission" | "question";
  ask: Ask;
  /** Exactly-once: a second finish is a no-op because the card left the map. */
  finish(source: Source, decision?: { allowed?: boolean; always?: boolean; message?: string }): void;
}

export function createChatToolApproval(options: {
  signal: AbortSignal;
  open(ask: Ask): void;
  resolved(ask: Ask, allowed: boolean, source: Source): void;
  openQuestion(ask: Ask, questions: AskQuestion[]): void;
  resolvedQuestion(ask: Ask, answered: boolean, source: Source): void;
  /** The conversation's "Always allow this session" grants. The driver keeps
   * the set across the conversation's turns; an ask it covers is allowed
   * without a card, as Claude and ACP agents do with their own. */
  granted?: Set<string>;
  timeoutMs?: number;
}) {
  const pending = new Map<string, Card>();
  let closed = false;
  return {
    ask(tool: string, summary: string, grant?: string): Promise<boolean> {
      if (closed || options.signal.aborted) return Promise.resolve(false);
      if (grant !== undefined && options.granted?.has(grant)) return Promise.resolve(true);
      const ask: Ask = { id: newId(), tool, summary, ...(grant !== undefined && options.granted ? { grant } : {}) };
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const card: Card = {
          kind: "permission",
          ask,
          finish(source, decision) {
            if (!pending.delete(ask.id)) return;
            clearTimeout(timer);
            options.signal.removeEventListener("abort", abort);
            const allowed = decision?.allowed === true;
            if (allowed && decision?.always && ask.grant !== undefined) options.granted?.add(ask.grant);
            options.resolved(ask, allowed, source);
            resolve(allowed);
          },
        };
        const abort = () => card.finish("system");
        timer = setTimeout(() => card.finish("timeout"), options.timeoutMs ?? 15 * 60_000);
        timer.unref?.();
        pending.set(ask.id, card);
        options.signal.addEventListener("abort", abort, { once: true });
        options.open(ask);
      });
    },
    question(tool: string, summary: string, questions: AskQuestion[]): Promise<string | null> {
      if (closed || options.signal.aborted) return Promise.resolve(null);
      const ask = { id: newId(), tool, summary };
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const card: Card = {
          kind: "question",
          ask,
          finish(source, decision) {
            if (!pending.delete(ask.id)) return;
            clearTimeout(timer);
            options.signal.removeEventListener("abort", abort);
            // Only the person's reply resolves a question; a timeout or
            // abort resolves null so no system note can occupy the answer
            // slot the model reads as the person's words.
            const reply = typeof decision?.message === "string" && decision.message.length > 0 ? decision.message : null;
            options.resolvedQuestion(ask, reply !== null, source);
            resolve(reply);
          },
        };
        const abort = () => card.finish("system");
        timer = setTimeout(() => card.finish("timeout"), options.timeoutMs ?? 15 * 60_000);
        timer.unref?.();
        pending.set(ask.id, card);
        options.signal.addEventListener("abort", abort, { once: true });
        options.openQuestion(ask, questions);
      });
    },
    answer(id: string, behavior: "allow" | "deny" | "answer", message?: string, always?: boolean): RequestOutcome {
      const card = pending.get(id);
      if (!card || options.signal.aborted) return "unavailable";
      if (behavior === "deny") {
        card.finish("user");
        return "rejected";
      }
      if (card.kind === "permission") {
        // An answer is not a permission: only allow or deny settles it.
        if (behavior !== "allow") return "unavailable";
        card.finish("user", { allowed: true, always: always === true });
        return "allowed-once";
      }
      // And an allow is not an answer: a question settles only on a real
      // reply, never a blank the model would have to interpret.
      if (behavior === "answer" && typeof message === "string" && message.trim()) {
        card.finish("user", { message });
        return "answered";
      }
      return "unavailable";
    },
    close() {
      closed = true;
      for (const card of pending.values()) card.finish("system");
    },
  };
}
