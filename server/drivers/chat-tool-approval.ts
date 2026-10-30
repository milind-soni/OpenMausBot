// Per-turn ask gate. Register before publishing: a harness listener may answer synchronously.
import { newId, type RequestOutcome } from "../contracts.ts";
import { floorBlockForToolCall, type FloorBlock } from "../safety-floor-gate.ts";
import type { AskQuestion } from "../../shared/ask-question.ts";
import type { ChatToolCallView } from "./chat-mcp-tools.ts";
import { REFUSED_NEXT_STEP } from "../reply-habits.ts";

/** `grant`: what "Always allow this session" would keep allowed; absent when the card can only allow once. */
interface Ask { id: string; tool: string; summary: string; grant?: string }
type Source = "user" | "timeout" | "system";

interface Card {
  kind: "permission" | "question";
  ask: Ask;
  /** Exactly-once: a second finish is a no-op because the card left the map. */
  finish(source: Source, decision?: { allowed?: boolean; always?: boolean; message?: string }): void;
}

/** The text a refused call hands the model; a floor block also raises its line through `notice`. */
export function refusal(block: FloorBlock | null, notice: (line: string) => void): string {
  if (!block) return `Permission denied or expired; the tool was not executed.${REFUSED_NEXT_STEP}`;
  notice(block.line);
  return block.reason;
}

export function createChatToolApproval(options: {
  signal: AbortSignal;
  open(ask: Ask): void;
  resolved(ask: Ask, allowed: boolean, source: Source): void;
  openQuestion(ask: Ask, questions: AskQuestion[]): void;
  resolvedQuestion(ask: Ask, answered: boolean, source: Source): void;
  /** The conversation's session grants: an ask they cover is allowed without a card. */
  granted?: Set<string>;
  timeoutMs?: number;
}) {
  const pending = new Map<string, Card>();
  let closed = false;
  /** Whether a kept "Always allow this session" answers this ask with no card. */
  const covered = (grant?: string): boolean => grant !== undefined && options.granted?.has(grant) === true;
  return {
    covered,
    /** The floor's block, already logged, for a call this gate would answer itself (Full access or a kept session
     * allow), or null. A card a person answers is never touched. */
    floored(call: { full: boolean; threadId: string; botId?: string; shown: ChatToolCallView; summary?: string }): FloorBlock | null {
      if (!call.shown.ask || !(call.full || covered(call.shown.grant))) return null;
      return floorBlockForToolCall({ threadId: call.threadId, botId: call.botId, tool: call.shown.title, summary: call.summary, input: call.shown.input });
    },
    ask(tool: string, summary: string, grant?: string): Promise<boolean> {
      if (closed || options.signal.aborted) return Promise.resolve(false);
      if (covered(grant)) return Promise.resolve(true);
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
        const card: Card = {
          kind: "question",
          ask,
          finish(source, decision) {
            if (!pending.delete(ask.id)) return;
            options.signal.removeEventListener("abort", abort);
            // A timeout or abort resolves null: no system note may occupy the slot the model reads as the person's words.
            const reply = typeof decision?.message === "string" && decision.message.length > 0 ? decision.message : null;
            options.resolvedQuestion(ask, reply !== null, source);
            resolve(reply);
          },
        };
        const abort = () => card.finish("system");
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
      // A question settles only on a real reply, never a blank.
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
