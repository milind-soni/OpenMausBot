// A pairing code lives in main-process memory for one navigation: never persisted, never sent to a renderer, only in a link's hash.
import environments from "./environments.cjs";

export { createCloudPowerGate, openSleepingCloud } from "./cloud-power.mjs";

export const CLOUD_HOME_NAME = "My Cloud";
export const CLOUD_MACHINE_STATUSES = Object.freeze(["provisioning", "ready", "stopped", "payment-problem", "failed"]);
export const CLOUD_MACHINE_CONNECTABLE = Object.freeze(["ready"]);
// The Admin's `cloud.state` words, contract version 1.
const ADMIN_STATES = Object.freeze({
  setting_up: "provisioning", ready: "ready", stopped: "stopped", payment_problem: "payment-problem", failed: "failed",
});
const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const MAX_GRANT_MS = 10 * 60_000;

export function homeOrigin(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || value !== url.origin || !url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const CLOUD_SETUP_STEPS = Object.freeze(["reserving", "storage", "starting", "checking"]);
export const CLOUD_UNREACHABLE_CAUSES = Object.freeze(["host", "no_answer"]);
const GB = 1024 ** 3;
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const moment = value => Number.isSafeInteger(value) && value > 0;
const POWER_STATES = Object.freeze(["awake", "asleep", "waking"]);
/** The Admin sends `cloud.power` only for a Cloud whose plan sleeps when idle. */
export function parseCloudPower(input) {
  if (!record(input) || !POWER_STATES.includes(input.state) || !moment(input.since) || input.sleeps !== true) return null;
  return { state: input.state, since: input.since, sleeps: true };
}
const wholeGb = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000;

const DEVICE_NAME_MAX = 100;
/** A computer's installation id, as one-home-main.mjs `installationOf` derives it and the Admin keeps it. */
export const INSTALLATION_ID = /^[A-Za-z0-9_-]{22,64}$/u;
/** An ended My Cloud's `hold.homecoming`: the one computer its things come home to, by installation, and its name. */
function parseHomecoming(input) {
  if (!record(input) || typeof input.installationId !== "string" || !INSTALLATION_ID.test(input.installationId) || typeof input.name !== "string") return null;
  const name = input.name.trim();
  return name && name.length <= DEVICE_NAME_MAX && !/\p{Cc}/u.test(name) ? { installationId: input.installationId, name } : null;
}

/** A malformed summary is no machine, never a partly trusted one; a malformed optional extra is dropped. */
export function parseCloudSummary(input) {
  if (!record(input)) return null;
  const status = Object.hasOwn(ADMIN_STATES, input.state) ? ADMIN_STATES[input.state] : null;
  if (!status) return null;
  const origin = input.origin === undefined || input.origin === null ? null : homeOrigin(input.origin);
  if ((input.origin !== undefined && input.origin !== null && !origin) || (CLOUD_MACHINE_CONNECTABLE.includes(status) && !origin)) return null;
  const setup = status === "provisioning" && record(input.setup) && CLOUD_SETUP_STEPS.includes(input.setup.step)
    ? { step: input.setup.step, ...(input.setup.slow === true ? { slow: true } : {}) } : null;
  const retryAt = status === "failed" && moment(input.retryAt) ? input.retryAt : null;
  const disk = record(input.disk) && wholeGb(input.disk.gb) && wholeGb(input.disk.maxGb) && input.disk.maxGb >= input.disk.gb
    ? { gb: input.disk.gb, maxGb: input.disk.maxGb } : null;
  const unreachable = status === "ready" && record(input.unreachable) && CLOUD_UNREACHABLE_CAUSES.includes(input.unreachable.cause) && moment(input.unreachable.since)
    ? { cause: input.unreachable.cause, since: input.unreachable.since } : null;
  const power = parseCloudPower(input.power);
  const homecoming = record(input.hold) ? parseHomecoming(input.hold.homecoming) : null;
  const hold = record(input.hold) && moment(input.hold.until) ? { until: input.hold.until, ...(homecoming ? { homecoming } : {}) } : null;
  return { status, ...(origin ? { origin } : {}), ...(setup ? { setup } : {}), ...(retryAt ? { retryAt } : {}), ...(disk ? { disk } : {}), ...(unreachable ? { unreachable } : {}), ...(power ? { power } : {}),
    ...(input.moves === true ? { moves: true } : {}), ...(hold ? { hold } : {}) };
}

const UNREACHABLE_TEXT = Object.freeze({
  host: "The server My Cloud runs on is being restarted by our hosting provider. My Cloud and its files are safe, and it comes back on its own, usually within about 20 minutes.",
  no_answer: "My Cloud hasn't answered for a few minutes. Nothing was lost, and we've been told.",
});
/** Why My Cloud can't be reached when the Admin says so, for main's dialogs; with `origin`, only for that server. */
export function cloudUnreachableText(state, origin = null) {
  const machine = state?.status === "connected" ? state.machine : null;
  if (!machine?.unreachable || (origin !== null && machine.origin !== origin)) return null;
  return UNREACHABLE_TEXT[machine.unreachable.cause] ?? null;
}

const PURCHASE_STATES = Object.freeze(["confirming", "held"]);
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
/** It never activates anything; only the entitlement does. */
export function parseCloudPurchase(input) {
  if (!record(input) || !PURCHASE_STATES.includes(input.state)) return null;
  const tier = typeof input.plan === "string" && TIER.test(input.plan) ? input.plan : null;
  return { state: input.state, ...(tier ? { tier } : {}), ...(moment(input.paidAt) ? { paidAt: input.paidAt } : {}) };
}

export const CLOUD_TRIAL_STATES = Object.freeze(["active", "ending", "processing", "late", "ended"]);
const TRIAL_KEEP = Object.freeze(["none", "portal", "checkout"]);
const at = value => moment(value) ? value : null;
const PLAN_TIERS = Object.freeze(["starter", "personal", "pro", "max"]);
/** Wording only, never an entitlement. Amounts are US cents before tax. */
export function parseCloudTrial(input) {
  if (!record(input) || !CLOUD_TRIAL_STATES.includes(input.state) || !moment(input.endsAt) || !TRIAL_KEEP.includes(input.keep)) return null;
  const tier = typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : null;
  const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
  const amount = cents(input.amount), personal = cents(input.personalAmount);
  const switchTo = record(input.switchTo) && PLAN_TIERS.includes(input.switchTo.tier) && cents(input.switchTo.amount)
    ? { tier: input.switchTo.tier, amount: input.switchTo.amount } : null;
  return { state: input.state, ...(tier ? { tier } : {}), endsAt: input.endsAt, amount,
    chargeAt: at(input.chargeAt), holdUntil: at(input.holdUntil), deleteAt: at(input.deleteAt), keep: input.keep, ...(personal ? { personalAmount: personal } : {}),
    ...(switchTo ? { switchTo } : {}) };
}

const dollars = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;
/** In US dollars; spent and metered only by the Admin. */
export function parseCloudCredit(input) {
  if (!record(input) || !["active", "used_up"].includes(input.state) || !dollars(input.grantedUsd) || input.grantedUsd <= 0 ||
    !dollars(input.remainingUsd) || input.remainingUsd > input.grantedUsd) return null;
  return { grantedUsd: input.grantedUsd, remainingUsd: input.remainingUsd, state: input.state };
}

export const CLOUD_USAGE_KINDS = Object.freeze(["computerHours", "voice", "decisions", "x", "research", "storage"]);
const amount = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;
/** Display only, never an entitlement. */
export function parseCloudUsage(input) {
  if (!record(input) || typeof input.tier !== "string" || !TIER.test(input.tier) || !moment(input.resetsAt) || !Array.isArray(input.meters)) return null;
  const meters = input.meters.slice(0, 20).flatMap(meter => record(meter) && CLOUD_USAGE_KINDS.includes(meter.kind) && amount(meter.used) && amount(meter.max) && meter.max > 0
    ? [{ kind: meter.kind, used: meter.used, max: meter.max, ...(meter.usedUp === true ? { usedUp: true } : {}) }] : []);
  const kinds = new Set(), unique = meters.filter(meter => !kinds.has(meter.kind) && kinds.add(meter.kind));
  const upgrades = (Array.isArray(input.upgrades) ? input.upgrades.slice(0, 10) : []).flatMap(plan => record(plan) && PLAN_TIERS.includes(plan.tier) && plan.tier !== input.tier
    && Number.isSafeInteger(plan.amount) && plan.amount >= 1 && plan.amount <= 10_000_000 ? [{ tier: plan.tier, amount: plan.amount }] : []);
  return { tier: input.tier, resetsAt: input.resetsAt, ...(moment(input.trialEndsAt) ? { trialEndsAt: input.trialEndsAt } : {}), meters: unique, upgrades };
}

const days = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
// oxlint-disable-next-line no-control-regex
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 40 && !/[\x00-\x1f\x7f<>]/.test(value) ? value.trim() : null;
function planAllowances(input) {
  if (!record(input) || !["cpus", "memoryMb", "diskGb", "maxDiskGb", "computers", "computerHours", "voiceCharacters"].every(key => count(input[key]))) return null;
  return { cpus: input.cpus, ...(["shared", "performance"].includes(input.cpuKind) ? { cpuKind: input.cpuKind } : {}), memoryMb: input.memoryMb, diskGb: input.diskGb, maxDiskGb: Math.max(input.maxDiskGb, input.diskGb),
    computers: input.computers, computerHours: input.computerHours, voiceCharacters: input.voiceCharacters, ...(input.sleeps === true ? { sleeps: true } : {}),
    ...(count(input.swapMb) && input.swapMb > 0 ? { swapMb: input.swapMb } : {}), ...(days(input.snapshotDays, 365) ? { snapshotDays: input.snapshotDays } : {}) };
}
/** Monthly price before tax in US cents; a plan without one is not sold here. */
function offerPlan(input) {
  if (!record(input) || typeof input.tier !== "string" || !TIER.test(input.tier) || !record(input.price)) return null;
  const { price } = input;
  if (price.currency !== "USD" || price.interval !== "month" || !Number.isSafeInteger(price.amount) || price.amount < 1 || price.amount > 10_000_000) return null;
  const allowances = planAllowances(input.allowances), trial = days(input.trialDays, 30);
  return { tier: input.tier, ...(label(input.label) ? { label: label(input.label) } : {}), amount: price.amount,
    ...(allowances ? { allowances } : {}), ...(trial ? { trialDays: trial } : {}) };
}
/** An Admin older than this app may still list these; their subscribers keep them, but nobody new buys them here. */
const NOT_SOLD = Object.freeze(["personal"]);
function offerPlans(input, allDays) {
  const plans = [];
  for (const entry of Array.isArray(input) ? input.slice(0, 10) : []) {
    const plan = offerPlan(entry);
    if (plan && !NOT_SOLD.includes(plan.tier) && !plans.some(known => known.tier === plan.tier)) plans.push(plan);
  }
  if (allDays && !plans.some(plan => plan.trialDays)) return plans.map(plan => ({ ...plan, trialDays: allDays }));
  return plans;
}
function offerOf(plans, { recommended, creditUsd, reminderDays, refundDays }) {
  if (!plans.length) return null;
  const trial = plans.some(plan => plan.trialDays);
  const preselected = plans.find(plan => plan.tier === recommended) ?? plans.find(plan => plan.tier === "pro") ?? plans[0];
  const credit = trial && typeof creditUsd === "number" && Number.isFinite(creditUsd) && creditUsd > 0 && creditUsd <= 100 ? creditUsd : null;
  const reminder = trial ? days(reminderDays, 30) : null, refund = days(refundDays, 90);
  return { plans, recommended: preselected.tier, ...(credit ? { creditUsd: credit } : {}), ...(reminder ? { reminderDays: reminder } : {}), ...(refund ? { refundDays: refund } : {}) };
}

export function parseCloudOffer(input) {
  if (!record(input)) return null;
  const offer = offerOf(offerPlans(input.plans, days(input.trialDays, 30)), input);
  if (!offer) return null;
  const open = record(input.checkout) && offer.plans.some(plan => plan.tier === input.checkout.plan) && moment(input.checkout.openUntil)
    ? { plan: input.checkout.plan, openUntil: input.checkout.openUntil } : null;
  return { ...offer, ...(open ? { checkout: open } : {}) };
}

export function parsePublicOffer(config) {
  if (!record(config)) return null;
  const trial = record(config.trial) ? config.trial : {};
  return offerOf(offerPlans(config.plans, days(trial.days, 30)), { creditUsd: trial.creditUsd, reminderDays: trial.reminderDays, refundDays: config.refundDays });
}

export function withoutTrial(offer) {
  if (!offer) return null;
  const { creditUsd: _credit, reminderDays: _reminder, checkout: _checkout, ...rest } = offer;
  return { ...rest, plans: offer.plans.map(({ trialDays: _days, ...plan }) => plan) };
}

const LARGEST_TIER = "max";
export function cloudPlanDisk(state) {
  if (state?.status !== "connected" || state.entitlement?.plan !== "pro") return null;
  const disk = state.machine?.disk;
  if (!disk) return null;
  return { volumeBytes: disk.gb * GB, maxBytes: disk.maxGb * GB, ...(state.entitlement.tier === LARGEST_TIER ? { largest: true } : {}) };
}

/** My Cloud's address once the Admin says it is ready, and never before: a name looked up while it is set up does not
 * exist yet, and resolvers keep that "no such name" for minutes (RFC 2308 negative caching). */
export function readyCloudOrigin(state) {
  const machine = state?.status === "connected" ? state.machine : null;
  return machine?.origin && CLOUD_MACHINE_CONNECTABLE.includes(machine.status) ? machine.origin : null;
}

/** A machine the Admin is setting up: the step it reports, and whether it is slow. */
export function machineSetup(machine) {
  if (machine?.status !== "provisioning") return null;
  return machine.setup ? { step: machine.setup.step, ...(machine.setup.slow ? { slow: true } : {}) } : {};
}

/** My Cloud is being set up: the Admin says so, or a payment it is still confirming has no machine yet. */
export function cloudSetupOf(state) {
  if (state?.status !== "connected") return null;
  if (state.machine) return machineSetup(state.machine);
  return state.purchase?.state === "confirming" ? {} : null;
}

export function rememberedCloudHome(previous, state) {
  const accountId = state?.account?.id ?? null;
  if (!accountId) return null;
  if (state.status === "connected" && (!state.machine || state.machine.status === "provisioning")) return null;
  const origin = state.status === "connected" ? state.machine.origin ?? null : null;
  if (origin) return { accountId, origin };
  return previous?.accountId === accountId ? previous : null;
}

/** Signs this app back in to the person's own Cloud when its session there has ended (unused for a month, or signed out
 * there), so lending resumes by itself: a fresh one-time code from the Admin for the Cloud it verified, redeemed into the
 * window's own cookie, as opening My Cloud does. Never for any other origin. */
export async function signInCloudSession({ origin, mine, pair, fetch: fetchImpl }) {
  if (!origin || origin !== mine) return false;
  try {
    const grant = await pair();
    if (grant?.origin !== origin || typeof grant.code !== "string") return false;
    const response = await fetchImpl(`${origin}/api/auth/pair`, {
      method: "POST", credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin }, body: JSON.stringify({ code: grant.code, cookie: true, label: "OpenMausBot app (lending)" }),
    });
    return response.ok;
  } catch { return false; }
}

