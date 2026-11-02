// The rail of places at the left of the window (the renderer's PlacesRail, drawn by the window's own chrome rail page,
// chrome-rail.mjs) and its ＋: main builds the list, says who may read it, and does what a circle or ＋ asks through
// main's own switch and dialogs.
//
// Security: the list carries names, colours and states, never an address, and goes only to the rail's own page, this
// app's. No place's page reads it, not even this computer's or a Cloud's: a server the person connected by hand runs a
// page anyone may have written, and would learn the names of the person's other places. A page learns only that the
// rail stands beside it. A circle names a saved place by its id; main opens or removes only an id it listed itself, and
// the Cloud it acts on is main's own word for that circle (`cloudId`, which the page never sees).
import environments from "./environments.cjs";
import { CHECKOUT_SOURCES } from "./cloud-account.mjs";
import { cleanCloudListName, CLOUD_SWATCHES, cloudSetupProgress, cloudState, olderRelease, otherOwnClouds, ownCloud, signedInServers, stepProgress, swatchColor } from "./cloud-list.mjs";
import { machineSetup } from "./cloud-home.mjs";
import { listedLook, placeLook, railPaint, SIGNED_IN } from "./place-look.mjs";

export const RAIL_MIN_PLACES = 2;
const PENDING = "pending:";

/** A server or computer of the person's own that signed in with their account, as its circle says it: online while the
 * Admin heard from it in the last few minutes, else offline since when it was last seen; and an older release than the
 * newest one, while the Admin names that (`latest`; none while it doesn't follow releases). */
const serverState = (listed, latest = null) => ({ server: true, ...(listed.status !== "ready" ? { offline: true } : {}), ...(listed.lastSeenAt ? { lastSeenAt: listed.lastSeenAt } : {}),
  ...(listed.version && latest && olderRelease(listed.version, latest) ? { update: { version: listed.version, latest } } : {}) });

const machineProgress = machine => {
  const setup = machineSetup(machine);
  return setup ? stepProgress(setup.step) : null;
};

/** One saved place as a circle: what it is, its colour (and who may change it from the rail) and how it is doing, from
 * the session's word for it. */
function circle(entry, { activeId, mine, state, offers }) {
  const connected = state?.status === "connected" ? state : null;
  const listed = connected?.clouds?.find(cloud => cloud.origin === entry.origin) ?? null;
  const kind = entry.origin === mine || entry.home || entry.cloud ? "cloud" : entry.team ? "team" : "server";
  const team = entry.team ? connected?.teams?.find(candidate => candidate?.id === entry.team.id) ?? null : null;
  const machine = entry.origin === mine ? connected?.machine ?? null : team?.machine ?? null;
  const progress = listed ? cloudSetupProgress(listed) : machineProgress(machine);
  const problem = listed ? listed.status === "payment_problem" && listed.role === "owner" : entry.origin === mine && machine?.status === "payment-problem";
  const color = environments.ENTRY_COLORS.includes(entry.color) ? entry.color : listed ? swatchColor(listed.color) : null;
  const paint = railPaint(placeLook(entry, { clouds: connected?.clouds ?? null, homeOrigin: mine }), color);
  return { id: entry.id, name: entry.name, color, kind, opens: true, ...(paint ? { paint } : {}), ...(entry.id === activeId ? { active: true } : {}),
    ...(progress !== null ? { progress } : {}), ...(problem ? { attention: true } : {}), ...(listed?.managed === false ? serverState(listed, connected?.latestVersion ?? null) : {}),
    ...(kind === "cloud" && cloudState(listed) === "ended" ? { ended: true } : {}), ...(listed?.removable && kind === "cloud" ? { removable: true, cloudId: listed.id } : {}), ...(kind === "server" ? { removable: true, forget: true } : {}),
    ...(kind === "server" && offers(entry) ? { makeHome: true } : {}) };
}

/** My Cloud's saved place that the verified session's list no longer has (its owner removed it from their list, or the Admin
 * lists nothing at its address any more): no circle, unless it is home. An Admin without the list leaves it as it was. */
const unlisted = (entry, { clouds, home, mine }) => Array.isArray(clouds) && (entry.home === true || entry.origin === mine) && entry.origin !== home
  && !clouds.some(cloud => cloud.origin === entry.origin);

