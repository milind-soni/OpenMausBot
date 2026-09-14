// Per-turn permission gate, adapted from the approval lifecycle in #780.
// Register before publishing: a harness listener may answer synchronously.
import { newId, type RequestOutcome } from "../contracts.ts";

interface Ask { id: string; tool: string; summary: string }
type Source = "user" | "timeout" | "system";
export function createChatToolApproval(options: {
  signal: AbortSignal;
  open(ask: Ask): void;
  resolved(ask: Ask, allowed: boolean, source: Source): void;
  timeoutMs?: number;
}) {
  const pending = new Map<string, (allowed: boolean, source: Source) => void>();
  let closed = false;
  return {
    ask(tool: string, summary: string): Promise<boolean> {
      if (closed || options.signal.aborted) return Promise.resolve(false);
      const ask = { id: newId(), tool, summary };
      return new Promise((resolve) => {
        const finish = (allowed: boolean, source: Source) => {
          if (!pending.delete(ask.id)) return;
          clearTimeout(timer);
          options.signal.removeEventListener("abort", abort);
          options.resolved(ask, allowed, source);
          resolve(allowed);
        };
        const abort = () => finish(false, "system");
        const timer = setTimeout(() => finish(false, "timeout"), options.timeoutMs ?? 15 * 60_000);
        timer.unref?.();
        pending.set(ask.id, finish);
        options.signal.addEventListener("abort", abort, { once: true });
        options.open(ask);
      });
    },
    answer(id: string, behavior: "allow" | "deny" | "answer"): RequestOutcome {
      const finish = pending.get(id);
      if (!finish || options.signal.aborted || behavior === "answer") return "unavailable";
      finish(behavior === "allow", "user");
      return behavior === "allow" ? "allowed-once" : "rejected";
    },
    close() {
      closed = true;
      for (const finish of pending.values()) finish(false, "system");
    },
  };
}
