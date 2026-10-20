// A remote's session credential is the HttpOnly cookie /pair set, held by Chromium's cookie jar, never by this file.
const LOCAL_ID = "local";
const MAX_NAME = 60;
/** A saved server's colour: one of these names, never a value a page could style with. The renderer maps each to its skin's tone. */
const ENTRY_COLORS = Object.freeze(["blue", "teal", "purple", "orange", "red", "yellow"]);
const cleanColor = (value) => (ENTRY_COLORS.includes(value) ? value : null);

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
  if (code && !isPairPage) return null;
  try {
    return { origin, code: code ? decodeURIComponent(code) : null, url: code ? `${origin}/pair#code=${code}` : origin };
  } catch {
    return null;
  }
}

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

/** Remote renderers learn only their current workspace, never the local list. */
function workspaceSummary(state) {
  const active = activeEnvironment(state);
  if (!active) return { local: true, name: "This computer" };
  if (active.kind === "local") return { local: true, name: active.name, localPath: active.dataDir, missing: active.missing === true };
  return { local: false, name: active.name, origin: active.origin, ...(cleanColor(active.color) ? { color: active.color } : {}) };
}

/** Native identity must not depend on a hosted renderer's version/title. */
function workspaceWindowTitle(state, companion) {
  if (companion) return `OpenMausBot — Connected to: ${companion.serverName} (${new URL(companion.endpoint).host})`;
  const active = activeEnvironment(state);
  if (active && active.kind !== "local") return `OpenMausBot — Hosted: ${active.name} (${new URL(active.origin).host})`;
  return "OpenMausBot";
}

/** Switching is a main-process action; a cloud page must not navigate itself onto the local bridge. */
function workspaceNavigationAllowed(url, state, localOrigin) {
  try {
    return new URL(url).origin === (activeEnvironment(state)?.origin ?? localOrigin);
  } catch {
    return false;
  }
}

/** Only the main window's main frame; being embedded in a saved server grants no host authority. */
function workspaceSenderAllowed(event, contents, state, localOrigin) {
  if (!contents || event?.sender !== contents || event?.senderFrame !== contents.mainFrame) return false;
  try {
    return workspaceNavigationAllowed(event.senderFrame.url, state, localOrigin);
  } catch {
    return false;
  }
}

/** Native menu choices, never renderer-supplied destinations or callbacks. `iconFor`: a saved colour's small dot, when main can draw one.
 * `places`: the one line saying which side has which bots, shown first; `copyToCloud`: the send line under the list. `foldSublabels`: where menus show no sublabels (Windows, Linux), My Cloud's status line
 * joins its name instead of vanishing. `together`: while this computer has My Cloud, the setting that shows both as one
 * entry (`on`), My Cloud's saved id, that entry's label and the line under it (`detail`). */
function workspaceMenuTemplate(state, { onSwitch, onConnect, onForget, onAddCloud, sublabels = {}, iconFor = null, places = null, copyToCloud = null, foldSublabels = false, together = null }) {
  const active = activeEnvironment(state);
  const merged = together?.on === true;
  const onMerged = merged && (!active || active.id === together.cloudId);
  const mergedStatus = merged && Object.hasOwn(sublabels, together.cloudId) ? sublabels[together.cloudId] : null;
  const mergedSublabel = merged ? [together.detail, mergedStatus].filter(Boolean).join(" · ") : null;
  return [
    ...(places && !merged ? [{ id: "workspace-places", label: places, enabled: false }, { type: "separator" }] : []),
    merged
      ? { id: "workspace-local", label: foldSublabels && mergedSublabel ? `${together.label} · ${mergedSublabel}` : together.label, ...(mergedSublabel ? { sublabel: mergedSublabel } : {}),
        type: "radio", checked: onMerged, click: () => { if (!onMerged) onSwitch(LOCAL_ID); } }
      : { id: "workspace-local", label: "This computer", type: "radio", checked: !active, click: () => onSwitch(LOCAL_ID) },
    ...state.environments.filter((entry) => !merged || entry.id !== together.cloudId).map((entry) => {
      const icon = iconFor && cleanColor(entry.color) ? iconFor(entry.color) : null;
      const status = Object.hasOwn(sublabels, entry.id) ? sublabels[entry.id] : null;
      return {
        id: `workspace-${entry.id}`, label: foldSublabels && status ? `${entry.name} · ${status}` : entry.name,
        sublabel: status ?? (entry.kind === "local" ? entry.dataDir : new URL(entry.origin).host),
        ...(icon ? { icon } : {}), type: "radio", checked: entry.id === state.activeId, click: () => onSwitch(entry.id),
      };
    }),
    ...(copyToCloud ? [{ id: "workspace-copy-to-cloud", label: copyToCloud.label, click: copyToCloud.click }] : []),
    ...(together ? [{ id: "workspace-together", label: "Show all bots together", type: "checkbox", checked: merged, click: together.onToggle }] : []),
    ...(onAddCloud ? [{ id: "workspace-add-cloud", label: "Add a Cloud…", sublabel: "Keeps your bots running 24/7", click: onAddCloud }] : []),
    { type: "separator" },
    { id: "workspace-connect", label: "Connect to a server…", click: onConnect },
    ...(active ? [{ id: "workspace-forget", label: `Forget “${active.name}”…`, click: () => onForget(active.id) }] : []),
  ];
}

