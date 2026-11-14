export const CLIPBOARD_TEXT_MAX_CHARS = 10_000_000;

export function writeClipboardText(clipboard, text) {
  if (typeof text !== "string" || !text.trim() || text.length > CLIPBOARD_TEXT_MAX_CHARS) return false;
  try {
    clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
