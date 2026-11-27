// Every new thread asks its engine for a title (server/thread-title-generate.ts). A fake provider that counts, holds or
// scripts model calls answers that one-shot with a failure first, on the request body it received, so the thread keeps
// its first-message title and the test sees only the calls it makes.
export function isTitleCall(body: unknown): boolean {
  return JSON.stringify(body ?? null).includes("Reply with only a short title");
}
