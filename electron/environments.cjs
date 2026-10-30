// A remote's session credential is the HttpOnly cookie /pair set, held by Chromium's cookie jar, never by this file.
const LOCAL_ID = "local";
const MAX_NAME = 60;
/** A saved server's colour: one of these names, never a value a page could style with. The renderer maps each to its skin's tone. */
const ENTRY_COLORS = Object.freeze(["blue", "teal", "purple", "orange", "red", "yellow"]);
const cleanColor = (value) => (ENTRY_COLORS.includes(value) ? value : null);
/** A team's Cloud is listed by the verified session (`team`: its id and this person's role), never by a page. */
const TEAM_ROLES = Object.freeze(["owner", "admin", "member"]);
const TEAM_ROLE_LABELS = Object.freeze({ owner: "Super admin", admin: "Admin", member: "User" });
const teamRoleLabel = (role) => TEAM_ROLE_LABELS[role] ?? TEAM_ROLE_LABELS.member;
const cleanTeam = (value) => (value && typeof value === "object" && typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) && TEAM_ROLES.includes(value.role)
  ? { id: value.id, role: value.role } : null);
/** A Cloud of the person's own besides My Cloud is listed by the verified session too (`cloud`: its id and their role). */
const cleanCloud = (value) => (value && typeof value === "object" && typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.id) && TEAM_ROLES.includes(value.role)
  ? { id: value.id, role: value.role } : null);
/** A place the Admin lists and removes: a team's Cloud, or another Cloud of the person's own. */
const listedPlace = (entry) => Boolean(entry?.team || entry?.cloud);
/** My Cloud first, then each Cloud and team, then saved servers. */
const placeRank = (entry, homeOrigin) => (entry.origin === homeOrigin ? 0 : listedPlace(entry) ? 1 : 2);

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
  return { local: false, name: active.name, origin: active.origin, ...(cleanColor(active.color) ? { color: active.color } : {}),
    ...(active.team ? { role: teamRoleLabel(active.team.role) } : {}) };
}

/** Native identity must not depend on a hosted renderer's version/title. `homeOrigin`: My Cloud once it is the person's
 * home: alone, it is simply the app; with a team or another place besides, the window names the place it shows. */
