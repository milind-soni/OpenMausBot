/** Keep native text paste, but let image/file clipboards reach renderer paste handlers. */
export function pasteMenuItem(params, clipboard, webContents) {
  let attachment = false;
  if (params.isEditable && !params.editFlags.canPaste) {
    try {
      // Finder may supply file URLs, not bitmap bytes. Chromium still owns
      // decoding; this does not read files or send clipboard data over IPC.
      attachment = clipboard.availableFormats().some((format) =>
        ["public.file-url", "NSFilenamesPboardType", "text/uri-list"].includes(format)
      ) || !clipboard.readImage().isEmpty();
    } catch { /* Clipboard access can be unavailable. Leave Paste disabled. */ }
  }
  return {
    label: "Paste",
    enabled: params.isEditable && (params.editFlags.canPaste || attachment),
    // macOS controls enabled for native roles. Invoke paste explicitly only
    // for the attachment fallback; ordinary text keeps its native role.
    ...(attachment ? { click: () => webContents.paste() } : { role: "paste" }),
  };
}
