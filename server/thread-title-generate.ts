import { backgroundTextSlots, type JobSlots } from "./job-slots.ts";
import { titleFromLlm } from "./store.ts";
import { threadTitlePrompt, type ThreadTitleSource } from "./thread-title.ts";

export const THREAD_TITLE_TIMEOUT_MS = 10_000;
const THREAD_TITLE_REGENERATE_TIMEOUT_MS = 30_000;

function warnRegeneratedTitle(reason: "timeout" | "provider-error" | "rejected-output", detail?: string): void {
  console.warn(detail === undefined ? `title generation: ${reason}` : `title generation: ${reason} ${detail}`);
}

/** A person sees the title soon, so the call waits ahead of background upkeep for a free slot. Past its deadline the
 * answer is null at once, but the slot is held until the engine call has really ended: its process still counts until then. */
export async function generateThreadTitle(
  provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> },
  text: string,
  source: ThreadTitleSource = "first-message",
  slots: JobSlots = backgroundTextSlots,
): Promise<string | null> {
  const prompt = threadTitlePrompt(text, source);
  const regenerate = source === "conversation";
  const timeoutMs = regenerate ? THREAD_TITLE_REGENERATE_TIMEOUT_MS : THREAD_TITLE_TIMEOUT_MS;
  return new Promise<string | null>((answer) => {
    void slots.run(async () => {
      const expiry = new AbortController();
      const timer = setTimeout(() => {
        if (regenerate) warnRegeneratedTitle("timeout", `budgetMs=${timeoutMs}`);
        expiry.abort();
        answer(null);
      }, timeoutMs);
      try {
        const reply = await provider.generateText!(prompt, { signal: expiry.signal });
        if (expiry.signal.aborted) return;
        const title = titleFromLlm(reply);
        if (title === null && regenerate) warnRegeneratedTitle("rejected-output");
        answer(title);
      } catch (error) {
        if (expiry.signal.aborted) return;
        if (regenerate) warnRegeneratedTitle("provider-error", error instanceof Error ? error.name : "error");
        answer(null);
      } finally {
        clearTimeout(timer);
      }
    }, { interactive: true }).catch(() => answer(null));
  });
}
