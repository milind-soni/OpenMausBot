import type { TextGenerationOptions } from "./contracts.ts";
import { backgroundTextSlots, type JobSlots } from "./job-slots.ts";
import { titleFromLlm } from "./store.ts";
import { threadTitlePrompt, type ThreadTitleSource } from "./thread-title.ts";

export const THREAD_TITLE_TIMEOUT_MS = 30_000;

/** The slot is held until the provider settles, even if the caller has already timed out. */
export async function generateThreadTitle(
  provider: { generateText?: (prompt: string, options?: TextGenerationOptions) => Promise<string> },
  text: string,
  source: ThreadTitleSource = "first-message",
  slots: JobSlots = backgroundTextSlots,
): Promise<string | null> {
  const prompt = threadTitlePrompt(text, source);
  const timeoutMs = source === "call" ? 10_000 : THREAD_TITLE_TIMEOUT_MS;
  const expiry = new AbortController();
  const warn = (reason: string) => { if (source !== "call") console.warn(`title generation: ${reason}`); };
  return new Promise<string | null>((answer) => {
    const timer = setTimeout(() => {
      warn(`timeout budgetMs=${timeoutMs}`);
      expiry.abort();
      answer(null);
    }, timeoutMs);
    void slots.run(async () => {
      expiry.signal.throwIfAborted();
      const reply = await provider.generateText!(prompt, source === "call" ? { signal: expiry.signal }
        : { signal: expiry.signal, timeoutMs, maxOutputTokens: 512, finalTextOnly: true });
      if (expiry.signal.aborted) return;
      const title = titleFromLlm(reply);
      if (title === null) warn("rejected-output");
      answer(source === "follow-up" && title?.toUpperCase() === "KEEP" ? null : title);
    }, { interactive: true, signal: expiry.signal }).catch((error: unknown) => {
      if (!expiry.signal.aborted) warn(`provider-error ${error instanceof Error ? error.name : "error"}`);
      answer(null);
    }).finally(() => clearTimeout(timer));
  });
}
