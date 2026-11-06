// The verified session's `clouds` (contract v1, additive): every Cloud this person owns and every team's Cloud they are
// in, the account's primary Cloud first. Only the Admin lists a Cloud; a page never names one.
import { CLOUD_SETUP_STEPS, homeOrigin, parseCloudPower } from "./cloud-home.mjs";
import environments from "./environments.cjs";

export const MAX_CLOUDS = 20;
export const CLOUD_LIST_STATUSES = Object.freeze(["checkout", "setting_up", "ready", "stopped", "payment_problem", "ended", "offline"]);
/** The Admin's colour swatches, and the saved colour (environments.cjs ENTRY_COLORS) each is shown in here; slate is
 * the plain one. */
export const CLOUD_SWATCH_COLORS = Object.freeze({ blue: "blue", green: "teal", amber: "yellow", rose: "red", violet: "purple", slate: null });
export const CLOUD_SWATCHES = Object.freeze(Object.keys(CLOUD_SWATCH_COLORS));
export const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const CLOUD_NAME_LIMIT = 40;
const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
const RUNS_ON = Object.freeze(["cloud", "server"]);
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
/** Each status as the app's machine summary (cloud-home.mjs CLOUD_MACHINE_STATUSES) reads it; a Cloud still at checkout
 * has none yet, and one offline is opened, so its own screen says it does not answer. */
const MACHINE_STATUS = Object.freeze({ setting_up: "provisioning", ready: "ready", stopped: "stopped", payment_problem: "payment-problem", ended: "stopped", offline: "ready" });
/** The statuses of a Cloud that isn't running: its files' day and Remove from list are said only for these. */
const DEAD = Object.freeze(["ended", "stopped", "payment_problem"]);
/** How far along each setup step is, for an Admin that names the step only. */
const STEP_PROGRESS = Object.freeze({ reserving: 0.15, storage: 0.4, starting: 0.65, checking: 0.9 });

const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A Cloud's name as the Admin keeps it: 1 to 40 characters, spaces folded, nothing a page could take for markup. */
export function cleanCloudListName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name && [...name].length <= CLOUD_NAME_LIMIT && !/[\p{Cc}<>]/u.test(name) ? name : null;
}

function setupOf(input) {
  if (!record(input)) return null;
  const step = CLOUD_SETUP_STEPS.includes(input.step) ? input.step : null;
  const progress = typeof input.progress === "number" && Number.isFinite(input.progress) ? Math.max(0, Math.min(1, input.progress)) : null;
  return step || progress !== null ? { ...(step ? { step } : {}), ...(progress !== null ? { progress } : {}) } : null;
}

/** One Cloud, or null when anything the app acts on is malformed (never trusted in part); a malformed colour, tier,
 * setup, last-seen time or version is simply left out, and a field this app doesn't know is ignored. `managed: false`
 * (absent means MausBot runs or manages it) is a server or computer of the person's own that signed in with their
 * account: always on a server of theirs, and with no address while it is only reachable on its own network. */
function parseCloudEntry(input) {
  if (!record(input) || typeof input.id !== "string" || !CLOUD_ID.test(input.id)) return null;
  const name = cleanCloudListName(input.name);
  if (!name || !environments.TEAM_ROLES.includes(input.role) || !CLOUD_LIST_STATUSES.includes(input.status) || !RUNS_ON.includes(input.runsOn) || typeof input.primary !== "boolean") return null;
  if (input.managed !== undefined && typeof input.managed !== "boolean") return null;
  const managed = input.managed !== false;
  if (!managed && input.runsOn !== "server") return null;
  const origin = input.origin === null || input.origin === undefined ? null : homeOrigin(input.origin);
  if ((input.origin !== null && input.origin !== undefined && !origin) || (managed && ["ready", "offline"].includes(input.status) && !origin)) return null;
  const teamId = input.teamId === null || input.teamId === undefined ? null : typeof input.teamId === "string" && TEAM_ID.test(input.teamId) ? input.teamId : undefined;
  if (teamId === undefined) return null;
  const setup = input.status === "setting_up" ? setupOf(input.setup) : null;
  const lastSeenAt = typeof input.lastSeenAt === "number" && Number.isSafeInteger(input.lastSeenAt) && input.lastSeenAt > 0 ? input.lastSeenAt : null;
  const version = typeof input.version === "string" && VERSION.test(input.version) ? input.version : null;
  // Additive (Oct 30): as `cloud.power`, for a Ready Cloud whose plan sleeps; this app never reaches one the Admin says is asleep.
  const power = input.status === "ready" ? parseCloudPower(input.power) : null;
  // Additive (Oct 30): when a Cloud that isn't running has its kept files deleted, and whether its owner may take it off their
  // list (an Admin with Remove from list says so only for one of their own, in no team, that ended or was never paid for).
  const deleteAfter = DEAD.includes(input.status) && Number.isSafeInteger(input.deleteAfter) && input.deleteAfter > 0 ? input.deleteAfter : null;
  const removable = input.removable === true && DEAD.includes(input.status) && managed && input.role === "owner" && teamId === null;
  return { id: input.id, name, color: Object.hasOwn(CLOUD_SWATCH_COLORS, input.color) ? input.color : null, role: input.role,
    tier: typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : null, runsOn: input.runsOn, status: input.status, origin, teamId,
    primary: input.primary, managed, ...(setup ? { setup } : {}), ...(lastSeenAt ? { lastSeenAt } : {}), ...(version ? { version } : {}), ...(power ? { power } : {}),
    ...(deleteAfter ? { deleteAfter } : {}), ...(removable ? { removable: true } : {}) };
}