/**
 * The circles, in the Server menu's order: This computer while it is a place (before the move made My Cloud home, `home`
 * null), My Cloud, the person's other Clouds and their teams' Clouds in the session's order, then servers saved by hand.
 * A server of theirs that signed in with their account comes next: one saved here already is that saved place (online
 * or not), one not connected to this app yet shows how to connect it, and one only reachable on its own network has
 * nothing to open. A Cloud of theirs the Admin is still making (no address yet) is there too: it opens its own screen (its
 * checkout or its setup), never an address. My Cloud's saved place leaves once the session's list doesn't have it (removed
 * from the list). Fewer than RAIL_MIN_PLACES places in all, This computer counted while it is one: no rail at all, the window
 * as it was, unless the person has a Cloud of their own: then its one circle is the rail, for the ＋ that buys another.
 * `offers(entry)`: a server connected by hand whose menu offers Make … my home (own-home-main.mjs).
 * @param {{ saved: { environments: any[], activeId: string }, home?: string | null, mine?: string | null, state?: any, offers?: (entry: any) => boolean }} input
 */
export function railPlaces({ saved, home = null, mine = null, state = null, offers = () => false }) {
  const connected = state?.status === "connected" ? state : null;
  const clouds = Array.isArray(connected?.clouds) ? connected.clouds : [];
  const order = entry => { const at = clouds.findIndex(cloud => cloud.origin === entry.origin); return at === -1 ? clouds.length : at; };
  const rank = entry => (entry.origin === mine || entry.home ? 0 : environments.listedPlace(entry) ? 1 : 2);
  const remote = saved.environments.filter(entry => entry.kind !== "local" && entry.origin && !(connected && unlisted(entry, { clouds: connected.clouds, home, mine })))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || order(a.entry) - order(b.entry) || a.index - b.index)
    .map(({ entry }) => circle(entry, { activeId: saved.activeId, mine, state: connected, offers }));
  const making = otherOwnClouds(clouds).filter(cloud => !cloud.origin && ["checkout", "setting_up"].includes(cloud.status))
    .map(cloud => ({ id: `${PENDING}${cloud.id}`, name: cloud.name, color: swatchColor(cloud.color), kind: "cloud", opens: true, progress: cloudSetupProgress(cloud) ?? 0,
      ...(cloud.status === "checkout" ? { waiting: true } : {}), cloudId: cloud.id }));
  const savedOrigins = new Set(saved.environments.map(entry => entry.origin).filter(Boolean));
  const servers = signedInServers(clouds).filter(cloud => !cloud.origin || !savedOrigins.has(cloud.origin))
    .map(cloud => ({ id: `${SIGNED_IN}${cloud.id}`, name: cloud.name, color: swatchColor(cloud.color), kind: "server", opens: false, paint: railPaint(listedLook(cloud), swatchColor(cloud.color)),
      ...(cloud.origin ? { pairs: true } : { ownNetwork: true }), ...serverState(cloud, connected?.latestVersion ?? null) }));
  const places = [...remote, ...servers, ...making];
  const computer = environments.savedPlace(saved, environments.LOCAL_ID), color = computer.color ?? null;
  const all = home ? places : [{ id: computer.id, name: computer.name, color, kind: "computer", opens: true, paint: railPaint(placeLook(computer), color),
    ...(saved.activeId === environments.LOCAL_ID ? { active: true } : {}) }, ...places];
  return all.length < (clouds.some(ownCloud) ? 1 : RAIL_MIN_PLACES) ? [] : all;
}

