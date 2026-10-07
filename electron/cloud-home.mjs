// The person's OMB Cloud Pro machine, as their Cloud session reports it
// (docs/cloud-pro.md; openmaus-cloud docs/consumer-cloud.md). Pure:
// cloud-account.mjs validates the Admin's answers with it, main.mjs lists the
// machine under Servers and connects to it.
//
// A pairing code is a single-use window the Admin opens on the machine when
// the person chooses Connect. It lives in main-process memory for one
// navigation: never persisted, never sent to a renderer, and carried only in
// the pairing link's hash.
import environments from "./environments.cjs";

export const CLOUD_HOME_NAME = "My Cloud";
export const CLOUD_MACHINE_STATUSES = Object.freeze(["provisioning", "ready", "stopped", "payment-problem", "failed"]);
/** Statuses in which the machine answers and may be connected to. */
export const CLOUD_MACHINE_CONNECTABLE = Object.freeze(["ready"]);
// The Admin's `cloud.state` words, contract version 1.
const ADMIN_STATES = Object.freeze({
  setting_up: "provisioning", ready: "ready", stopped: "stopped", payment_problem: "payment-problem", failed: "failed",
});
// formatPairingCode: three groups of four from the server's pairing alphabet.
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

/** Setup's steps, in order, as the Cloud page names them. */
export const CLOUD_SETUP_STEPS = Object.freeze(["reserving", "storage", "starting", "checking"]);
const GB = 1024 ** 3;
const record = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const moment = value => Number.isSafeInteger(value) && value > 0;
const wholeGb = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000;

/** Validate the session's `cloud` summary. A malformed one means no machine,
 * never a partly trusted one. The state and the address decide; the rest is
 * optional and additive (an Admin may not send it yet), so a malformed extra
 * is dropped, never the machine: `setup` (the step setting up is at, and
 * whether it is slow), `retryAt` (when a failed setup is tried again) and
 * `disk` (the volume now and the most the plan lets it grow to). */
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
  return { status, ...(origin ? { origin } : {}), ...(setup ? { setup } : {}), ...(retryAt ? { retryAt } : {}), ...(disk ? { disk } : {}) };
}

const PURCHASE_STATES = Object.freeze(["confirming", "held"]);
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
/** A payment the Admin has received but not yet linked to this account
 * (`cloud.purchase`, additive): while it exists, nobody is asked to pay
 * again. It never activates anything; only the entitlement does. */
export function parseCloudPurchase(input) {
  if (!record(input) || !PURCHASE_STATES.includes(input.state)) return null;
  const tier = typeof input.plan === "string" && TIER.test(input.plan) ? input.plan : null;
  return { state: input.state, ...(tier ? { tier } : {}), ...(moment(input.paidAt) ? { paidAt: input.paidAt } : {}) };
}

/** The paid plan with the largest disk: nobody on it is pointed at a larger one. */
const LARGEST_TIER = "max";
/** The disk a verified paid plan's Cloud has now and may grow to, only as
 * the Admin says it (`cloud.disk`). Without that word the Cloud's own free
 * space is all a move is measured against: an Admin that does not say how
 * far the disk grows cannot grow it for a move either (Pro's disk, for one,
 * is fixed unless the Admin is set to let it grow). `largest`: the top plan. */
export function cloudPlanDisk(state) {
  if (state?.status !== "connected" || state.entitlement?.plan !== "pro") return null;
  const disk = state.machine?.disk;
  if (!disk) return null;
  return { volumeBytes: disk.gb * GB, maxBytes: disk.maxGb * GB, ...(state.entitlement.tier === LARGEST_TIER ? { largest: true } : {}) };
}

/** The person's Cloud address, remembered for their account while a check
 * with OpenMausBot Cloud is pending or has failed, or the sign-in has ended,
 * so the Server menu still knows "My Cloud" is theirs. Forgotten on sign-out,
 * another account, or a check that names no machine for this account (a
 * machine named without its address, stopped, keeps it). */
export function rememberedCloudHome(previous, state) {
  const accountId = state?.account?.id ?? null;
  if (!accountId) return null;
  if (state.status === "connected" && !state.machine) return null;
  const origin = state.status === "connected" ? state.machine.origin ?? null : null;
  if (origin) return { accountId, origin };
  return previous?.accountId === accountId ? previous : null;
}

/** The one rule for "this page is my Cloud": the Cloud page's own channels
 * (Settings → Plan, its setup checklist) and the microphone for a Live call
 * both ask it. The machine the sign-in verified or, failing that, the one this
 * same account last verified (rememberedCloudHome): while a check is pending
 * or has failed, and after the sign-in has ended or expired, when its Settings
 * → Plan says "sign in again on your computer". None when signed out, for
 * another account, after a check that names no machine, after a restart until
 * a check succeeds (it is kept in memory only), or in companion client mode,
 * where this app has no Cloud of its own.
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

/** Whether choosing this Server entry means "open my Cloud", which goes
 * through the Cloud's own connection (no pairing code to type). */
export function isCloudHomeEntry(entry, { homeOrigin = null, remembered = null } = {}) {
  return Boolean(entry?.origin) && (entry.origin === homeOrigin || entry.origin === remembered?.origin);
}

/** The saved server listed as "My Cloud" (withCloudHome): all this app knows
 * of the person's Cloud before their saved sign-in has been restored at
 * launch. A hint, never a verified Cloud. */
export function savedCloudHomeOrigin(state) {
  const saved = Array.isArray(state?.environments) ? state.environments : [];
  return saved.find((entry) => entry?.name === CLOUD_HOME_NAME)?.origin ?? null;
}

/** Validate `POST /api/cloud/desktop/pairing` for the machine it was asked for. */
export function parsePairingGrant(input, origin, now) {
  if (!input || typeof input !== "object" || input.cloudContractVersion !== 1 || input.origin !== origin) return null;
  if (typeof input.code !== "string" || !CODE.test(input.code)) return null;
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_GRANT_MS) return null;
  return { origin, code: input.code, expiresAt: input.expiresAt };
}

/** List the machine under Servers once it has an address. Adds only: an
 * existing entry keeps its name, and nothing becomes active. */
export function withCloudHome(state, machine, makeId) {
  if (!machine?.origin || machine.status === "provisioning") return state;
  if (state.environments.some((entry) => entry.origin === machine.origin)) return state;
  return environments.withEnvironment(state, { origin: machine.origin, name: CLOUD_HOME_NAME }, makeId);
}

/** Where "Open My Cloud" opens: the machine's own pairing page with the
 * one-time code in the hash (never a query), or the machine itself when this
 * app is already signed in there. `open` "phone" ("Use your Cloud on your
 * phone") adds the one fixed request `?desktop-settings=phone`: the Cloud
 * opens Settings on its phone pairing, and the pair page carries it on. */
export function cloudHomeConnectUrl(target, now, open = null) {
  const query = open === "phone" ? "?desktop-settings=phone" : "";
  return target.grant && target.grant.origin === target.origin && target.grant.expiresAt > now
    ? `${target.origin}/pair${query}#code=${target.grant.code}` : query ? `${target.origin}/${query}` : target.origin;
}
