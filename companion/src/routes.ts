// What a paired device may ask for. Default deny: a route the harness adds
// later stays closed to phones until it is listed here.

export interface Denial {
  status: number;
  error: string;
}

export interface RouteRequest {
  path: string;
  method: string;
  authenticated: boolean;
}

/** The one companion route that crosses into full interactive desktop control. */
export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

/** A POST whose response is file bytes: a `.json` document must not go through
 * the JSON scrub and come back as different bytes. */
export const MESSAGE_FILE_ROUTE = {
  method: "POST",
  path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/,
} as const;

export const CLOUD_DESKTOP_CONTROL_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/(?:control|screenshot|viewer-close)$/,
} as const;

/** A separate grant from the cloud desktop: a cloud desktop is a disposable VM,
 * a bot's browser is normally signed into the person's real accounts. */
export const BROWSER_LIVE_ROUTE = {
  method: "GET",
  path: /^\/api\/bots\/[\w-]+\/browser\/live$/,
} as const;

export const BROWSER_ACTION_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/browser\/action$/,
} as const;

/** The harness grants it only while a person holds that bot's computer. */
export const LOCAL_VM_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/join$/,
} as const;

/** A still of a bot's Local VM; its lifecycle stays on the host. */
export const LOCAL_VM_SCREENSHOT_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/screenshot$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

export function isMessageFileDownload(method: string, path: string): boolean {
  return method === MESSAGE_FILE_ROUTE.method && MESSAGE_FILE_ROUTE.path.test(path);
}

/** Needs the device's computer-access capability, not just a token. */
export function isCloudDesktopAccess(method: string, path: string): boolean {
  return isCloudDesktopJoin(method, path)
    || (method === CLOUD_DESKTOP_CONTROL_ROUTE.method && CLOUD_DESKTOP_CONTROL_ROUTE.path.test(path))
    || (method === LOCAL_VM_SCREENSHOT_ROUTE.method && LOCAL_VM_SCREENSHOT_ROUTE.path.test(path))
    || (method === LOCAL_VM_JOIN_ROUTE.method && LOCAL_VM_JOIN_ROUTE.path.test(path));
}

/** Watching and driving are one permission: seeing a logged-in session is
 * already past the line. */
export function isBrowserControlAccess(method: string, path: string): boolean {
  return (method === BROWSER_LIVE_ROUTE.method && BROWSER_LIVE_ROUTE.path.test(path))
    || (method === BROWSER_ACTION_ROUTE.method && BROWSER_ACTION_ROUTE.path.test(path));
}

/** Every request the iOS app makes, and nothing else. Paths arrive undecoded
 * and are anchored at both ends, so an encoded traversal fails to match. */
