// The colour of the place a page shows: drawn faintly at the top of its sidebar and on its circle in the rail, and
// changed from its own Settings. A Cloud's colour (My Cloud, another of the person's own, a team's) is the Admin's, so
// every app of theirs follows it: its owner or its team's Super admin and Admins change it there; everyone else sees it.
// This computer, a server the person connected by hand, and a Cloud an older Admin keeps no colour for keep the colour
// this app saved for them. A page learns and changes only the colour of the place it is. The window's own rail changes
// the colour of any place it lists (a right-click on its circle), whatever that place's server runs: the same rules,
// from this app's own page.
import environments from "./environments.cjs";
import { CLOUD_SWATCH_COLORS, CLOUD_SWATCHES, swatchColor } from "./cloud-list.mjs";

/** The rail's id for a server of the person's own that signed in with their account and is not saved here. */
export const SIGNED_IN = "signed-in:";

/** The swatch a saved colour is offered as (CLOUD_SWATCH_COLORS the other way); null for none, or a colour no swatch has. */
export function swatchOf(color) {
  if (!environments.ENTRY_COLORS.includes(color)) return null;
  return CLOUD_SWATCHES.find(swatch => CLOUD_SWATCH_COLORS[swatch] === color) ?? null;
}

/** The session's own word for a saved place: another Cloud of the person's by its id, a team's Cloud by its team, My
 * Cloud as the account's primary one. Null for a server connected by hand, or without the session's list. */
export function listedCloudOf(entry, { clouds = null, homeOrigin = null } = {}) {
  if (!Array.isArray(clouds) || !entry) return null;
  if (entry.cloud) return clouds.find(cloud => cloud.id === entry.cloud.id && cloud.managed !== false) ?? null;
  if (entry.team) return clouds.find(cloud => cloud.teamId === entry.team.id && cloud.managed !== false) ?? null;
  if (entry.home === true || (homeOrigin !== null && entry.origin === homeOrigin)) return clouds.find(cloud => cloud.primary) ?? null;
  return null;
}

/**
 * A place's colour, and where a change of it goes: `admin` (the Admin keeps it, and this person owns that Cloud or is
 * its team's Super admin or Admin), `local` (this app keeps it: This computer, a server connected by hand, or a Cloud an
 * older Admin lists no colours for), or none, with why: a team member's, or another Cloud of theirs while the sign-in
 * is away. Null for no place. `cloudId` stays in main.
 */
export function placeLook(entry, { clouds = null, homeOrigin = null } = {}) {
  if (!entry) return null;
  const color = environments.ENTRY_COLORS.includes(entry.color) ? entry.color : null;
  const base = { name: entry.name, color, swatch: swatchOf(color) };
  if (entry.kind === "local") return { ...base, change: "local" };
  if (typeof entry.origin !== "string" || !entry.origin) return null;
  const mine = entry.home === true || (homeOrigin !== null && entry.origin === homeOrigin);
  if (!mine && !entry.team && !entry.cloud) return { ...base, change: "local" };
  const listed = listedCloudOf(entry, { clouds, homeOrigin });
  const role = listed?.role ?? entry.team?.role ?? entry.cloud?.role ?? "owner";
  if (role === "member") return { ...base, change: null, reason: "member" };
  if (listed) return { ...base, change: "admin", cloudId: listed.id };
  // Another Cloud of the person's own is listed whenever the sign-in is: a colour saved here alone would be undone.
  if (entry.cloud) return { ...base, change: null, reason: "signed-out" };
  return { ...base, change: "local" };
}

/** A server of the person's own that signed in with their account, not saved here: its colour is the Admin's. */
export function listedLook(cloud) {
  if (!cloud) return null;
  const swatch = CLOUD_SWATCHES.includes(cloud.color) ? cloud.color : null;
  const base = { name: cloud.name, color: swatchColor(swatch), swatch };
  return cloud.role === "member" ? { ...base, change: null, reason: "member" } : { ...base, change: "admin", cloudId: cloud.id };
}

/** What the rail's circle says of a look: the swatch of the colour it shows, and why only others change it, if so. */
export const railPaint = (look, color) => (look ? { swatch: swatchOf(color), ...(look.change ? {} : { locked: look.reason ?? "member" }) } : null);

/** What the page sees of it: never the Cloud's id. */
export function pageLook(look) {
  if (!look) return null;
  const { cloudId: _id, ...seen } = look;
  return seen;
}

/**
 * The page's own place's colour (`workspaces:look`) and its change (`workspaces:color`, a swatch or null for none),
 * each behind main's window guard. `place()`: the place on screen (This computer included), which the guard made sure
 * the asking page is; `session()`: the verified session's Clouds and My Cloud's address; `setColor(cloudId, swatch)`:
 * the Admin's change (cloud-account.mjs setCloudColor); `save(id, color)`: this app's own record of that place, at
 * once, so its circle and the top of its sidebar follow before the session is read again. `rail`: the window's own
 * rail, which changes the colour of any place it lists with a colour to show (`workspaces:recolor`, its circle's id and
 * a swatch): `owns(event)` its page asks, `places()` railPlaces' list now, `saved(id)` that place (This computer's too).
 */
export function installPlaceLook({ ipcMain, guard, place, session, setColor, save, rail = null }) {
  const look = () => placeLook(place(), session());
  /** `entry`'s place (none: a server of theirs only the Admin lists) takes `swatch`; `now()` is its look at each step. */
  const recolor = async (entry, now, swatch) => {
    if (!(swatch === null || CLOUD_SWATCHES.includes(swatch))) throw new Error("Choose one of the colors.");
    const current = now();
    if (!current) throw new Error("This place has no color to change.");
    if (!current.change) return { outcome: "refused", look: pageLook(current) };
    if (current.change === "admin") {
      const result = await setColor(current.cloudId, swatch);
      if (result?.outcome !== "saved") return { outcome: result?.outcome === "refused" || result?.outcome === "unsupported" ? result.outcome : "failed", look: pageLook(now()) };
    }
    if (entry) save(entry.id, swatchColor(swatch));
    return { outcome: "saved", look: pageLook(now()) };
  };
  ipcMain.handle("workspaces:look", guard(() => pageLook(look())));
  ipcMain.handle("workspaces:color", guard((_event, swatch) => recolor(place(), look, swatch)));
  if (rail) ipcMain.handle("workspaces:recolor", (event, id, swatch) => {
    if (!rail.owns(event)) throw new Error("workspaces:recolor is only available to the window's rail");
    if (!rail.places().some(listed => listed.id === id && listed.paint)) return Promise.reject(new Error("That place isn't here any more."));
    const entry = rail.saved(id);
    const now = () => (entry ? placeLook(rail.saved(id) ?? entry, session())
      : listedLook(session().clouds?.find(cloud => `${SIGNED_IN}${cloud.id}` === id && cloud.managed === false) ?? null));
    return recolor(entry, now, swatch);
  });
  return { look };
}
