import { desktopText } from "./i18n.mjs";

export function pasteMenuItem(params, clipboard, webContents) {
  let attachment = false;
  if (params.isEditable && !params.editFlags.canPaste) {
    try {
      // Finder may supply file URLs, not bitmap bytes; Chromium decodes, and nothing here reads files or sends clipboard data.
      attachment = clipboard.availableFormats().some((format) =>
        ["public.file-url", "NSFilenamesPboardType", "text/uri-list"].includes(format)
      ) || !clipboard.readImage().isEmpty();
    } catch {}
  }
  return {
    label: desktopText("desktop.role.paste"),
    enabled: params.isEditable && (params.editFlags.canPaste || attachment),
    // macOS controls enabled state for native roles, so only the attachment fallback invokes paste explicitly.
    ...(attachment ? { click: () => webContents.paste() } : { role: "paste" }),
  };
}
