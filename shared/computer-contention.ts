/** One wording for "a turn already owns this bot's cloud computer": the server
 * sends it with 409 when provision or sleep arrives mid-turn, and the Computer
 * panel recognises it to show the neutral busy state instead of a fault. */
export const CLOUD_COMPUTER_BUSY_ERROR =
  "this bot's cloud computer is being used by an active turn — interrupt it first";

/** True when an error message carries that refusal, however it was wrapped.
 * A substring test, not equality: the message reaches the client as the
 * server wrote it today, but a future wrapper must not break recognition. */
export function isCloudComputerBusyMessage(message: string): boolean {
  return message.includes(CLOUD_COMPUTER_BUSY_ERROR);
}