/** What this app says of a listed Cloud it doesn't open, on this computer's own screen (never by its address): it has ended
 * (stopped too), its checkout wasn't finished, its payment has a problem, or it is being set up. Null for one that opens:
 * ready, or offline (its own screen then says it doesn't answer). */
export function cloudState(cloud) {
  const status = cloud?.status;
  return status === "ended" || status === "stopped" ? "ended" : status === "checkout" ? "checkout" : status === "payment_problem" ? "payment"
    : status === "setting_up" ? "setup" : null;
}

/** An OpenMausBot release as the Admin names it ("0.1.130"), or null: anything else is no version at all. */
export const releaseVersion = value => (typeof value === "string" && VERSION.test(value) ? value : null);

/** Whether `version` is an older release than `latest`, compared number by number; false when either isn't plain
 * numbers (a build of its own), so no reminder is ever guessed. */
export function olderRelease(version, latest) {
  const parts = text => (typeof text === "string" && /^\d+(?:\.\d+){1,3}$/.test(text) ? text.split(".").map(Number) : null);
  const a = parts(version), b = parts(latest);
  if (!a || !b) return false;
  for (let at = 0; at < Math.max(a.length, b.length); at++) if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) < (b[at] ?? 0);
  return false;
}

/** A Cloud this person owns that is no team's: a world of their own. Never a server that only signed in with their
 * account (`managed: false`): MausBot neither runs nor vouches for it, so it is no Cloud of theirs to pair or lend to. */
export const ownCloud = cloud => Boolean(cloud) && cloud.teamId === null && cloud.role === "owner" && cloud.managed !== false;

/** The person's own servers and computers that signed in with their account: in the rail, each one theirs to connect. */
export const signedInServers = clouds => (Array.isArray(clouds) ? clouds.filter(cloud => cloud.managed === false) : []);

/**
 * The session's list, at most MAX_CLOUDS, each Cloud once; null when the Admin sends none (it predates many Clouds, and
 * the session's `cloud` and `teams` say everything). At most one Cloud is primary, and only one of the person's own.
 */
export function parseCloudList(input) {
  if (!Array.isArray(input)) return null;
  const clouds = [], seen = new Set();
  let primary = false;
  for (const entry of input.slice(0, MAX_CLOUDS)) {
    const cloud = parseCloudEntry(entry);
    if (!cloud || seen.has(cloud.id)) continue;
    seen.add(cloud.id);
    const first = cloud.primary && !primary && ownCloud(cloud);
    if (first) primary = true;
    clouds.push(first === cloud.primary ? cloud : { ...cloud, primary: false });
  }
  return clouds;
}

/** Why the Admin can't add an organization to a Team plan now: none of the account's runs, the plan has as many as it can,
 * too many were added in the last hour, or adding them was turned off. */
export const ORGANIZATION_BLOCKS = Object.freeze(["no_team_plan", "limit", "rate", "off"]);
/**
 * The session's `organizations` (contract v1, additive): the Team plan this account pays for whose organizations it runs,
 * whether one may be added now (else why), and how many it has of how many. Null without one, or from an older Admin.
 */
export function parseOrganizations(input) {
  if (!record(input) || typeof input.planCloudId !== "string" || !CLOUD_ID.test(input.planCloudId) || typeof input.canAdd !== "boolean") return null;
  if (!Number.isSafeInteger(input.count) || input.count < 0 || !Number.isSafeInteger(input.max) || input.max < 1) return null;
  const blocked = ORGANIZATION_BLOCKS.includes(input.addBlocked) ? input.addBlocked : null;
  return { planCloudId: input.planCloudId, canAdd: input.canAdd, ...(blocked && !input.canAdd ? { blocked } : {}), count: input.count, max: input.max };
}

/** OMB_CLOUD_STOPPED_HOLD_DAYS allows parts of a day, and at most 60. */
const keptDays = value => value === null ? null : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60 ? value : undefined;
/**
 * The account's own plan's renewal, from the verified session's raw `clouds`: its primary Cloud, only while the Admin says
 * this account pays for it and its plan runs (`renewal`), so never a team's Cloud someone else pays for. Null without one,
 * or from an Admin that doesn't say yet. `cloudId` is for main: Cancel and Keep name the Cloud from here, never from a page.
 */
