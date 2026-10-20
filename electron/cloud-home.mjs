// A pairing code lives in main-process memory for one navigation: never persisted, never sent to a renderer, only in a link's hash.
import environments from "./environments.cjs";

export { createCloudPowerGate, openSleepingCloud } from "./cloud-power.mjs";
export { installOneWorkspace } from "./one-workspace.mjs";

export const CLOUD_HOME_NAME = "My Cloud";
export const CLOUD_MACHINE_STATUSES = Object.freeze(["provisioning", "ready", "stopped", "payment-problem", "failed"]);
export const CLOUD_MACHINE_CONNECTABLE = Object.freeze(["ready"]);
// The Admin's `cloud.state` words, contract version 1.
const ADMIN_STATES = Object.freeze({
  setting_up: "provisioning", ready: "ready", stopped: "stopped", payment_problem: "payment-problem", failed: "failed",
});
const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const MAX_GRANT_MS = 10 * 60_000;

function homeOrigin(value) {
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
  return { status, ...(origin ? { origin } : {}), ...(setup ? { setup } : {}), ...(retryAt ? { retryAt } : {}), ...(disk ? { disk } : {}), ...(unreachable ? { unreachable } : {}), ...(power ? { power } : {}) };
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
/** Wording only, never an entitlement. Amounts are US cents before tax. */
export function parseCloudTrial(input) {
  if (!record(input) || !CLOUD_TRIAL_STATES.includes(input.state) || !moment(input.endsAt) || !TRIAL_KEEP.includes(input.keep)) return null;
  const tier = typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : null;
  const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
  const amount = cents(input.amount), personal = cents(input.personalAmount);
  return { state: input.state, ...(tier ? { tier } : {}), endsAt: input.endsAt, amount,
    chargeAt: at(input.chargeAt), holdUntil: at(input.holdUntil), deleteAt: at(input.deleteAt), keep: input.keep, ...(personal ? { personalAmount: personal } : {}) };
}

const dollars = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;
/** In US dollars; spent and metered only by the Admin. */
export function parseCloudCredit(input) {
  if (!record(input) || !["active", "used_up"].includes(input.state) || !dollars(input.grantedUsd) || input.grantedUsd <= 0 ||
    !dollars(input.remainingUsd) || input.remainingUsd > input.grantedUsd) return null;
  return { grantedUsd: input.grantedUsd, remainingUsd: input.remainingUsd, state: input.state };
}

const days = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
// oxlint-disable-next-line no-control-regex
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 40 && !/[\x00-\x1f\x7f<>]/.test(value) ? value.trim() : null;
function planAllowances(input) {
  if (!record(input) || !["cpus", "memoryMb", "diskGb", "maxDiskGb", "computers", "computerHours", "voiceCharacters"].every(key => count(input[key]))) return null;
  return { cpus: input.cpus, memoryMb: input.memoryMb, diskGb: input.diskGb, maxDiskGb: Math.max(input.maxDiskGb, input.diskGb),
    computers: input.computers, computerHours: input.computerHours, voiceCharacters: input.voiceCharacters, ...(input.sleeps === true ? { sleeps: true } : {}) };
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
function offerPlans(input, allDays) {
  const plans = [];
  for (const entry of Array.isArray(input) ? input.slice(0, 10) : []) {
    const plan = offerPlan(entry);
    if (plan && !plans.some(known => known.tier === plan.tier)) plans.push(plan);
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

export function rememberedCloudHome(previous, state) {
  const accountId = state?.account?.id ?? null;
  if (!accountId) return null;
  if (state.status === "connected" && !state.machine) return null;
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

/** The one-time code goes in the hash, never a query. */
export function cloudHomeConnectUrl(target, now, open = null) {
  const query = open === "phone" ? "?desktop-settings=phone" : "";
  return target.grant && target.grant.origin === target.origin && target.grant.expiresAt > now
    ? `${target.origin}/pair${query}#code=${target.grant.code}` : query ? `${target.origin}/${query}` : target.origin;
}
