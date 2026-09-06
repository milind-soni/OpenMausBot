// What a paired device is allowed to ask for.
//
// The default is deny, and that direction is the whole point: the sidecar
// sits in front of an API it does not own and cannot see the future of. A
// route that appears in the harness later is closed to phones until someone
// decides otherwise, because the alternative is that every upstream release
// silently widens what a lost phone can reach.
//
// This file used to claim that and not do it — it listed refusals and let
// everything else under `/api/` through. In the time between writing it and
// noticing, upstream added webhook triggers, connected-app authorisation and
// routines, all of which a paired phone could drive: minting an
// internet-reachable trigger, rotating a signing secret out from under
// whatever was sending to it, disconnecting a Google account. None of that
// was a decision anyone made. It was the default.
//
// So the list below is the surface, derived from what the app actually
// calls. Adding a feature to the phone means adding its route here, on
// purpose, in a diff someone can read. That cost is the feature.

/** A refusal to send back, or null to let the request through. */
export interface Denial {
  status: number;
  error: string;
}

/** One request, reduced to what the allowlist decides on. */
export interface RouteRequest {
  path: string;
  method: string;
  /** Whether the bearer token on the request matched a paired device. */
  authenticated: boolean;
}

/** The one companion route that crosses into full interactive desktop
 * control. Both the allowlist and capability gate consume this classifier so
 * their security decisions cannot drift apart. */
export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

/** A POST whose response is file bytes. Keep this exact classifier shared
 * with the proxy: a `.json` document must not enter the ordinary JSON
 * scrub/re-serialise path and come back as different bytes. */
export const MESSAGE_FILE_ROUTE = {
  method: "POST",
  path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/,
} as const;

export const CLOUD_DESKTOP_CONTROL_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/(?:control|screenshot|viewer-close)$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

export function isMessageFileDownload(method: string, path: string): boolean {
  return method === MESSAGE_FILE_ROUTE.method && MESSAGE_FILE_ROUTE.path.test(path);
}

export function isCloudDesktopAccess(method: string, path: string): boolean {
  return isCloudDesktopJoin(method, path)
    || (method === CLOUD_DESKTOP_CONTROL_ROUTE.method && CLOUD_DESKTOP_CONTROL_ROUTE.path.test(path));
}

/** Every request the iOS app makes, and nothing else.
 *
 * Ids are `[\w-]+`, matching the harness's own route patterns. The paths
 * arrive undecoded and are anchored at both ends, so an encoded traversal
 * fails to match and is denied rather than forwarded — the failure mode of
 * a strict pattern is a closed door, which is the one to have. */
const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  // configured-or-not booleans. The write side is refused below: reading
  // which providers are set up is not reading their keys.
  { method: "GET", path: /^\/api\/config$/ },
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },
  { method: "GET", path: /^\/api\/team-map$/ },
  // Sidecar-owned, authenticated endpoint metadata. The proxy terminates it
  // locally; it never becomes a newly exposed harness route.
  { method: "GET", path: /^\/api\/companion\/endpoints$/ },

  // the fleet, and making a bot
  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  // One narrow, atomic organizer write. This can only file visible bots;
  // unlike the desktop's broad PATCH it cannot alter execution policy.
  { method: "POST", path: /^\/api\/sidebar-sections$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  // A credential value crosses this one route only as an HPKE envelope. The
  // server binds it to the authenticated device and exact pending card before
  // Electron opens it into the OS-encrypted credential store.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/provide$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // Read-only summary: who the bot is, what it does and won't do, and its
  // recent activity. No settings, no transcript — read on open and on
  // pull-to-refresh.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/overview$/ },
  // Paired-safe profile subset. The harness route itself rejects fields
  // outside identity, standing instructions (soul, byte-capped), avatar,
  // notifications, and voice preferences.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  // Full model selection, but no other bot settings. The harness validates
  // the live catalog and refuses changes while the bot is working.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/model$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // Full cloud desktop access. The route is narrow and the proxy applies a
  // second, per-device capability check before it reaches the harness.
  CLOUD_DESKTOP_JOIN_ROUTE,

  CLOUD_DESKTOP_CONTROL_ROUTE,
  // rooms — making one, and talking in one
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },

  // a transcript, its images, and answering an approval
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  MESSAGE_FILE_ROUTE,
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { method: "GET", path: /^\/api\/search$/ },

  // App-owned profile images. Upload is image-only and capped at 10 MB by
  // the harness; GET is a single bare generated filename, never a path.
  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i },
  // Share-sheet documents are raw, capped at 25 MiB, and stored under a
  // generated filename by the harness. The display name stays in the query;
  // only this exact upload route crosses the companion boundary.
  { method: "POST", path: /^\/api\/files$/ },

  // Renderer-neutral voice operations. These routes never expose or mutate
  // the workspace ElevenLabs key; the client receives labels or audio only.
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/prepare$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },

  // Routines create ordinary tasks using an existing agent configuration.
  // Webhook management remains explicitly denied below.
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },
  { method: "POST", path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },

  // Multi-account Composio management exposes opaque ids and aliases only.
  // Revocation stays on the host: the account DELETE route is deliberately
  // absent — a paired client can see and add accounts, never remove one.
  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },
  { method: "POST", path: /^\/api\/connectors\/[\w-]+\/authorize$/ },
  // Inline connector cards are scoped by bot, transcript message, and
  // thread. They expose the same opaque OAuth authorization already allowed
  // above, then only poll, resume, or dismiss that exact pending card.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:authorize|resume|dismiss)$/ },
  // A remote client may decline or retry a credential request, but never
  // claim that it stored a host credential. Saving and `provided` stay local
  // to the host's OS-backed credential store.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss)$/ },
];

/** Route families worth naming in the refusal.
 *
 * Everything not allowed is denied either way; this only decides whether the
 * person gets a sentence or a 404. These are the ones someone might
 * reasonably expect to work from the phone, where "no route" would read as a
 * bug in the companion rather than a decision about where host configuration
 * happens. Order matters only in that the first match wins. */
const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    // Losing the phone must not mean losing the ability to lock it out.
    error: "Remote access settings are managed on the host computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    // Creating one exposes an endpoint to the internet, and rotating a
    // secret breaks whatever was sending to it. Neither belongs on a device
    // that lives in a pocket.
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

/** Why this request may not go through, or null when it may.
 *
 * Default deny: the answer for anything not on the list is "no route", which
 * is what keeps a stolen token from mapping the API. An allowlist rather than
 * a blocklist is the property this whole module exists for, and the one that
 * quietly stopped being true once before. */
export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  // Pairing is the one thing a device does before it has a credential.
  if (method === "POST" && path === "/api/pair") return null;
  // Liveness is the other: it exists to be the first thing anyone curls when
  // pairing will not work, and behind the token check it answered 401 to
  // exactly the person it was for — which reads as "broken" rather than
  // "unpaired". It discloses nothing a port scan would not.
  if (method === "GET" && path === "/api/health") return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from Remote access settings on the host computer" };
  }

  if (ALLOWED.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  // Everything else, including routes the harness really does have. Saying
  // "no route" rather than "not allowed" keeps the sidecar from enumerating
  // the API to anyone holding a stolen token — and it is what the peer-agent
  // endpoints under /api/internal/ always got, since off this machine they
  // genuinely do not exist.
  return { status: 404, error: `no route: ${method} ${path}` };
}
