// A provider refusing a turn as too large even after one smaller resend, in the plain English words the server stores
// in the failed turn's row: the phones read those words whole, and the app words them again in the reader's language.

export function requestTooLargeMessage(model: string): string {
  return `This message is too large for ${model}. Start a new chat or pick a model that accepts more.`;
}

const REFUSED = /^This message is too large for (.+)\. Start a new chat or pick a model that accepts more\.$/;

/** The model a failed turn's cause says refused the message's size, or null for any other failure. */
export function requestTooLargeModel(cause: string): string | null {
  return REFUSED.exec(cause.trim())?.[1] ?? null;
}
