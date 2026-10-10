// Saved environments for the desktop app, pure and testable.
//
// "This computer" (LOCAL_ID) is the server this app spawns from the default
// data dir; a remote environment is a server the user paired with
// ({id, kind:"remote", name, origin}); a named local environment is another
// data directory the same server can be restarted onto
// ({id, kind:"local", name, dataDir}). The app switches by loading that
// environment, so an entry only names a destination. The session credential
// for a remote is the HttpOnly cookie the /pair page set for that origin,
// held by Chromium's cookie jar, never by this file.
const LOCAL_ID = "local";
const MAX_NAME = 60;

/** `https://host[:port]` — a bare origin, no path, no credentials. */
function normalizeOrigin(input) {
  if (typeof input !== "string") return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** Turn what the server printed — `https://host/pair#code=XXXX-XXXX-XXXX`,
 * or just an origin — into where to go. The code stays in the hash, so the
 * page consumes it and it never reaches a server log. */
function parsePairingLink(input) {
  const origin = normalizeOrigin(input);
  if (!origin) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // A code travels in the hash only: a query string reaches server logs.
  if (url.searchParams.has("code")) return null;
  const code = /(?:^|[#&])code=([^&]+)/.exec(url.hash)?.[1] ?? null;
  const isPairPage = url.pathname === "/pair" || url.pathname === "/pair/";
  if (code && !isPairPage) return null; // a code belongs on /pair; anything else is not a pairing link
  try {
    return { origin, code: code ? decodeURIComponent(code) : null, url: code ? `${origin}/pair#code=${code}` : origin };
  } catch {
    return null;
  }
}

/** The desktop connection form accepts a hostname, HTTPS address or pairing
 * link. Keep codes out of queries/history and refuse unrelated URL paths. */
function parseHostedWorkspaceLink(input) {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || /[\s\\]/.test(text)) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || !["/", "/pair", "/pair/"].includes(url.pathname)) return null;
    if (!loopback && !url.hostname.includes(".")) return null;
    const parsed = parsePairingLink(url.href);
    if (!parsed || (url.hash && (!parsed.code || !/^[A-Z0-9-]{12,16}$/i.test(parsed.code)))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remote renderers learn only their current workspace, not the local list.
 * A named local environment stays "this computer" — it is another data dir
 * of the same machine, so it reports local:true with its path; `missing`
 * mirrors the flag the main process stamps on the entry at read time. */
function workspaceSummary(state) {
  const active = activeEnvironment(state);
  if (!active) return { local: true, name: "This computer" };
  if (active.kind === "local") return { local: true, name: active.name, localPath: active.dataDir, missing: active.missing === true };
  return { local: false, name: active.name, origin: active.origin };
}

/** Native identity must not depend on a hosted renderer's version/title. */
function workspaceWindowTitle(state, companion) {
  if (companion) return `OpenMausBot — Connected to: ${companion.serverName} (${new URL(companion.endpoint).host})`;
  const active = activeEnvironment(state);
  if (active && active.kind !== "local") return `OpenMausBot — Hosted: ${active.name} (${new URL(active.origin).host})`;
  return "OpenMausBot";
}

/** Renderer navigation stays in the selected workspace. Switching is a main
 * process action; a cloud page must not navigate itself onto the local bridge. */
function workspaceNavigationAllowed(url, state, localOrigin) {
  try {
    return new URL(url).origin === (activeEnvironment(state)?.origin ?? localOrigin);
  } catch {
    return false;
  }
}

/** Only the main window's main frame may request this deliberately small
 * shell surface. Being embedded in a saved server grants no host authority. */
function workspaceSenderAllowed(event, contents, state, localOrigin) {
  if (!contents || event?.sender !== contents || event?.senderFrame !== contents.mainFrame) return false;
  try {
    return workspaceNavigationAllowed(event.senderFrame.url, state, localOrigin);
  } catch {
    return false;
  }
}

/** Native menu choices, never renderer-supplied destinations or callbacks. */
/** The sidebar's server menu. `onAddCloud`: "Add a Cloud…" just under the
 * saved servers, only where main offers OpenMausBot Cloud (cloudOffersAllowed);
 * `sublabels`: a saved server's line under its name in place of its host (My
 * Cloud's "Always on"). */
function workspaceMenuTemplate(state, { onSwitch, onConnect, onForget, onAddCloud, sublabels = {} }) {
  const active = activeEnvironment(state);
  return [
    { id: "workspace-local", label: "This computer", type: "radio", checked: !active, click: () => onSwitch(LOCAL_ID) },
    ...state.environments.map((entry) => ({
      id: `workspace-${entry.id}`, label: entry.name, sublabel: Object.hasOwn(sublabels, entry.id) ? sublabels[entry.id] : entry.kind === "local" ? entry.dataDir : new URL(entry.origin).host,
      type: "radio", checked: entry.id === state.activeId, click: () => onSwitch(entry.id),
    })),
    ...(onAddCloud ? [{ id: "workspace-add-cloud", label: "Add a Cloud…", sublabel: "Keeps your bots running 24/7", click: onAddCloud }] : []),
    { type: "separator" },
    { id: "workspace-connect", label: "Connect to a server…", click: onConnect },
    ...(active ? [{ id: "workspace-forget", label: `Forget “${active.name}”…`, click: () => onForget(active.id) }] : []),
  ];
}

function cleanName(value, fallback) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME) : "";
  return name || fallback;
}

function nameFromOrigin(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** An environment directory is absolute or it is nothing: relative paths
 * would silently follow the app's cwd, and `~` is a shell illusion here.
 * Three absolute shapes are recognized by pattern alone — POSIX `/…`,
 * a Windows drive `X:\` or `X:/`, and a UNC `\\server\share` — because a
 * path module would resolve relative to this app's cwd and platform. */
function cleanDataDir(value) {
  if (typeof value !== "string") return null;
  const dir = value.trim();
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(dir) ? dir : null;
}

function dirBasename(dir) {
  const parts = pathKey(dir).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

/** Comparison key for directory paths. Windows-shaped paths (drive-letter or
 * UNC) compare slash-normalized and case-insensitively — Windows itself is
 * case-insensitive, and the same folder can reach us with either separator.
 * POSIX paths compare as written. */
function pathKey(dir) {
  let d = String(dir).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(d) || d.startsWith("//")) d = d.toLowerCase();
  return d;
}

/** Comparisons run on trailing-`/` paths so `/a/b` never matches `/a/bc`. */
function asDirPrefix(dir) {
  const d = pathKey(dir);
  return d.endsWith("/") ? d : `${d}/`;
}

function cleanId(entry) {
  return typeof entry?.id === "string" && /^[\w-]{1,64}$/.test(entry.id) && entry.id !== LOCAL_ID ? entry.id : null;
}

/** Parse the persisted file (version 1 or 2). Unknown or damaged content
 * yields the empty state rather than an error: losing a saved list costs a
 * re-pair, not the app. Version 1 entries are all remote; a missing version
 * predates the field and reads as version 1. */
function parseEnvironments(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { environments: [], activeId: LOCAL_ID };
  }
  const version = value?.version ?? 1;
  if (version !== 1 && version !== 2) return { environments: [], activeId: LOCAL_ID };
  const list = Array.isArray(value?.environments) ? value.environments : [];
  const seen = new Set();
  const environments = [];
  for (const entry of list) {
    const id = cleanId(entry);
    if (!id || seen.has(id)) continue;
    const dataDir = cleanDataDir(entry?.dataDir);
    if (entry?.kind === "local") {
      // Dedup on the same normalized key withLocalEnvironment uses, so a
      // manual or older write of the same folder (trailing slash, separator
      // style, drive case) never registers two owners of one directory.
      const dirKey = dataDir ? `dir:${asDirPrefix(dataDir)}` : null;
      if (!dataDir || seen.has(dirKey)) continue;
      seen.add(id);
      seen.add(dirKey);
      environments.push({ id, kind: "local", name: cleanName(entry.name, dirBasename(dataDir)), dataDir });
      continue;
    }
    const origin = normalizeOrigin(entry?.origin);
    if (!origin || (entry?.kind !== undefined && entry.kind !== "remote") || seen.has(origin)) continue;
    seen.add(id);
    seen.add(origin);
    environments.push({ id, kind: "remote", name: cleanName(entry?.name, nameFromOrigin(origin)), origin });
  }
  const activeId = typeof value?.activeId === "string" && environments.some((e) => e.id === value.activeId) ? value.activeId : LOCAL_ID;
  return { environments, activeId };
}

function serializeEnvironments(state) {
  return JSON.stringify({ version: 2, environments: state.environments, activeId: state.activeId }, null, 2) + "\n";
}

/** Add or update by origin (re-pairing the same server keeps one entry). */
function withEnvironment(state, input, makeId) {
  const origin = normalizeOrigin(input?.origin);
  if (!origin) return state;
  const existing = state.environments.find((e) => e.origin === origin);
  if (existing) {
    const name = cleanName(input?.name, existing.name);
    const environments = state.environments.map((e) => (e === existing ? { ...e, kind: "remote", name } : e));
    return { ...state, environments };
  }
  const id = makeId();
  const environments = [...state.environments, { id, kind: "remote", name: cleanName(input?.name, nameFromOrigin(origin)), origin }];
  return { ...state, environments };
}

/** Register a named local environment — another data directory this app can
 * restart onto. It may not be the default dir (that is "This computer",
 * addressable without an entry) and may not contain or sit inside a
 * registered environment's dir or the default: one environment inside
 * another would put one setup's state files under another's management. */
function withLocalEnvironment(state, input, makeId, defaultDir) {
  const name = typeof input?.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME) return { ok: false, error: "name" };
  const dataDir = cleanDataDir(input?.dataDir);
  if (!dataDir) return { ok: false, error: "path" };
  const candidate = asDirPrefix(dataDir);
  const locals = state.environments.filter((e) => e.kind === "local");
  if (locals.some((e) => asDirPrefix(e.dataDir) === candidate)) return { ok: false, error: "duplicate" };
  // Two-way containment for registered local dirs: the candidate inside one,
  // or the candidate swallowing one. The candidate inside the default dir is
  // refused as before.
  const insideKnown = (dir) => candidate.startsWith(asDirPrefix(dir));
  const containsKnown = (dir) => asDirPrefix(dir).startsWith(candidate);
  if (locals.some((e) => insideKnown(e.dataDir) || containsKnown(e.dataDir))) return { ok: false, error: "nested" };
  if (typeof defaultDir === "string" && defaultDir && insideKnown(defaultDir)) return { ok: false, error: "nested" };
  const environments = [...state.environments, { id: makeId(), kind: "local", name, dataDir }];
  return { ok: true, state: { ...state, environments } };
}

/** The data dir the server child must run on, when a named local environment
 * is active; null means the caller's own default dir. `_defaultDir` stays in
 * the signature for its callers' symmetry — "This computer" has no entry. */
function activeLocalDataDir(state, _defaultDir) {
  const active = activeEnvironment(state);
  return active?.kind === "local" && typeof active.dataDir === "string" ? active.dataDir : null;
}

/** The directory a launch (or a recovery restart) owns: the active named
 * local environment's dir, else the caller's default. */
function startupEnvironmentDir(state, defaultDir) {
  return activeLocalDataDir(state, defaultDir) ?? defaultDir;
}

/** The boot decision for a packaged launch. A named local environment whose
 * directory is missing (the `missing` stamp readEnvironments takes right
 * before boot) must NOT be leased or created: mkdir would silently raise an
 * empty setup where the person's data used to be. Boot on the default dir
 * and flag the fallback so the caller can say so. The default dir itself is
 * never refused — a first boot is allowed to create it. */
function bootEnvironmentDir(state, defaultDir) {
  const active = activeEnvironment(state);
  if (active?.kind === "local" && typeof active.dataDir === "string" && active.missing === true) {
    return { dataDir: defaultDir, fellBack: true, missingDir: active.dataDir };
  }
  return { dataDir: startupEnvironmentDir(state, defaultDir), fellBack: false, missingDir: null };
}

function withoutEnvironment(state, id) {
  const environments = state.environments.filter((e) => e.id !== id);
  return { environments, activeId: state.activeId === id ? LOCAL_ID : state.activeId };
}

function withActive(state, id) {
  if (id !== LOCAL_ID && !state.environments.some((e) => e.id === id)) return state;
  return { ...state, activeId: id };
}

function activeEnvironment(state) {
  return state.environments.find((e) => e.id === state.activeId) ?? null;
}

/** The active entry when a REMOTE server is shown — null for "This computer"
 * and for a named local environment, which both serve this computer's own
 * renderer. Sites that branch on "a remote server is on screen" must use
 * this, not `activeEnvironment`. */
function activeRemote(state) {
  const active = activeEnvironment(state);
  return active && active.kind !== "local" ? active : null;
}

/** Origins the main window may navigate to: Local plus every saved server. */
function allowedOrigins(state, localOrigin) {
  return new Set([localOrigin, ...state.environments.map((e) => e.origin).filter(Boolean)]);
}

module.exports = {
  LOCAL_ID,
  activeEnvironment,
  activeLocalDataDir,
  activeRemote,
  allowedOrigins,
  bootEnvironmentDir,
  normalizeOrigin,
  parseEnvironments,
  parsePairingLink,
  parseHostedWorkspaceLink,
  serializeEnvironments,
  startupEnvironmentDir,
  withActive,
  withEnvironment,
  withLocalEnvironment,
  withoutEnvironment,
  workspaceMenuTemplate,
  workspaceNavigationAllowed,
  workspaceSenderAllowed,
  workspaceSummary,
  workspaceWindowTitle,
};