const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  // Configured-or-not booleans, never keys; the write side is refused below.
  { method: "GET", path: /^\/api\/config$/ },
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },
  // The harness refuses it while any Claude turn runs. Instance ids may carry
  // dots, so a dots-only segment is refused outright.
  { method: "POST", path: /^\/api\/instances\/(?!\.+\/)[\w.-]+\/claude-update$/ },
  { method: "GET", path: /^\/api\/team-map$/ },
  // Sidecar-owned: the proxy answers it locally.
  { method: "GET", path: /^\/api\/companion\/endpoints$/ },

  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+$/ },
  // Can only file visible bots; cannot alter execution policy.
  { method: "POST", path: /^\/api\/sidebar-sections$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+\/steer$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  // A credential value crosses only as an HPKE envelope, bound to the
  // authenticated device and the exact pending card.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/provide$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/compact$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // Read-only: no settings, no transcript.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/overview$/ },
  // Read-only: no settings reachable through it.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/activity$/ },
  // Team memory edits are content, not execution policy. The section rides as
  // a query string.
  { method: "GET", path: /^\/api\/team-memory$/ },
  { method: "POST", path: /^\/api\/team-memory$/ },
  { method: "PATCH", path: /^\/api\/team-memory\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/team-memory\/[\w-]+$/ },
  // The harness rejects fields outside identity, soul (byte-capped), avatar,
  // notifications and voice preferences.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  // The harness validates the live catalog and refuses changes mid-turn.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/model$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // The proxy applies a second, per-device capability check.
  CLOUD_DESKTOP_JOIN_ROUTE,

  CLOUD_DESKTOP_CONTROL_ROUTE,
  // Behind a second per-device capability check in the proxy.
  BROWSER_LIVE_ROUTE,
  BROWSER_ACTION_ROUTE,
  // Behind the computer-access capability, like the cloud desktop.
  LOCAL_VM_SCREENSHOT_ROUTE,
  // Behind the same capability, while a person holds the computer.
  LOCAL_VM_JOIN_ROUTE,
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+\/steer$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },

  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  // An app row's document is transcript data, scoped to its thread. `rpc` reaches only the app's own MCP
  // server, under the bot's tool selection and approval rules; `context` is bounded text.
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/app$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/apps\/[\w-]+\/rpc$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/apps\/[\w-]+\/context$/ },
  MESSAGE_FILE_ROUTE,
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { method: "GET", path: /^\/api\/search$/ },

  // Upload is image-only and capped by the harness; GET is a single generated
  // filename, never a path.
  { method: "POST", path: /^\/api\/attachments$/ },
  // The harness honors Range on voice notes so a phone player can seek.
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp|mp3|wav)$/i },
  // Raw upload, capped and stored under a generated filename by the harness.
  { method: "POST", path: /^\/api\/files$/ },

  // Never expose or mutate the workspace ElevenLabs key.
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/prepare$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },

  // The phone holds its own WebRTC audio; the Mac creates the session, so the
  // key never leaves it.
  { method: "POST", path: /^\/api\/live\/session$/ },
  { method: "POST", path: /^\/api\/live\/call\/end$/ },
  { method: "GET", path: /^\/api\/live\/call$/ },
  { method: "PATCH", path: /^\/api\/live\/settings$/ },

  // The harness records only the owner's activation; a guest's is answered and
  // dropped.
  { method: "POST", path: /^\/api\/presence\/active$/ },

  // Webhook management stays denied below.
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },
  { method: "POST", path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },

  // Opaque ids and aliases only. Account removal is allowed (the handler proves
  // ownership first); the whole-service DELETE stays with the host.
  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },
  { method: "POST", path: /^\/api\/connectors\/[\w-]+\/authorize$/ },
  { method: "DELETE", path: /^\/api\/connectors\/[\w-]+\/accounts\/[\w-]+$/ },
  // Scoped to one pending card: poll, resume or dismiss it.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:authorize|resume|dismiss)$/ },
  // Decline or retry only: a remote client never claims it stored a host
  // credential.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  // Nothing secret crosses this route, only "done" or "cancel".
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/sign-in-cards\/[\w-]+\/(?:done|cancel)$/ },
];

/** Sent by the companion itself, never a device: not in ALLOWED, so a phone is
 * refused, and the harness accepts them only with the relay token or from
 * loopback. `device-revoked` ends the Live call an unpaired phone holds. */
const COMPANION_NOTICES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/live\/device-revoked$/ },
];

export function isCompanionNotice(method: string, path: string): boolean {
  return COMPANION_NOTICES.some((route) => route.method === method && route.path.test(path));
}

/** Denied either way; these get a sentence instead of a 404. First match wins. */
const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    // Losing the phone must not mean losing the ability to lock it out.
    error: "Remote access settings are managed on the host computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    // Creating one exposes an endpoint to the internet.
    path: /^\/api\/webhooks(\/|$)/,
    error: "webhooks are set up on your computer",
  },
  { path: /^\/api\/connectors(\/|$)/, error: "connected apps are set up on your computer" },
  {
    path: /^\/api\/routines(\/|$)/,
    error: "this routine operation is only available on your computer",
  },
  { path: /^\/api\/teams(\/|$)/, error: "teams are imported and exported on your computer" },
];

/** Default deny: anything not listed is "no route", so a stolen token cannot
 * map the API. */
export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  // Pairing is the one thing a device does before it has a credential.
  if (method === "POST" && path === "/api/pair") return null;
  // Liveness is open too: the first thing anyone curls when pairing fails, and
  // it discloses nothing a port scan would not.
  if (method === "GET" && path === "/api/health") return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from Remote access settings on the host computer" };
  }

  if (ALLOWED.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  // "No route" rather than "not allowed", so a stolen token cannot enumerate
  // the API.
  return { status: 404, error: `no route: ${method} ${path}` };
}
