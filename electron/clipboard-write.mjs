/** Largest text the renderer may place on the clipboard through IPC. */
export const CLIPBOARD_TEXT_MAX_CHARS = 10_000_000;

/** Write plain text for the renderer's copy button. Only a non-blank string
 * within the cap is accepted; the result says whether the clipboard took it. */
export function writeClipboardText(clipboard, text) {
  if (typeof text !== "string" || !text.trim() || text.length > CLIPBOARD_TEXT_MAX_CHARS) return false;
  try {
    clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