/** What buying another Cloud looks like from a page: no account, address or checkout page, only what the sheet says. */
export function addCloudView(state, offer) {
  const connected = state?.status === "connected" ? state : null;
  if (!connected) return { signedIn: false };
  const clouds = Array.isArray(connected.clouds) ? connected.clouds : null;
  const owned = clouds ? clouds.filter(ownCloud) : [];
  const has = Boolean(connected.machine) || owned.length > 0;
  const home = clouds?.find(cloud => cloud.primary) ?? null;
  const adding = connected.adding ?? null, listed = adding ? clouds?.find(cloud => cloud.id === adding.cloudId) ?? null : null;
  const status = !listed || listed.status === "checkout" ? "checkout" : ["ready", "offline"].includes(listed.status) && listed.origin ? "ready"
    : listed.status === "setting_up" || listed.status === "ready" ? "setting_up" : "problem";
  return {
    signedIn: true, hasCloud: has, supported: Boolean(clouds),
    canAdd: Boolean(clouds) && connected.addCloud?.canAdd !== false,
    ...(connected.addCloud?.canAdd === false ? { blocked: connected.addCloud.blocked } : {}),
    offer: offer ?? null, count: Math.max(owned.length, has ? 1 : 0),
    ...(connected.organizations ? { organizations: { canAdd: connected.organizations.canAdd, count: connected.organizations.count, max: connected.organizations.max,
      ...(connected.organizations.blocked ? { blocked: connected.organizations.blocked } : {}) } } : {}),
    ...(home ? { home: { name: home.name, color: swatchColor(home.color) } } : {}),
    ...(adding ? { adding: { name: adding.name, color: adding.color, tier: adding.tier, startedAt: adding.startedAt, status,
      ...(listed && cloudSetupProgress(listed) !== null ? { progress: cloudSetupProgress(listed) } : {}), ...(adding.link ? { link: true } : {}), ...(adding.done ? { done: true } : {}) } } : {}),
  };
}

/**
 * "“{name}” is ready", once per Cloud this app bought, unless its sheet shows it in the focused window; a click opens it.
 */
export function createAddedCloudNotice({ Notification, focused, sheetOpen, open, shown = () => {} }) {
  const announced = new Set();
  return state => {
    const adding = state?.status === "connected" ? state.adding : null;
    const listed = adding && !adding.done ? state.clouds?.find(cloud => cloud.id === adding.cloudId) ?? null : null;
    if (!listed || !["ready", "offline"].includes(listed.status) || !listed.origin || announced.has(adding.cloudId)) return false;
    announced.add(adding.cloudId);
    if ((focused() && sheetOpen()) || !Notification.isSupported()) return false;
    const note = new Notification({ title: `“${listed.name}” is ready`, body: "Click to open it." });
    note.on("click", () => open(adding.cloudId));
    note.show();
    shown();
    return true;
  };
}

const plain = value => (typeof value === "string" ? value : "");
/** A circle as the rail's page sees it: never the Cloud's id, which only main acts on. */
const seen = ({ cloudId: _cloudId, ...place }) => place;
const CHOICES = Object.freeze(["cloud", "link", "address"]);

/**
 * The rail's and ＋'s channels, each behind main's guard (`guard`: the window's page, or the rail's own). Only the rail's
 * page (`lists`) reads the list and opens or adds a place; ＋'s buying sheet also runs on a page `trusted` vouches for
 * (the rail's, or this computer's own). Any other page learns only whether the rail stands beside it (`beside`).
 * `places()` is railPlaces' list now; `open(id)` main's own switch; `add` the ＋ sheet's fixed actions; `account()` the
 * MausBot Cloud sign-in; `targets()` the pages told when something changed; `makeHome(id)` starts the move to a server
 * of the person's own (own-home-main.mjs `start`).
 */
