// Per-turn ask gate, adapted from the approval lifecycle in #780.
// Register before publishing: a harness listener may answer synchronously.
import { newId, type RequestOutcome } from "../contracts.ts";
import type { AskQuestion } from "../../shared/ask-question.ts";

interface Ask { id: string; tool: string; summary: string }
type Source = "user" | "timeout" | "system";

interface Card {
  kind: "permission" | "question";
  ask: Ask;
  /** Exactly-once: a second finish is a no-op because the card left the map. */
  finish(source: Source, decision?: { allowed?: boolean; message?: string }): void;
}

export function createChatToolApproval(options: {
  signal: AbortSignal;
  open(ask: Ask): void;
  resolved(ask: Ask, allowed: boolean, source: Source): void;
  openQuestion(ask: Ask, questions: AskQuestion[]): void;
  resolvedQuestion(ask: Ask, answered: boolean, source: Source): void;
  timeoutMs?: number;
}) {
  const pending = new Map<string, Card>();
  let closed = false;
  return {
    ask(tool: string, summary: string): Promise<boolean> {
      if (closed || options.signal.aborted) return Promise.resolve(false);
      const ask = { id: newId(), tool, summary };
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
    answer(id: string, behavior: "allow" | "deny" | "answer", message?: string): RequestOutcome {
      const card = pending.get(id);
      if (!card || options.signal.aborted) return "unavailable";
      if (behavior === "deny") {
        card.finish("user");
        return "rejected";
      }
      if (card.kind === "permission") {
        // An answer is not a permission: only allow or deny settles it.
        if (behavior !== "allow") return "unavailable";
        card.finish("user", { allowed: true });
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
