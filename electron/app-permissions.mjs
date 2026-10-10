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
// microphone (for a Live call) and write the clipboard (its copy buttons), and
// nothing else. A Cloud is personal, so its page hearing the microphone is the
// person's own page hearing it. Any other server's page stays refused.
//
// A second, separate exception: the paired remote server open in the main
// window may use the microphone (for a Live call) and write the clipboard (the
// copy button), and nothing else. Pairing takes a code the server printed for
// the person, so it is their own server, as personal as their Cloud. Both
// microphones follow the one rule in mainFrameMicrophoneAllowed; both clipboard
// writes follow the one rule in remoteClipboardWriteAllowed.

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
 * Whether the person's own Cloud, or the active paired server, may use the
 * microphone: only in the main frame, only at the exact origin the verified
 * Cloud sign-in or the active saved environment reports. Never the camera,
 * screen capture or notifications; clipboard writes are the separate rule in
 * remoteClipboardWriteAllowed, and neither page ever reads the clipboard.
 *
 * @param {string} permission The Electron/Chromium permission name
 * @param {string} requestingUrlOrOrigin The URL or origin requesting the permission
 * @param {string | null | undefined} trustedOrigin The verified Cloud's or the active server's origin, or null when there is none
 * @param {{ isMainFrame?: boolean, mediaTypes?: string[], mediaType?: string }} [details] Request details
 * @returns {boolean} True only for that page's own microphone request
 */
function mainFrameMicrophoneAllowed(permission, requestingUrlOrOrigin, trustedOrigin, details) {
  // This computer's media rule with that page as the trusted origin, narrowed
  // to the main frame and never getDisplayMedia (empty mediaTypes).
  if (permission !== "media" || details?.isMainFrame !== true || details.mediaTypes?.length === 0) return false;
  return appPermissionAllowed("media", requestingUrlOrOrigin, trustedOrigin ?? null, details);
}

/**
 * The one capability besides the microphone a paired remote server's page gets
 * on this computer (and the same one the person's own Cloud gets):
 * writing the clipboard (navigator.clipboard.writeText asks Chromium for
 * "clipboard-sanitized-write", which covers text and the HTML/images Chromium
 * sanitizes). It is granted only to the main frame of the server the person is
 * viewing right now, matched by exact origin against the active saved
 * environment, so switching servers withdraws it at once. Reading the
 * clipboard and every other permission stay local-only.
 *
 * It relies on Chromium's transient user activation (~5 s after a user
 * interaction): without one, Chromium requests "clipboard-read", which stays
 * denied here. No separate activation tracking is done.
 *
 * @param {string} permission The Electron/Chromium permission name
 * @param {string} requestingUrlOrOrigin The URL or origin requesting the permission
 * @param {string | null | undefined} activeRemoteOrigin Origin of the active saved environment, if any
 * @param {{ isMainFrame?: boolean }} [details] Optional request details
 * @returns {boolean} True only for a main-frame clipboard write from the active remote origin
 */
export function remoteClipboardWriteAllowed(permission, requestingUrlOrOrigin, activeRemoteOrigin, details = {}) {
  if (permission !== "clipboard-sanitized-write") return false;
  if (details?.isMainFrame !== true) return false;
  const requesting = webOrigin(requestingUrlOrOrigin);
  const active = webOrigin(activeRemoteOrigin);
  return Boolean(requesting && active && requesting === active);
}

/**
 * The session's permission handlers. This computer's own page gets
 * appPermissionAllowed; the Cloud gets the microphone and clipboard writes,
 * and only while it is the page open in the main window; the active remote
 * server, in that same window, gets the same two.
 *
 * @param {{ rendererOrigin: () => string, mainContents: () => unknown, cloudHomeOrigin: () => string | null,
 *   cloudHomeRestoring?: () => Promise<unknown> | null, activeRemoteOrigin?: () => string | null }} context
 *   `mainContents`: the main window's webContents, or null; `cloudHomeOrigin`:
 *   the person's own Cloud (cloud-home.mjs myCloudOrigin), asked on every
 *   request so signing out takes the microphone and clipboard away at once;
 *   `cloudHomeRestoring`: while the saved Cloud sign-in is still restoring
 *   (the first seconds after launch), a wait for it, which main caps; null after;
 *   `activeRemoteOrigin`: the active saved environment's origin, or null on
 *   this computer, asked on every request so a server switch withdraws it.
 */
export function appPermissionHandlers({ rendererOrigin, mainContents, cloudHomeOrigin, cloudHomeRestoring = () => null, activeRemoteOrigin = () => null }) {
  // The main window's page asking for the microphone: its Cloud's own ask, if it is the Cloud.
  const asksAsCloud = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() && mainFrameMicrophoneAllowed(permission, requesting, requesting, details);
  // The active remote server's page, in the main window's own main frame,
  // asking for the microphone; read per request so a server switch withdraws it.
  const activeRemoteMicrophone = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() && mainFrameMicrophoneAllowed(permission, requesting, activeRemoteOrigin(), details);
  // The active remote server's page, or the person's own Cloud, in the main
  // window's own main frame, writing the clipboard: one rule for both.
  const clipboardWrite = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() &&
    (remoteClipboardWriteAllowed(permission, requesting, activeRemoteOrigin(), details) ||
      remoteClipboardWriteAllowed(permission, requesting, cloudHomeOrigin(), details));
  const allowed = (contents, permission, requesting, details) =>
    appPermissionAllowed(permission, requesting, rendererOrigin(), details) ||
    (asksAsCloud(contents, permission, requesting, details) && mainFrameMicrophoneAllowed(permission, requesting, cloudHomeOrigin(), details)) ||
    activeRemoteMicrophone(contents, permission, requesting, details) ||
    clipboardWrite(contents, permission, requesting, details);
  return {
    // Only a request may wait (Electron answers it through the callback). A
    // Cloud page that asks before the saved sign-in has restored is decided
    // once it has, never refused for being early; anything else at once.
    request: (contents, permission, callback, details) => {
      const requesting = details?.requestingUrl ?? contents?.getURL?.() ?? "";
      if (allowed(contents, permission, requesting, details)) return callback(true);
      const restoring = asksAsCloud(contents, permission, requesting, details) ? cloudHomeRestoring() : null;
      if (!restoring) return callback(false);
      void Promise.resolve(restoring).catch(() => {}).then(() => callback(allowed(contents, permission, requesting, details)));
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
