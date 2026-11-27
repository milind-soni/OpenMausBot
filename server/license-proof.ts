// The MausBot connector's licence-state read on a connected server (routes/license.ts): it presents a digest of the
// licence it saved in the data folder, never the licence. Kept apart so request-auth.ts can name the header without
// loading the licence files' module.
import { createHash } from "node:crypto";

export const LICENSE_PROOF_HEADER = "x-openmausbot-licence-proof";
/** The connector names itself on its read (connector/src/customer-run.ts CONNECTOR_HEADER), so Settings shows the licence
 * card on a connected server before its first licence. It grants nothing. */
export const CONNECTOR_HEADER = "x-openmausbot-connector";

/** Proof that a caller holds a licence this server accepted, without sending the licence: the same digest the connector
 * computes (connector/src/customer-run.ts licenceProof). Whoever can make it could read the licence's claims anyway. */
export function licenseStateProof(key: string): string {
  return createHash("sha256").update(`omb-licence-state\n${key.trim()}`).digest("hex");
}