/** "Ember", "Ember and Juno", "Ember, Juno and 2 more". */
function botList(names, shown = 2) {
  const clean = names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().replace(/\s+/g, " ").slice(0, 40));
  if (clean.length <= shown + 1) return clean.length > 1 ? `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}` : clean[0] ?? "";
  return `${clean.slice(0, shown).join(", ")} and ${clean.length - shown} more`;
}

/** Bots, chats and skills live on each side by design; this says which side has which, from where the person is now. */
function placesLine({ cloudName = "My Cloud", onCloud, localBots }) {
  const names = botList(localBots);
  if (onCloud) return names ? `Your bots live on ${cloudName}. This computer has its own: ${names}.` : `Your bots live on ${cloudName}. This computer has none of its own.`;
  return names ? `These bots live on this computer: ${names}. ${cloudName} has its own.` : `This computer has no bots of its own yet. ${cloudName} has its own.`;
}

/** One line under My Cloud: what of this computer's is not on it yet, with Send (Send to My Cloud, cloud-send.mjs), or
 * the way to the side-by-side page when nothing waits. */
function sendLine({ cloudName = "My Cloud", waiting }) {
  const total = waiting?.total ?? 0, bots = waiting?.bots ?? 0;
  if (!total) return null;
  const what = bots ? `${bots === 1 ? "1 bot" : `${bots} bots`}${total > bots ? ` and ${total - bots} more` : ""}` : total === 1 ? "1 change" : `${total} changes`;
  return `${what} not on ${cloudName} · Send`;
}

/** The switcher's extra options once the person has My Cloud: the places line, the send line, and the Cloud's status
 * beside its name where menus show no sublabels. Bot names come from this computer's own server; when it does not
 * answer at once the line is left out, never guessed. `send`: what waits (main's last comparison) and its actions. */
async function placesMenuOptions({ cloud, activeId, platform, port, send = null,
  localBots = () => fetch(`http://127.0.0.1:${port}/api/bots`, { signal: AbortSignal.timeout(700) }).then((response) => response.json()) }) {
  const foldSublabels = platform !== "darwin";
  if (!cloud) return { foldSublabels };
  let names = null;
  try { const listed = await localBots(); names = Array.isArray(listed?.bots) ? listed.bots.map((bot) => bot?.name) : null; } catch {}
  const waiting = sendLine({ cloudName: cloud.name, waiting: send?.waiting });
  return {
    foldSublabels,
    ...(send ? { copyToCloud: waiting ? { label: waiting, click: send.onSend } : { label: `This computer and ${cloud.name}…`, click: send.onOpen } } : {}),
    ...(names ? { places: placesLine({ cloudName: cloud.name, onCloud: activeId === cloud.id, localBots: names }) } : {}),
  };
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

/** Absolute or nothing, by pattern (POSIX, drive, UNC): a path module would resolve against this app's cwd and platform. */
function cleanDataDir(value) {
  if (typeof value !== "string") return null;
  const dir = value.trim();
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(dir) ? dir : null;
}

function dirBasename(dir) {
  const parts = pathKey(dir).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

/** Windows-shaped paths compare slash-normalized and case-insensitively, as Windows does; POSIX as written. */
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
      // The same normalized key withLocalEnvironment uses, so one folder never gets two owners.
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
    const color = cleanColor(entry?.color);
    environments.push({ id, kind: "remote", name: cleanName(entry?.name, nameFromOrigin(origin)), origin, ...(entry?.microphone === true ? { microphone: true } : {}),
      ...(color ? { color } : {}), ...(entry?.home === true ? { home: true } : {}) });
  }
  const activeId = typeof value?.activeId === "string" && environments.some((e) => e.id === value.activeId) ? value.activeId : LOCAL_ID;
  return { environments, activeId };
}

