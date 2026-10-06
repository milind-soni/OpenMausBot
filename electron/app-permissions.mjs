// Permission policy for the main application window. The local UI needs a
// small set of capabilities to function: audio media (microphone for voice
// input), notifications, and clipboard access. Screen preview has its own
// one-shot, user-gesture-bound display-media guard in main.mjs.
//
// Privileged capabilities — camera/video, geolocation, USB, HID, serial,
// MIDI, unguarded screen capture, window management, local fonts — stay off: the app
// does not use them, and granting them unconditionally to the renderer leaves
// host sensors and devices exposed if an untrusted payload ever executes.
// The allow-list also applies only to the verified renderer origin; any
// opaque or cross-origin request is refused outright.
//
// One exception: the person's own Cloud, open in the main window, may use the
// microphone (for a Live call) and nothing else. A Cloud is personal, so its
// page hearing the microphone is the person's own page hearing it. Any other
// server's page stays refused.

const ALLOWED_APP_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

// Opaque origins (data:, about:blank, javascript:) serialise as the string
// "null"; never let two of them match each other.
function webOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Decide whether a requested Chromium permission should be granted for the main app window.
 *
 * @param {string} permission The Electron/Chromium permission name
 * @param {string} requestingUrlOrOrigin The URL or origin requesting the permission
 * @param {string} rendererOrigin The trusted local renderer origin
 * @param {{ mediaTypes?: string[], mediaType?: string }} [details] Optional request details
 * @returns {boolean} True if the permission should be granted, false otherwise
 */
export function appPermissionAllowed(permission, requestingUrlOrOrigin, rendererOrigin, details = {}) {
  const requesting = webOrigin(requestingUrlOrOrigin);
  const allowed = webOrigin(rendererOrigin);
  if (!requesting || !allowed || requesting !== allowed) return false;

  // Media: audio (microphone) is permitted; video (camera/webcam) is strictly denied.
  // Electron 43 routes getDisplayMedia through permission="media" with mediaTypes: []
  // before selecting display media. Allowing this preserves the guarded displayMediaGuard
  // without granting webcam access.
  if (permission === "media") {
    if (details?.mediaType !== undefined && details.mediaType !== "audio") return false;
    if (details?.mediaTypes !== undefined) {
      // Empty mediaTypes is Electron getDisplayMedia routing; ["audio"] is microphone capture.
      return Array.isArray(details.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    }
    return details?.mediaType === "audio";
  }

  return ALLOWED_APP_PERMISSIONS.has(permission);
}

/**
 * Whether the person's own Cloud may use a capability: only the microphone,
 * only in the main frame, only at the exact origin the verified Cloud sign-in
 * reports. Never the camera, screen capture, notifications or the clipboard.
 *
 * @param {string} permission The Electron/Chromium permission name
 * @param {string} requestingUrlOrOrigin The URL or origin requesting the permission
 * @param {string | null} homeOrigin The verified Cloud's origin, or null when there is none
 * @param {{ isMainFrame?: boolean, mediaTypes?: string[], mediaType?: string }} [details] Request details
 * @returns {boolean} True only for the Cloud's own microphone request
 */
function cloudHomeMicrophoneAllowed(permission, requestingUrlOrOrigin, homeOrigin, details) {
  const requesting = webOrigin(requestingUrlOrOrigin);
  const home = webOrigin(homeOrigin);
  if (permission !== "media" || !requesting || !home || requesting !== home || details?.isMainFrame !== true) return false;
  if (details.mediaType !== undefined && details.mediaType !== "audio") return false;
  // A request names its media; empty is getDisplayMedia, which a Cloud never gets.
  if (details.mediaTypes !== undefined) {
    return Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === "audio");
  }
  return details.mediaType === "audio";
}

/**
 * The session's permission handlers. This computer's own page gets
 * appPermissionAllowed; the Cloud gets the microphone, and only while it is
 * the page open in the main window.
 *
 * @param {{ rendererOrigin: () => string, mainContents: () => unknown, cloudHomeOrigin: () => string | null }} context
 *   `mainContents`: the main window's webContents, or null; `cloudHomeOrigin`:
 *   the Cloud the sign-in verified, asked on every request so signing out
 *   takes the microphone away at once.
 */
export function appPermissionHandlers({ rendererOrigin, mainContents, cloudHomeOrigin }) {
  const allowed = (contents, permission, requesting, details) => {
    if (appPermissionAllowed(permission, requesting, rendererOrigin(), details)) return true;
    const main = mainContents();
    return Boolean(contents) && contents === main && cloudHomeMicrophoneAllowed(permission, requesting, cloudHomeOrigin(), details);
  };
  return {
    request: (contents, permission, callback, details) => {
      callback(allowed(contents, permission, details?.requestingUrl ?? contents?.getURL?.() ?? "", details));
    },
    check: (contents, permission, requestingOrigin, details) =>
      allowed(contents, permission, requestingOrigin || contents?.getURL?.() || "", details),
    /** perm:status's `pageMic`: what `request` answers the asking page's
     * microphone request, so a blocked Live call can say whether this app
     * refused it (a web browser can make the call) or the computer did. */
    pageMicrophone: (event) => {
      const contents = event?.sender;
      const frame = event?.senderFrame;
      const isMainFrame = Boolean(frame) && frame === contents?.mainFrame;
      return allowed(contents, "media", frame?.url ?? "", { isMainFrame, mediaTypes: ["audio"] }) ? "allowed" : "refused";
    },
  };
}

// Both explicit IPC links and window.open must use the same web-only policy.
export function externalWebUrl(rawUrl) {
  if (typeof rawUrl !== "string") throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only web links can be opened");
  if (url.username || url.password) throw new Error("Web links must not include user credentials");
  return url.toString();
}
