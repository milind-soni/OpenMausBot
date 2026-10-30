/** Why a message's `text` is refused, or null; a missing or empty one is the caller's "text required". */
export function messageTextRefusal(text: unknown): string | null {
  if (text === undefined || text === null) return null;
  if (typeof text !== "string") return "text must be a string";
  return text.includes("\0") ? "text must not contain a null byte" : null;
}
