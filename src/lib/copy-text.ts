/** Copy plain text. Prefers the Clipboard API; falls back to a hidden textarea
 * so Electron/http://127.0.0.1 still works when `navigator.clipboard` is missing
 * or permission is denied. */
export async function copyText(text: string): Promise<boolean> {
  const value = text ?? "";
  const clip = globalThis.navigator?.clipboard;
  try {
    if (clip?.writeText) {
      await clip.writeText(value);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  const doc = globalThis.document;
  if (!doc?.body) return false;
  try {
    const field = doc.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    doc.body.appendChild(field);
    field.select();
    const ok = doc.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}
