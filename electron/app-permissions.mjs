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
 *   computer's and the active remote server's.
 */
export function appPermissionHandlers({ rendererOrigin, mainContents, cloudHomeOrigin, cloudHomeRestoring = () => null, activeRemoteOrigin = () => null,
  activeRemoteMicrophone = () => false, askRemoteMicrophone = () => null, homeOrigin = () => null }) {
  // Notifications for the main window's main frame on `origin`: My Cloud as home, or the remote server the person
  // switched to (Settings → Notifications there has no browser site settings to fall back on).
  // Fullscreen too, so a chat video's own fullscreen button works there (it still needs the person's click).
  const notifiesAs = (origin, contents, permission, requesting, details) => {
    const page = webOrigin(origin);
    return (permission === "notifications" || permission === "fullscreen") && Boolean(page) && Boolean(contents) &&
      contents === mainContents() && details?.isMainFrame === true && webOrigin(requesting) === page;
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
    notifiesAs(homeOrigin(), contents, permission, requesting, details) ||
    notifiesAs(activeRemoteOrigin(), contents, permission, requesting, details);
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

// Both explicit IPC links and window.open use this one policy: a web link, an email draft the person sends themselves,
// or an Obsidian note to open.
export function externalLinkUrl(rawUrl) {
  if (typeof rawUrl === "string" && /^\s*mailto:/i.test(rawUrl)) return emailDraftUrl(rawUrl);
  if (typeof rawUrl === "string" && /^\s*obsidian:/i.test(rawUrl)) return obsidianNoteUrl(rawUrl);
  return externalWebUrl(rawUrl);
}

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

const EMAIL_DRAFT_FIELDS = new Set(["subject", "body"]);

/** Security: one address, and only a subject and a body, so a link can add no recipient and attach no file (some mail
 * clients honour an `attach` field). */
export function emailDraftUrl(rawUrl) {
  let url, address;
  try {
    url = new URL(rawUrl);
    address = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("That email link is invalid");
  }
  if (url.protocol !== "mailto:") throw new Error("Only email links can be drafted");
  if (!/^[^\s@,;]+@[^\s@,;]+$/.test(address)) throw new Error("An email link names one address");
  if ([...url.searchParams.keys()].some(field => !EMAIL_DRAFT_FIELDS.has(field.toLowerCase()))) {
    throw new Error("An email link carries only a subject and a body");
  }
  return url.toString();
}

const OBSIDIAN_NOTE_FIELDS = new Set(["vault", "file"]);

/** Security: only `open` with a vault and a file inside it. Obsidian's other actions (`new`, `search`, …), `open`'s
 * absolute `path`, and plugin-registered actions such as Advanced URI's `commandid` can write notes, open any folder
 * or run commands. A raw `+` is refused (`%2B` is fine) so every query decoder reads the same fields as this check.
 * Raw control characters are refused before parsing, since WHATWG URL parsing silently drops tabs and newlines. */
export function obsidianNoteUrl(rawUrl) {
  if (/\p{Cc}/u.test(rawUrl)) throw new Error("That Obsidian link is invalid");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That Obsidian link is invalid");
  }
  if (url.protocol !== "obsidian:") throw new Error("Only Obsidian links can open notes");
  if (url.host !== "open" || url.pathname !== "" || url.username || url.password || url.port || url.hash) {
    throw new Error("An Obsidian link only opens a note");
  }
  if (url.search.includes("+")) throw new Error("That Obsidian link is invalid");
  const fields = new Map();
  const query = url.search.slice(1);
  for (const pair of query ? query.split("&") : []) {
    const parts = pair.split("=");
    let name, value;
    try {
      [name, value] = parts.map(decodeURIComponent);
    } catch {
      throw new Error("That Obsidian link is invalid");
    }
    if (parts.length !== 2 || !OBSIDIAN_NOTE_FIELDS.has(name) || fields.has(name)) {
      throw new Error("An Obsidian link carries only a vault and a file");
    }
    if (!value.trim() || /\p{Cc}/u.test(value)) throw new Error("That Obsidian link is invalid");
    fields.set(name, value);
  }
  if (!fields.has("vault")) throw new Error("An Obsidian link names its vault");
  const file = fields.get("file");
  if (file !== undefined && (/^(?:[\\/~]|[a-zA-Z]:)/.test(file) || file.split(/[\\/]/).includes(".."))) {
    throw new Error("An Obsidian link opens a file inside its vault");
  }
  return url.toString();
}
