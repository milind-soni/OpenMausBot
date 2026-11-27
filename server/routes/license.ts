// GET /api/license: the licence state for the owner's own Settings (plan, seats, expiry, grace left, where it was read
// from, whether it is valid). Never the key: it is a credential, and bot shells never reach this route.
//
// One more reader: the MausBot connector on a connected server reads the state from the server's loopback and reports it
// (connector/src/customer-run.ts). Where loopback is a service (a shared server, where every bot's shell is a local caller
// too) it has no session, so it presents LICENSE_PROOF_HEADER, a digest of the licence it saved here, and gets six fields
// back. Only a caller that holds a licence this server accepted can make that digest, and such a caller could read those
// fields from the licence itself: the allowance lets nobody else in.
import type { IncomingMessage } from "node:http";

import { licenseFilesUsed, licenseProofMatch, licenseState, type LicenseState } from "../enterprise.ts";
import { LICENSE_PROOF_HEADER } from "../license-proof.ts";
import { seatsInUse } from "../license-seats.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteContext } from "./table.ts";

export const LICENSE_PATH = "/api/license";
/** The connector reads every 30 seconds; a licence it read this recently came from MausBot and is renewed by it. */
const CONNECTED_MS = 10 * 60_000;

let connectorReadAt: number | null = null;

/** What the connector reports: the server's own judgement of its licence, never its customer, features or notice. */
export function licenseForConnector(state: LicenseState) {
  return { valid: state.valid, plan: state.plan, seats: state.seats, expiresAt: state.expiresAt, graceDaysLeft: state.graceDaysLeft, source: state.source };
}

/** What the owner's Settings shows: the state, how many people can sign in now, whether licence files are used here at all
 * (false on a desktop or a Cloud home, which show no licence card), and whether the licence in force is one the MausBot
 * connector delivered and still reads. */
export function licenseForSettings(state: LicenseState, now: number = Date.now()) {
  const connected = connectorReadAt !== null && now - connectorReadAt < CONNECTED_MS && state.source === "file";
  return { ...state, seatsUsed: seatsInUse(), files: licenseFilesUsed(), connected };
}

const proofOf = (req: IncomingMessage): string | undefined => {
  const value = req.headers[LICENSE_PROOF_HEADER];
  return typeof value === "string" ? value.trim() : undefined;
};

// A function declaration, not a const: table.ts lists it, and a declaration is ready even when this module is the one
// imported first.
export async function licenseRoutes({ req, res, path, method, auth, json }: RouteContext): Promise<typeof PASS | void> {
  if (path !== LICENSE_PATH) return PASS;
  if (method !== "GET") return json(res, 405, { error: "GET only" });
  const match = licenseProofMatch(proofOf(req));
  if (match === "in-force") connectorReadAt = Date.now();
  res.setHeader("cache-control", "no-store");
  if (ownerOrAdmin(auth)) return json(res, 200, licenseForSettings(licenseState()));
  if (match && auth.kind === "loopback") return json(res, 200, licenseForConnector(licenseState()));
  return json(res, 403, { error: "Only the owner or an admin sees this server's licence." });
}

/** For tests: forget the connector's last read. */
export function resetLicenseRouteForTests(): void {
  connectorReadAt = null;
}