/** The one rule for "this page is my Cloud".
 *
 * @param {{ account: { homeTarget(): { origin: string } | null, state(): { account?: { id: string } } } | null,
 *   remembered: { accountId: string, origin: string } | null, remoteAccess: unknown }} known
 * @returns {string | null} */
export function myCloudOrigin({ account, remembered, remoteAccess }) {
  if (remoteAccess || !account) return null;
  const verified = account.homeTarget()?.origin;
  if (verified) return verified;
  const accountId = account.state()?.account?.id;
  return accountId && remembered?.accountId === accountId ? remembered.origin : null;
}

export function isCloudHomeEntry(entry, { homeOrigin = null, remembered = null } = {}) {
  return Boolean(entry?.origin) && (entry.origin === homeOrigin || entry.origin === remembered?.origin);
}

/** A hint, never a verified Cloud: the entry this app listed for it (`home`), or one still under the default name. */
export function savedCloudHomeOrigin(state) {
  const saved = Array.isArray(state?.environments) ? state.environments : [];
  return (saved.find((entry) => entry?.home === true) ?? saved.find((entry) => entry?.name === CLOUD_HOME_NAME))?.origin ?? null;
}

/** The Admin's role words on the wire (owner, admin, member), and the three words the app shows for them. */
export const CLOUD_TEAM_ROLES = environments.TEAM_ROLES;
export const teamRoleLabel = environments.teamRoleLabel;
const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEAMS = 50;
/** The teams this account is in, from the verified session only: each with its role and its Cloud as `parseCloudSummary`
 * reads it (null while the team has no machine). A malformed team is left out, never trusted in part; the same team
 * twice is read once. */