export function parseCloudRenewal(clouds) {
  if (!Array.isArray(clouds)) return null;
  const own = clouds.slice(0, MAX_CLOUDS).find(entry => record(entry) && entry.primary === true && record(entry.renewal));
  if (!own || typeof own.id !== "string" || !CLOUD_ID.test(own.id) || typeof own.renewal.trial !== "boolean") return null;
  const endsAt = own.renewal.endsAt === null ? null : Number.isSafeInteger(own.renewal.endsAt) && own.renewal.endsAt > 0 ? own.renewal.endsAt : undefined;
  const kept = keptDays(own.renewal.keptDays), team = typeof own.teamId === "string" ? cleanCloudListName(own.name) : null;
  if (endsAt === undefined || kept === undefined) return null;
  return { cloudId: own.id, trial: own.renewal.trial, cancelled: own.cancelAtPeriodEnd === true,
    renewsAt: Number.isSafeInteger(own.renewsAt) && own.renewsAt > 0 ? own.renewsAt : null, endsAt, keptDays: kept, ...(team ? { team } : {}) };
}

/** Every Cloud of the person's own besides the primary (My Cloud): each a place of its own, as a team's Cloud is. */
export function otherOwnClouds(clouds) {
  return Array.isArray(clouds) ? clouds.filter(cloud => ownCloud(cloud) && !cloud.primary) : [];
}

/** The Cloud as the app's machine summary (cloud-home.mjs parseCloudSummary's shape); null while it is still at checkout. */
export function cloudMachine(cloud) {
  const status = cloud ? MACHINE_STATUS[cloud.status] : undefined;
  if (!status) return null;
  return { status, ...(cloud.origin ? { origin: cloud.origin } : {}), ...(status === "provisioning" && cloud.setup?.step ? { setup: { step: cloud.setup.step } } : {}) };
}

/** How far along a setup step is (0 to 1). */
export const stepProgress = step => (Object.hasOwn(STEP_PROGRESS, step) ? STEP_PROGRESS[step] : 0);

/** How far a Cloud being set up is (0 to 1), from the Admin's progress or else its step; 0 while it waits for its
 * payment, null once it is not being set up. */
export function cloudSetupProgress(cloud) {
  if (cloud?.status === "checkout") return 0;
  if (cloud?.status !== "setting_up") return null;
  return cloud.setup?.progress ?? stepProgress(cloud.setup?.step);
}

/** The colour a Cloud is shown in here: its swatch's, or none (slate, or no colour chosen). */
export const swatchColor = swatch => (Object.hasOwn(CLOUD_SWATCH_COLORS, swatch) ? CLOUD_SWATCH_COLORS[swatch] : null);

/** The colour the Admin keeps for My Cloud (`home`) and each team's Cloud, where one was chosen there (environments.cjs
 * withListedColors): the person's other Clouds take theirs with the rest of their saved place. */
export function listedColors(clouds) {
  return Array.isArray(clouds) ? clouds.filter(cloud => cloud.color !== null && cloud.managed !== false && (cloud.primary || cloud.teamId !== null))
    .map(cloud => ({ ...(cloud.primary ? { home: true } : { teamId: cloud.teamId }), color: swatchColor(cloud.color) })) : [];
}

/** A Cloud of the person's own besides My Cloud, as a saved place (environments.cjs withOwnCloud): its id, name, colour and address. */
export function ownCloudPlaces(clouds) {
  return otherOwnClouds(clouds).filter(cloud => cloud.origin).map(cloud => ({ id: cloud.id, role: cloud.role, name: cloud.name, color: swatchColor(cloud.color), origin: cloud.origin }));
}

/** The saved places once the session says where the account's own machine is: the place listed as home at another
 * address was My Cloud before this one. It leaves the list when the session's list has it as ended, or not at all;
 * otherwise (still one of the person's Clouds, or an Admin without the list) it stays, as a place of its own. */
export function withoutOldCloudHome(saved, state) {
  const machine = state?.status === "connected" ? state.machine : null;
  if (!machine?.origin || machine.status === "provisioning") return saved;
  const clouds = state.clouds;
  let next = saved;
  for (const entry of saved.environments) {
    if (entry.home !== true || entry.origin === machine.origin) continue;
    const listed = Array.isArray(clouds) ? clouds.find(cloud => cloud.origin === entry.origin) ?? null : null;
    if (Array.isArray(clouds) && (!listed || cloudState(listed) === "ended")) { next = environments.withoutEnvironment(next, entry.id); continue; }
    const { home: _home, ...rest } = entry;
    next = { ...next, environments: next.environments.map(candidate => (candidate.id === entry.id ? rest : candidate)) };
  }
  return next;
}

/** The name and colour the Admin lists the account's own machine's Cloud under, for its saved place; null when the
 * session lists none. */
export function homeLook(state) {
  const machine = state?.status === "connected" ? state.machine : null;
  const listed = machine?.origin && Array.isArray(state.clouds) ? state.clouds.find(cloud => ownCloud(cloud) && cloud.origin === machine.origin) : null;
  return listed?.name ? { name: listed.name, color: swatchColor(listed.color) } : null;
}
