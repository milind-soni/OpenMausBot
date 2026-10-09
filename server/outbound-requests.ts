// Outbound calls held for a person's answer.
//
// The connector relay opens one of these when a bot's tool call would send
// something and the bot's policy says ask. The relay then waits on
// `answer`; the respond route resolves it when the card is answered. The
// contract mirrors the other card services: a request is claimed exactly
// once, a second answer says so instead of doing anything, and nothing
// waits forever — the relay has its own deadline, so the hold has one too.
//
// In-memory on purpose. A restart drops every held relay along with the
// proxy process that was waiting on it; the card left on the thread then
// settles as unavailable, the same way an engine's own request does.
import { randomUUID } from "node:crypto";

export type OutboundAnswer = "allow" | "deny" | "timeout";

interface Held {
  botId: string;
  threadId: string;
  tool: string;
  settle: (answer: OutboundAnswer) => void;
  answered?: OutboundAnswer;
  timer: ReturnType<typeof setTimeout>;
}

export type OutboundResolution =
  | { claimed: false }
  | { claimed: true; state: "allowed" | "denied" }
  | { claimed: true; state: "already_settled"; behavior: OutboundAnswer };

export class OutboundRequestService {
  private held = new Map<string, Held>();

  /** Hold one call. `answer` settles with the person's verdict or a timeout. */
  open(input: { botId: string; threadId: string; tool: string; timeoutMs: number }): {
    requestId: string;
    answer: Promise<OutboundAnswer>;
  } {
    const requestId = randomUUID();
    let settle!: (answer: OutboundAnswer) => void;
    const answer = new Promise<OutboundAnswer>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => this.settle(requestId, "timeout"), input.timeoutMs);
    timer.unref?.();
    this.held.set(requestId, { botId: input.botId, threadId: input.threadId, tool: input.tool, settle, timer });
    return { requestId, answer };
  }

  private settle(requestId: string, answer: OutboundAnswer): void {
    const entry = this.held.get(requestId);
    if (!entry || entry.answered) return;
    entry.answered = answer;
    clearTimeout(entry.timer);
    entry.settle(answer);
  }

  /** The person's answer, from the respond route. */
  resolve(input: { threadId: string; requestId: string; behavior: "allow" | "deny" | "answer" }): OutboundResolution {
    const entry = this.held.get(input.requestId);
    if (!entry || entry.threadId !== input.threadId) return { claimed: false };
    if (entry.answered) return { claimed: true, state: "already_settled", behavior: entry.answered };
    const answer: OutboundAnswer = input.behavior === "allow" ? "allow" : "deny";
    this.settle(input.requestId, answer);
    return { claimed: true, state: answer === "allow" ? "allowed" : "denied" };
  }

  /** Requests still waiting in a thread, oldest first. */
  pending(threadId: string): string[] {
    return [...this.held.entries()]
      .filter(([, entry]) => entry.threadId === threadId && !entry.answered)
      .map(([requestId]) => requestId);
  }

  /** Forget a settled request once its waiter has read the answer. */
  forget(requestId: string): void {
    const entry = this.held.get(requestId);
    if (entry) clearTimeout(entry.timer);
    this.held.delete(requestId);
  }
}
