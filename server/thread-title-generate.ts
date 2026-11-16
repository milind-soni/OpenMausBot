// Generated thread titles: automatic ones only when features.llmThreadTitles is on, "Regenerate title" whenever the person
// asks. The engine's one-shot text call, given 10 seconds once it starts, its reply cleaned to a title or null.
import type { AppConfig } from "./config.ts";
import { backgroundTextSlots, type JobSlots } from "./job-slots.ts";
import { titleFromLlm } from "./store.ts";
import { threadTitlePrompt, type ThreadTitleSource } from "./thread-title.ts";

export function llmThreadTitlesEnabled(cfg: Pick<AppConfig, "features">): boolean {
  return cfg.features?.llmThreadTitles === true;
}

export const THREAD_TITLE_TIMEOUT_MS = 10_000;

/** A person sees the title soon, so the call waits ahead of background upkeep for a free slot. Past its 10 s the answer
 * is null at once, but the slot is held until the engine call has really ended: its process still counts until then. */
export async function generateThreadTitle(
  provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> },
  text: string,
  source: ThreadTitleSource = "first-message",
  slots: JobSlots = backgroundTextSlots,
): Promise<string | null> {
  const prompt = threadTitlePrompt(text, source);
  return new Promise<string | null>((answer) => {
    void slots.run(async () => {
      const expiry = new AbortController();
      const timer = setTimeout(() => {
        expiry.abort();
        answer(null);
      }, THREAD_TITLE_TIMEOUT_MS);
      try {
        answer(titleFromLlm(await provider.generateText!(prompt, { signal: expiry.signal })));
      } catch {
        answer(null);
      } finally {
        clearTimeout(timer);
      }
    }, { interactive: true }).catch(() => answer(null));
  });
}
