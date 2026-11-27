// VNC needs keyboard capture (so ⌘/Alt chords reach the guest), pointer capture, clipboard paste and full screen, for the
// viewer's own origin only. Every privileged capability stays off: this window renders a provider's remote content.

const DESKTOP_VIEWER_PERMISSIONS = new Set([
  "keyboardLock",
  "pointerLock",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

// Opaque origins (data:, about:blank) serialise as "null"; never let two of them match.
function webOrigin(value) {
  if (Object.prototype.toString.call(value) !== "[object String]") return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin) {
  if (!DESKTOP_VIEWER_PERMISSIONS.has(permission)) return false;
  const requesting = webOrigin(requestingOrigin);
  return requesting !== null && requesting === webOrigin(viewerOrigin);
}
