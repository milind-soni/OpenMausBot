// One generated thread title: the engine's one-shot text call, given 10 seconds, its reply cleaned to a title or null.
import { titleFromLlm } from "./store.ts";
import { threadTitlePrompt, type ThreadTitleSource } from "./thread-title.ts";

export async function generateThreadTitle(
  provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> },
  text: string,
  source: ThreadTitleSource = "first-message",
): Promise<string | null> {
  const prompt = threadTitlePrompt(text, source);
  const expiry = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      provider.generateText!(prompt, { signal: expiry.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expiry.abort();
          reject(new Error("thread title timed out"));
        }, 10_000);
      }),
    ]);
    return titleFromLlm(reply);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
