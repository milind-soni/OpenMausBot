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

/** Validate the session's `cloud` summary. A malformed one means no machine,
 * never a partly trusted one. Only the state and the address are read: Cloud
 * Pro includes no AI, so there is no allowance to show. */
export function parseCloudSummary(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const status = Object.hasOwn(ADMIN_STATES, input.state) ? ADMIN_STATES[input.state] : null;
  if (!status) return null;
  const origin = input.origin === undefined || input.origin === null ? null : homeOrigin(input.origin);
  if ((input.origin !== undefined && input.origin !== null && !origin) || (CLOUD_MACHINE_CONNECTABLE.includes(status) && !origin)) return null;
  return { status, ...(origin ? { origin } : {}) };
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

/** Where "Connect to my Cloud" opens: the machine's own pairing page with the
 * one-time code in the hash (never a query), or the machine itself when this
 * app is already signed in there. */
export function cloudHomeConnectUrl(target, now) {
  return target.grant && target.grant.origin === target.origin && target.grant.expiresAt > now
    ? `${target.origin}/pair#code=${target.grant.code}` : target.origin;
}
