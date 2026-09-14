/** One wording for "a turn already owns this bot's cloud computer", shared
 * because two sides have to agree on it: the server sends it with 409 when
 * provision or sleep arrives mid-turn, and the Computer panel recognises it
 * to show the neutral busy state instead of a fault.
 *
 * Kept here rather than spelled out at each site: the panel used to match
 * the server's prose with its own regex, so a copy-edit on the server would
 * have silently turned the busy state back into "Couldn't reach the
 * computer" — the exact bug the panel fix exists to prevent, and one no
 * test would have caught. */
export const CLOUD_COMPUTER_BUSY_ERROR =
  "this bot's cloud computer is being used by an active turn — interrupt it first";

/** True when an error message carries that refusal, however it was wrapped.
 * A substring test, not equality: the message reaches the client as the
 * server wrote it today, but a future wrapper must not break recognition. */
export function isCloudComputerBusyMessage(message: string): boolean {
  return message.includes(CLOUD_COMPUTER_BUSY_ERROR);
}