function workspaceWindowTitle(state, companion, homeOrigin = null) {
  if (companion) return `OpenMausBot — Connected to: ${companion.serverName} (${new URL(companion.endpoint).host})`;
  const active = activeEnvironment(state);
  if (listedPlace(active)) return `OpenMausBot — ${active.name}`;
  if (active && active.kind !== "local" && active.origin !== homeOrigin) return `OpenMausBot — Hosted: ${active.name} (${new URL(active.origin).host})`;
  if (active && homeOrigin && active.origin === homeOrigin && otherPlaces(state, homeOrigin) > 0) return `OpenMausBot — ${active.name}`;
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
 * joins its name instead of vanishing. */
function workspaceMenuTemplate(state, { onSwitch, onConnect, onForget, onAddCloud, sublabels = {}, iconFor = null, places = null, copyToCloud = null, foldSublabels = false, homeOrigin = null }) {
  const active = activeEnvironment(state);
  if (homeOrigin) return homeMenuTemplate(state, { onSwitch, onForget, sublabels, iconFor, foldSublabels, homeOrigin });
  return [
    ...(places ? [{ id: "workspace-places", label: places, enabled: false }, { type: "separator" }] : []),
    { id: "workspace-local", label: "This computer", type: "radio", checked: !active, ...(iconFor && cleanColor(state.localColor) ? { icon: iconFor(state.localColor) } : {}), click: () => onSwitch(LOCAL_ID) },
    ...[...state.environments].sort((a, b) => listedPlace(b) - listedPlace(a)).map((entry) => {
      const icon = iconFor && cleanColor(entry.color) ? iconFor(entry.color) : null;
      const status = Object.hasOwn(sublabels, entry.id) ? sublabels[entry.id] : entry.team ? teamRoleLabel(entry.team.role) : null;
      return {
        id: `workspace-${entry.id}`, label: foldSublabels && status ? `${entry.name} · ${status}` : entry.name,
        sublabel: status ?? (entry.kind === "local" ? entry.dataDir : new URL(entry.origin).host),
        ...(icon ? { icon } : {}), type: "radio", checked: entry.id === state.activeId, click: () => onSwitch(entry.id),
      };
    }),
    ...(copyToCloud ? [{ id: "workspace-copy-to-cloud", label: copyToCloud.label, click: copyToCloud.click }] : []),
    ...(onAddCloud ? [{ id: "workspace-add-cloud", label: "Add a Cloud…", sublabel: "Keeps your bots running 24/7", click: onAddCloud }] : []),
    { type: "separator" },
    { id: "workspace-connect", label: "Connect to a server…", click: onConnect },
    ...(active && !listedPlace(active) ? [{ id: "workspace-forget", label: `Forget “${active.name}”…`, click: () => onForget(active.id) }] : []),
  ];
}

/** Once My Cloud is the person's home: My Cloud, each Cloud of theirs and each team's Cloud (with this person's role),
 * then the other saved servers, each a whole place of its own; this computer is not one of them, and nothing here sends
 * or copies. A Cloud or a team is the Admin's to list and remove, so it has no Forget. */
function homeMenuTemplate(state, { onSwitch, onForget, sublabels, iconFor, foldSublabels, homeOrigin }) {
  const active = activeEnvironment(state);
  const places = state.environments.filter((entry) => entry.kind !== "local").sort((a, b) => placeRank(a, homeOrigin) - placeRank(b, homeOrigin));
  return [
    ...places.map((entry) => {
      const icon = iconFor && cleanColor(entry.color) ? iconFor(entry.color) : null;
      const status = Object.hasOwn(sublabels, entry.id) ? sublabels[entry.id] : entry.team ? teamRoleLabel(entry.team.role) : null;
      return {
        id: `workspace-${entry.id}`, label: foldSublabels && status ? `${entry.name} · ${status}` : entry.name, sublabel: status ?? new URL(entry.origin).host,
        ...(icon ? { icon } : {}), type: "radio", checked: entry.id === state.activeId, click: () => onSwitch(entry.id),
      };
    }),
    ...(active && active.origin !== homeOrigin && !listedPlace(active) ? [{ type: "separator" }, { id: "workspace-forget", label: `Forget “${active.name}”…`, click: () => onForget(active.id) }] : []),
  ];
}

/** Places besides My Cloud the window can show once My Cloud is home: teams' Clouds and saved self-hosted servers. */
function otherPlaces(state, homeOrigin) {
  return state.environments.filter((entry) => entry.kind !== "local" && entry.origin !== homeOrigin).length;
}

/** A team's Cloud as a saved place: listed once at its address, under the team's name and this person's role (a server
 * saved by hand at that address becomes the team's entry; My Cloud's entry never does). The same state when nothing
 * changes. */
function withTeam(state, team, makeId) {
  const origin = normalizeOrigin(team?.origin), member = cleanTeam(team), name = cleanName(team?.name, "");
  if (!origin || !member || !name) return state;
  const existing = state.environments.find((entry) => entry.origin === origin);
  if (existing?.home || (existing && existing.name === name && existing.team?.id === member.id && existing.team?.role === member.role)) return state;
  const next = { ...(existing ?? { id: makeId(), kind: "remote", origin }), name, team: member };
  return { ...state, environments: existing ? state.environments.map((entry) => (entry === existing ? next : entry)) : [...state.environments, next] };
}

/**
 * The teams the verified session lists, as saved places: one entry per team with a Cloud to open, under the team's name
 * and this person's role; a team the session no longer lists is gone, with its name in `left` so the window can say so
 * once (a team whose Cloud moved is not gone). Only a connected session's word changes anything (a check that failed
 * keeps the list as it was). When the place on screen was a team that is gone, My Cloud is active again (or this
 * computer, without one).
 * @returns {{ state: object, left: string[] }}
 */
function reconcileTeams(state, teams, makeId, homeOrigin = null) {
  if (!Array.isArray(teams)) return { state, left: [] };
  const listed = new Set(), wanted = new Map();
  for (const team of teams) {
    const member = cleanTeam(team), origin = normalizeOrigin(team?.machine?.origin);
    if (!member) continue;
    listed.add(member.id);
    if (origin && !wanted.has(origin)) wanted.set(origin, member.id);
  }
  const left = [];
  const kept = state.environments.filter((entry) => {
    if (!entry.team || wanted.get(entry.origin) === entry.team.id) return true;
    if (!listed.has(entry.team.id)) left.push(entry.name);
    return false;
  });
  let next = kept.length === state.environments.length ? state : { ...state, environments: kept };
  for (const team of teams) next = withTeam(next, { id: team?.id, role: team?.role, name: team?.name, origin: team?.machine?.origin }, makeId);
  if (next === state) return { state, left };
  return { state: withActiveKept(next, homeOrigin), left };
}

/** The place on screen that is gone: My Cloud is active again (or this computer, without one). */
function withActiveKept(state, homeOrigin) {
  const activeId = state.environments.some((entry) => entry.id === state.activeId) ? state.activeId : state.environments.find((entry) => entry.origin === homeOrigin)?.id ?? LOCAL_ID;
  return activeId === state.activeId ? state : { ...state, activeId };
}

/** Another Cloud of the person's own as a saved place: listed once at its address, under the name and colour the Admin
 * keeps for it (`color` undefined keeps the saved one; null is none). A server saved by hand at that address becomes the
 * Cloud's entry; My Cloud's entry and a team's never do. The same state when nothing changes. */
function withOwnCloud(state, cloud, makeId) {
  const origin = normalizeOrigin(cloud?.origin), owner = cleanCloud(cloud), name = cleanName(cloud?.name, "");
  if (!origin || !owner || !name) return state;
  const existing = state.environments.find((entry) => entry.origin === origin);
  if (existing?.home || existing?.team) return state;
  const color = cloud.color === undefined ? cleanColor(existing?.color) : cleanColor(cloud.color);
  if (existing && existing.name === name && existing.cloud?.id === owner.id && existing.cloud?.role === owner.role && (cleanColor(existing.color) ?? null) === (color ?? null)) return state;
  const { color: _old, ...rest } = existing ?? { id: makeId(), kind: "remote", origin };
  const next = { ...rest, name, ...(color ? { color } : {}), cloud: owner };
  return { ...state, environments: existing ? state.environments.map((entry) => (entry === existing ? next : entry)) : [...state.environments, next] };
}

/** The person's other own Clouds the verified session lists (cloud-list.mjs ownCloudPlaces), as saved places: one the
 * session no longer lists is gone. Null (an Admin without the list, or no verified word) changes nothing. */
function reconcileOwnClouds(state, clouds, makeId, homeOrigin = null) {
  if (!Array.isArray(clouds)) return state;
  const wanted = new Map();
  for (const cloud of clouds) {
    const owner = cleanCloud(cloud), origin = normalizeOrigin(cloud?.origin);
    if (owner && origin && !wanted.has(origin)) wanted.set(origin, cloud);
  }
  const kept = state.environments.filter((entry) => !entry.cloud || wanted.get(entry.origin)?.id === entry.cloud.id);
  let next = kept.length === state.environments.length ? state : { ...state, environments: kept };
  for (const cloud of wanted.values()) next = withOwnCloud(next, cloud, makeId);
  return next === state ? state : withActiveKept(next, homeOrigin);
}

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
 * answer at once the line is left out, never guessed. `home`: the bots moved and home is My Cloud, which the line says
 * only then, whichever place the window shows. `send`: what waits (main's last comparison) and its actions. */
async function placesMenuOptions({ cloud, home = false, homeOrigin = null, platform, port, send = null,
  localBots = () => fetch(`http://127.0.0.1:${port}/api/bots`, { signal: AbortSignal.timeout(700) }).then((response) => response.json()) }) {
  const foldSublabels = platform !== "darwin";
  if (homeOrigin) return { foldSublabels, homeOrigin };
  if (!cloud) return { foldSublabels };
  let names = null;
  try { const listed = await localBots(); names = Array.isArray(listed?.bots) ? listed.bots.map((bot) => bot?.name) : null; } catch {}
  const waiting = sendLine({ cloudName: cloud.name, waiting: send?.waiting });
  return {
    foldSublabels,
    ...(send ? { copyToCloud: waiting ? { label: waiting, click: send.onSend } : { label: `This computer and ${cloud.name}…`, click: send.onOpen } } : {}),
    ...(names ? { places: placesLine({ cloudName: cloud.name, onCloud: home === true, localBots: names }) } : {}),
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
      const color = cleanColor(entry?.color);
      environments.push({ id, kind: "local", name: cleanName(entry.name, dirBasename(dataDir)), dataDir, ...(color ? { color } : {}) });
      continue;
    }
    const origin = normalizeOrigin(entry?.origin);
    if (!origin || (entry?.kind !== undefined && entry.kind !== "remote") || seen.has(origin)) continue;
    seen.add(id);
    seen.add(origin);
    const color = cleanColor(entry?.color), team = entry?.home === true ? null : cleanTeam(entry?.team);
    const cloud = entry?.home === true || team ? null : cleanCloud(entry?.cloud);
    environments.push({ id, kind: "remote", name: cleanName(entry?.name, nameFromOrigin(origin)), origin, ...(entry?.microphone === true ? { microphone: true } : {}),
      ...(color ? { color } : {}), ...(entry?.home === true ? { home: true } : {}), ...(team ? { team } : {}), ...(cloud ? { cloud } : {}) });
  }
  const activeId = typeof value?.activeId === "string" && environments.some((e) => e.id === value.activeId) ? value.activeId : LOCAL_ID;
  const localColor = cleanColor(value?.localColor);
  return { environments, activeId, ...(localColor ? { localColor } : {}) };
}

/** `localColor`: This computer's own colour, which has no entry in the list; absent for none. */
function serializeEnvironments(state) {
  const localColor = cleanColor(state.localColor);
  return JSON.stringify({ version: 2, environments: state.environments, activeId: state.activeId, ...(localColor ? { localColor } : {}) }, null, 2) + "\n";
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

/** One place's colour as the person chose it, or none (`color` null): a saved place's, or This computer's (LOCAL_ID).
 * A colour this app doesn't draw changes nothing. The same state when it is that colour already. */
function withPlaceColor(state, id, color) {
  const existing = savedPlace(state, id);
  if (!existing || (color !== null && !cleanColor(color)) || (cleanColor(existing.color) ?? null) === color) return state;
  if (id === LOCAL_ID) {
    const { localColor: _old, ...rest } = state;
    return color ? { ...rest, localColor: color } : rest;
  }
  const { color: _old, ...rest } = existing;
  const next = color ? { ...rest, color } : rest;
  return { ...state, environments: state.environments.map((entry) => (entry === existing ? next : entry)) };
}

/** The place `id` names (the one on screen by default): a saved entry, or This computer as one, named and coloured. */
function savedPlace(state, id = state.activeId) {
  if (id === LOCAL_ID) return { id: LOCAL_ID, kind: "local", name: "This computer", ...(cleanColor(state.localColor) ? { color: state.localColor } : {}) };
  return state.environments.find((entry) => entry.id === id) ?? null;
}

/** The colours the Admin keeps for My Cloud (`home`) and team Clouds (`teamId`), on their saved places: once a colour
 * was chosen there it is the one everywhere (none for slate); before that, what this app saved stays. */
function withListedColors(state, looks, homeOrigin = null) {
  let next = state;
  for (const look of Array.isArray(looks) ? looks : []) {
    const entry = next.environments.find((candidate) => (look?.home === true
      ? candidate.kind !== "local" && (candidate.home === true || (homeOrigin !== null && candidate.origin === homeOrigin))
      : typeof look?.teamId === "string" && candidate.team?.id === look.teamId));
    if (entry) next = withPlaceColor(next, entry.id, cleanColor(look.color));
  }
  return next;
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
  return { ...state, environments, activeId: state.activeId === id ? LOCAL_ID : state.activeId };
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
  TEAM_ROLES,
  teamRoleLabel,
  listedPlace,
  reconcileTeams,
  reconcileOwnClouds,
  withTeam,
  withOwnCloud,
  LOCAL_ID,
  activeEnvironment,
  activeLocalDataDir,
  activeRemote,
  allowedOrigins,
  bootEnvironmentDir,
  normalizeOrigin,
  otherPlaces,
  parseEnvironments,
  parsePairingLink,
  parseHostedWorkspaceLink,
  savedPlace,
  serializeEnvironments,
  startupEnvironmentDir,
  withActive,
  withEnvironment,
  withEnvironmentLook,
  withListedColors,
  withPlaceColor,
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
