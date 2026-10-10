// Permission policy for the in-app desktop viewer window. A VNC page needs a
// few browser capabilities that are gated behind permission checks: keyboard
// capture (so ⌘/Alt chords reach the guest instead of the host), pointer
// capture, the clipboard for paste, and full screen. Denying those along with
// everything else leaves a viewer where the mouse works but typing does not.
//
// Every privileged capability — camera, microphone, geolocation,
// notifications, USB, HID, serial, MIDI, screen capture, file system — stays
// off: this window renders a provider's remote content, not ours. The
// allow-list also applies only to the viewer's own origin; anything the page
// embeds cross-origin is refused outright.

const DESKTOP_VIEWER_PERMISSIONS = new Set([
  "keyboardLock",
  "pointerLock",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

// Opaque origins (data:, about:blank, javascript:) serialise as the string
// "null"; never let two of them match each other.
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