export function parseCloudTeams(input) {
  if (!Array.isArray(input)) return [];
  const teams = [], seen = new Set();
  for (const team of input.slice(0, MAX_TEAMS)) {
    if (!record(team) || typeof team.id !== "string" || !TEAM_ID.test(team.id) || seen.has(team.id) || !CLOUD_TEAM_ROLES.includes(team.role)) continue;
    const name = typeof team.name === "string" ? team.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    if (!name) continue;
    const machine = team.machine === null || team.machine === undefined ? null : parseCloudSummary(team.machine);
    seen.add(team.id);
    teams.push({ id: team.id, name, role: team.role, machine });
  }
  return teams;
}

export function parsePairingGrant(input, origin, now) {
  if (!input || typeof input !== "object" || input.cloudContractVersion !== 1 || input.origin !== origin) return null;
  if (typeof input.code !== "string" || !CODE.test(input.code)) return null;
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_GRANT_MS) return null;
  return { origin, code: input.code, expiresAt: input.expiresAt };
}

/** Listed once, under the name and colour its owner chose while it was set up (`look`), else My Cloud; never renamed here after. */
export function withCloudHome(state, machine, makeId, look = null) {
  if (!machine?.origin || machine.status === "provisioning") return state;
  if (state.environments.some((entry) => entry.origin === machine.origin)) return state;
  const added = environments.withEnvironment(state, { origin: machine.origin, name: look?.name || CLOUD_HOME_NAME }, makeId);
  const color = environments.ENTRY_COLORS.includes(look?.color) ? look.color : null;
  return { ...added, environments: added.environments.map((entry) => entry.origin === machine.origin ? { ...entry, ...(color ? { color } : {}), home: true } : entry) };
}

/** The one-time code goes in the hash, never a query. `route`: a path of the Cloud's own to land on after signing in. */
export function cloudHomeConnectUrl(target, now, open = null, route = null) {
  const params = new URLSearchParams(open === "phone" ? { "desktop-settings": "phone" } : {});
  const back = typeof route === "string" && /^\/(?!\/)/.test(route) ? route : null;
  if (target.grant && target.grant.origin === target.origin && target.grant.expiresAt > now) {
    if (back) params.set("next", back);
    const query = params.size ? `?${params}` : "";
    return `${target.origin}/pair${query}#code=${target.grant.code}`;
  }
  if (back) return `${target.origin}${back}`;
  return params.size ? `${target.origin}/?${params}` : target.origin;
}

/** Only the verified Cloud, open as this window's active server, in the main window's main frame. */
export function cloudPageSenderAllowed(event, { contents, homeOrigin, activeOrigin }) {
  if (!contents || !homeOrigin || activeOrigin !== homeOrigin) return false;
  if (event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === homeOrigin; } catch { return false; }
}
