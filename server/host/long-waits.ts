// A question a person has left for a day is said in words the next time they talk to their Chief or MausBot: the badge
// alone says nothing about how long it has waited, and no card or feature flag is added for it.
export const LONG_WAIT_MS = 24 * 60 * 60_000;

export const waitNow = () => Date.now();

export const waitedLong = (since: number, now: number): boolean => now - since >= LONG_WAIT_MS;

/** "since yesterday", "for 3 days". */
export function waitedWords(since: number, now: number): string {
  const days = Math.floor((now - since) / LONG_WAIT_MS);
  return days <= 1 ? "since yesterday" : `for ${days} days`;
}

export const SAY_LONG_WAIT = "Unless you already said so in this conversation, say in one plain line of your reply which bot waits, on what, for how long and where they can answer. It is a sentence in your answer, not a card or a new question; then go on with what they asked.";
