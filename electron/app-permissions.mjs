// Privileged capabilities (camera, geolocation, USB, HID, serial, MIDI, unguarded screen capture) stay off,
// and the allow-list applies only to the verified renderer origin.

const ALLOWED_APP_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

// Opaque origins (data:, about:blank) serialise as "null"; never let two of them match.
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
 * @param {string} permission
 * @param {string} requestingUrlOrOrigin
 * @param {string} rendererOrigin
 * @param {{ mediaTypes?: string[], mediaType?: string }} [details]
 * @returns {boolean}
 */
export function appPermissionAllowed(permission, requestingUrlOrOrigin, rendererOrigin, details = {}) {
  const requesting = webOrigin(requestingUrlOrOrigin);
  const allowed = webOrigin(rendererOrigin);
  if (!requesting || !allowed || requesting !== allowed) return false;

  // Electron 43 routes getDisplayMedia through "media" with mediaTypes: [] before selecting display media.
  if (permission === "media") {
    if (details?.mediaType !== undefined && details.mediaType !== "audio") return false;
    if (details?.mediaTypes !== undefined) {
      return Array.isArray(details.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    }
    return details?.mediaType === "audio";
  }

  return ALLOWED_APP_PERMISSIONS.has(permission);
}

function mainFrameMicrophoneAllowed(permission, requestingUrlOrOrigin, trustedOrigin, details) {
  if (permission !== "media" || details?.isMainFrame !== true || details.mediaTypes?.length === 0) return false;
  return appPermissionAllowed("media", requestingUrlOrOrigin, trustedOrigin ?? null, details);
}

/**
 * navigator.clipboard.writeText asks for "clipboard-sanitized-write" within Chromium's transient user
 * activation (~5 s); without one it asks for "clipboard-read", which stays denied here.
 *
 * @param {string} permission
 * @param {string} requestingUrlOrOrigin
 * @param {string | null | undefined} activeRemoteOrigin
 * @param {{ isMainFrame?: boolean }} [details]
 * @returns {boolean}
 */
export function remoteClipboardWriteAllowed(permission, requestingUrlOrOrigin, activeRemoteOrigin, details = {}) {
  if (permission !== "clipboard-sanitized-write") return false;
  if (details?.isMainFrame !== true) return false;
  const requesting = webOrigin(requestingUrlOrOrigin);
  const active = webOrigin(activeRemoteOrigin);
  return Boolean(requesting && active && requesting === active);
}

/**
 * @param {{ rendererOrigin: () => string, mainContents: () => unknown, cloudHomeOrigin: () => string | null,
 *   cloudHomeRestoring?: () => Promise<unknown> | null, activeRemoteOrigin?: () => string | null,
 *   activeRemoteMicrophone?: () => boolean, askRemoteMicrophone?: (origin: string) => Promise<unknown> | null,
 *   homeOrigin?: () => string | null }} context
 *   Every getter is read per request, so a sign-out or server switch withdraws access at once. `homeOrigin`: My Cloud
 *   once the person's bots moved there (home-window.mjs), whose page alone may show notifications besides this
 *   computer's.
 */
export function appPermissionHandlers({ rendererOrigin, mainContents, cloudHomeOrigin, cloudHomeRestoring = () => null, activeRemoteOrigin = () => null,
  activeRemoteMicrophone = () => false, askRemoteMicrophone = () => null, homeOrigin = () => null }) {
  const notifiesAtHome = (contents, permission, requesting, details) => {
    const home = webOrigin(homeOrigin());
    return permission === "notifications" && Boolean(home) && Boolean(contents) && contents === mainContents() &&
      details?.isMainFrame === true && webOrigin(requesting) === home;
  };
  const asksAsCloud = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() && mainFrameMicrophoneAllowed(permission, requesting, requesting, details);
  const asksAsRemote = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() && mainFrameMicrophoneAllowed(permission, requesting, activeRemoteOrigin(), details);
  const clipboardWrite = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() &&
    (remoteClipboardWriteAllowed(permission, requesting, activeRemoteOrigin(), details) ||
      remoteClipboardWriteAllowed(permission, requesting, cloudHomeOrigin(), details));
  const allowed = (contents, permission, requesting, details) =>
    appPermissionAllowed(permission, requesting, rendererOrigin(), details) ||
    (asksAsCloud(contents, permission, requesting, details) && mainFrameMicrophoneAllowed(permission, requesting, cloudHomeOrigin(), details)) ||
    (asksAsRemote(contents, permission, requesting, details) && activeRemoteMicrophone() === true) ||
    clipboardWrite(contents, permission, requesting, details) ||
    notifiesAtHome(contents, permission, requesting, details);
  return {
    // Only a request may wait (Electron answers through the callback); the rule runs again after any wait.
    request: (contents, permission, callback, details) => {
      const requesting = details?.requestingUrl ?? contents?.getURL?.() ?? "";
      const decide = () => allowed(contents, permission, requesting, details);
      const settle = (waiting) => Promise.resolve(waiting).catch(() => {});
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