export function installCloudRail({ ipcMain, guard, trusted, lists = trusted, beside = () => false, places, open, add, account, clipboard, openCloud, targets, makeHome = null, forget = null }) {
  let sheetOpen = false, sent = "";
  const allowed = (channel, handler) => guard((event, ...args) => {
    if (!trusted(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(event, ...args);
  });
  const handle = (channel, handler) => ipcMain.handle(channel, allowed(channel, handler));
  const listed = (channel, handler) => ipcMain.handle(channel, guard((event, ...args) => {
    if (!lists(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(event, ...args);
  }));
  const view = async () => addCloudView(account()?.state() ?? null, account() ? await account().offer().catch(() => null) : null);
  // ＋'s choices: main's, and a new organization while this account runs a Team plan's organizations (unless the Admin has
  // turned adding them off).
  const choices = () => { const organizations = account()?.state().organizations; return { ...add.choices(), organization: Boolean(organizations) && organizations.blocked !== "off" }; };
  ipcMain.handle("workspaces:places", guard((event) => (lists(event) ? { places: places().map(seen), add: choices() }
    : { places: [], add: { cloud: false, link: false, address: false, organization: false }, ...(beside() ? { beside: true } : {}) })));
  // A Cloud the Admin is still making has no saved place: its own screen opens, by main's word for which Cloud it is.
  listed("workspaces:open", (_event, id) => {
    const place = places().find(entry => entry.id === plain(id) && entry.opens);
    if (!place) throw new Error("That place isn't here any more.");
    return place.id.startsWith(PENDING) ? openCloud(place.cloudId) : open(place.id);
  });
  // Remove from list, from a circle's menu (the page asked the person first): only a Cloud or a server saved by hand that
  // main listed as removable. A server is forgotten here; a Cloud is taken off the person's list at the Admin.
  listed("workspaces:remove", async (_event, id) => {
    const place = places().find(entry => entry.id === plain(id) && entry.removable && (entry.cloudId || entry.forget));
    if (!place) throw new Error("That place isn't here any more.");
    if (place.forget) return { outcome: forget ? ((await forget(place.id)) === false ? "failed" : "removed") : "unsupported" };
    const client = account();
    return { outcome: client?.hideCloud ? (await client.hideCloud(place.cloudId)).outcome : "unsupported" };
  });
  // Make … my home, from a circle's menu: only a server main listed with it, by main's own word for it.
  listed("workspaces:make-home", (_event, id) => {
    const place = places().find(entry => entry.id === plain(id) && entry.makeHome);
    if (!place || !makeHome) throw new Error("That server can't be your bots' home now.");
    return makeHome(place.id);
  });
  // A link pasted on ＋'s sheet goes to main's own Connect dialog, which checks it and names its host before connecting.
  listed("workspaces:add", (_event, choice, link) => {
    if (!CHOICES.includes(choice) || !add.choices()[choice]) throw new Error("That isn't something to add here.");
    const pasted = choice === "link" ? plain(link).trim().slice(0, 4096) : "";
    return pasted ? add.run(choice, pasted) : add.run(choice);
  });
  handle("cloud-add:state", () => view());
  handle("cloud-add:start", async (_event, tier, name, color, source) => {
    const client = account();
    if (!client) throw new Error("Sign in to MausBot Cloud first.");
    const plans = (await client.offer().catch(() => null))?.plans ?? [];
    const cleanName = cleanCloudListName(plain(name)), swatch = CLOUD_SWATCHES.includes(color) ? color : null;
    if (!plans.some(plan => plan.tier === plain(tier)) || !cleanName) throw new Error("Choose a plan and a name to continue.");
    const result = await client.addCloud({ tier: plain(tier), interval: "month", name: cleanName, color: swatch, ...(CHECKOUT_SOURCES.includes(source) ? { source } : {}) });
    return result.outcome === "blocked" ? { outcome: "blocked", blocked: result.blocked } : { outcome: result.outcome };
  });
  handle("cloud-add:organization", async (_event, name, color) => {
    const client = account();
    if (!client) throw new Error("Sign in to MausBot Cloud first.");
    const cleanName = cleanCloudListName(plain(name)), swatch = CLOUD_SWATCHES.includes(color) ? color : null;
    if (!cleanName) throw new Error("Give the organization a name to continue.");
    const result = await client.addOrganization({ name: cleanName, color: swatch });
    return result.outcome === "blocked" ? { outcome: "blocked", blocked: result.blocked } : { outcome: result.outcome };
  });
  handle("cloud-add:reopen", () => account()?.reopenAdd() ?? false);
  handle("cloud-add:copy-link", () => {
    const url = account()?.addLink() ?? null;
    if (url) clipboard.writeText(url);
    return Boolean(url);
  });
  handle("cloud-add:open", async () => {
    const adding = account()?.state().adding;
    if (!adding?.cloudId) throw new Error("There is no new Cloud to open.");
    await openCloud(adding.cloudId);
    account()?.addDone();
  });
  handle("cloud-add:interest", () => account()?.interest("another_cloud"));
  handle("cloud-add:sheet", (event, on) => {
    sheetOpen = on === true;
    const page = event?.sender;
    if (sheetOpen && typeof page?.once === "function") for (const done of ["did-navigate", "destroyed"]) page.once(done, () => { sheetOpen = false; });
  });
  return {
    sheetOpen: () => sheetOpen,
    /** The places, the sign-in or the rail beside the page changed: the rail's page and the page beside it read them
     * again (a signal only, never the list). */
    changed() {
      const key = JSON.stringify([places(), choices(), account()?.state().adding ?? null, account()?.state().addCloud ?? null, beside()]);
      if (key === sent) return;
      sent = key;
      for (const target of targets()) if (target && !target.isDestroyed()) target.send("workspaces:changed");
    },
  };
}