function serializeEnvironments(state) {
  return JSON.stringify({ version: 2, environments: state.environments, activeId: state.activeId }, null, 2) + "\n";
}

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

/** A saved server's name and colour, as its owner chose them (the Cloud's own setup); an invalid colour is left as it was. */
function withEnvironmentLook(state, origin, { name, color } = {}) {
  const key = normalizeOrigin(origin);
  const existing = key ? state.environments.find((e) => e.origin === key) : null;
  if (!existing) return state;
  const next = { ...existing, name: cleanName(name, existing.name), ...(cleanColor(color) ? { color } : {}) };
  if (next.name === existing.name && next.color === existing.color) return state;
  return { ...state, environments: state.environments.map((e) => (e === existing ? next : e)) };
}

function withLocalEnvironment(state, input, makeId, defaultDir) {
  const name = typeof input?.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME) return { ok: false, error: "name" };
  const dataDir = cleanDataDir(input?.dataDir);
  if (!dataDir) return { ok: false, error: "path" };
  const candidate = asDirPrefix(dataDir);
  const locals = state.environments.filter((e) => e.kind === "local");
  if (locals.some((e) => asDirPrefix(e.dataDir) === candidate)) return { ok: false, error: "duplicate" };
  const insideKnown = (dir) => candidate.startsWith(asDirPrefix(dir));
  const containsKnown = (dir) => asDirPrefix(dir).startsWith(candidate);
  if (locals.some((e) => insideKnown(e.dataDir) || containsKnown(e.dataDir))) return { ok: false, error: "nested" };
  if (typeof defaultDir === "string" && defaultDir && insideKnown(defaultDir)) return { ok: false, error: "nested" };
  const environments = [...state.environments, { id: makeId(), kind: "local", name, dataDir }];
  return { ok: true, state: { ...state, environments } };
}

function activeLocalDataDir(state, _defaultDir) {
  const active = activeEnvironment(state);
  return active?.kind === "local" && typeof active.dataDir === "string" ? active.dataDir : null;
}

function startupEnvironmentDir(state, defaultDir) {
  return activeLocalDataDir(state, defaultDir) ?? defaultDir;
}

/** A named environment whose folder is missing is never leased or created: boot on the default dir and flag it. */
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

function withMicrophone(state, id) {
  if (!state.environments.some((e) => e.id === id)) return state;
  return { ...state, environments: state.environments.map((e) => (e.id === id ? { ...e, microphone: true } : e)) };
}

function withActive(state, id) {
  if (id !== LOCAL_ID && !state.environments.some((e) => e.id === id)) return state;
  return { ...state, activeId: id };
}

function activeEnvironment(state) {
  return state.environments.find((e) => e.id === state.activeId) ?? null;
}

/** Null for "This computer" and named local environments: branch on this, not activeEnvironment, for "a remote is on screen". */
function activeRemote(state) {
  const active = activeEnvironment(state);
  return active && active.kind !== "local" ? active : null;
}

function allowedOrigins(state, localOrigin) {
  return new Set([localOrigin, ...state.environments.map((e) => e.origin).filter(Boolean)]);
}

module.exports = {
  ENTRY_COLORS,
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
  withEnvironmentLook,
  withLocalEnvironment,
  withMicrophone,
  withoutEnvironment,
  workspaceMenuTemplate,
  placesLine,
  placesMenuOptions,
  sendLine,
  workspaceNavigationAllowed,
  workspaceSenderAllowed,
  workspaceSummary,
  workspaceWindowTitle,
};
