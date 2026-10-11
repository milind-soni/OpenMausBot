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
// window may write the clipboard (the copy button) and, once the person said
// yes to that server's first microphone request, use the microphone for a Live
// call; nothing else. A saved server is not necessarily the person's own (an
// address is saved before pairing, and a chat-only code can come from someone
// else), so its microphone is asked, never assumed. Both microphones follow the
// one rule in mainFrameMicrophoneAllowed; both clipboard writes follow the one
// rule in remoteClipboardWriteAllowed.

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
 * Whether the person's own Cloud, or the active saved server they allowed, may
 * use the microphone: only in the main frame, only at the exact origin the
 * verified Cloud sign-in or the active saved environment reports. Never the camera,
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
 * server, in that same window, gets clipboard writes, and the microphone once
 * the person allowed it.
 *
 * @param {{ rendererOrigin: () => string, mainContents: () => unknown, cloudHomeOrigin: () => string | null,
 *   cloudHomeRestoring?: () => Promise<unknown> | null, activeRemoteOrigin?: () => string | null,
 *   activeRemoteMicrophone?: () => boolean, askRemoteMicrophone?: (origin: string) => Promise<unknown> | null }} context
 *   `mainContents`: the main window's webContents, or null; `cloudHomeOrigin`:
 *   the person's own Cloud (cloud-home.mjs myCloudOrigin), asked on every
 *   request so signing out takes the microphone and clipboard away at once;
 *   `cloudHomeRestoring`: while the saved Cloud sign-in is still restoring
 *   (the first seconds after launch), a wait for it, which main caps; null after;
 *   `activeRemoteOrigin`: the active saved environment's origin, or null on
 *   this computer, asked on every request so a server switch withdraws it;
 *   `activeRemoteMicrophone`: whether the person allowed that server the
 *   microphone, also asked on every request; `askRemoteMicrophone`: on a
 *   microphone request the person has not answered yet, a wait for their
 *   answer (main's dialog), or null when there is nothing to ask.
 */
export function appPermissionHandlers({ rendererOrigin, mainContents, cloudHomeOrigin, cloudHomeRestoring = () => null, activeRemoteOrigin = () => null,
  activeRemoteMicrophone = () => false, askRemoteMicrophone = () => null }) {
  // The main window's page asking for the microphone: its Cloud's own ask, if it is the Cloud.
  const asksAsCloud = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() && mainFrameMicrophoneAllowed(permission, requesting, requesting, details);
  // The main window's page asking for the microphone as the active remote
  // server; read per request so a server switch withdraws it.
  const asksAsRemote = (contents, permission, requesting, details) =>
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
    (asksAsRemote(contents, permission, requesting, details) && activeRemoteMicrophone() === true) ||
    clipboardWrite(contents, permission, requesting, details);
  return {
    // Only a request may wait (Electron answers it through the callback). A
    // main-window page that asks before the saved Cloud sign-in has restored
    // waits for it first, never refused for being early: the active saved
    // server may be that Cloud itself ("Open My Cloud"), which needs no
    // dialog. Then a saved server's microphone request not yet answered asks
    // the person; anything else is decided at once. Each answer is the rule
    // again afterwards, so a switch or sign-out made meanwhile still refuses.
    request: (contents, permission, callback, details) => {
      const requesting = details?.requestingUrl ?? contents?.getURL?.() ?? "";
      const decide = () => allowed(contents, permission, requesting, details);
      const settle = (waiting) => Promise.resolve(waiting).catch(() => {});
      // true, false, or a wait for the person's answer.
      const decideOrAsk = () => {
        if (decide()) return true;
        const asking = asksAsRemote(contents, permission, requesting, details) ? askRemoteMicrophone(activeRemoteOrigin()) : null;
        return asking ? settle(asking).then(decide) : false;
      };
      const restoring = !decide() && asksAsCloud(contents, permission, requesting, details) ? cloudHomeRestoring() : null;
      const answer = restoring ? settle(restoring).then(decideOrAsk) : decideOrAsk();
      if (typeof answer === "boolean") return callback(answer);
      void answer.then(callback);
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
