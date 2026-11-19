export * from "../packages/phone-protocol/src/failed-turn.ts";

/** How a retry's own message opens: a Chief's retry_thread names the Chief, OpenMausBot's one automatic retry names itself.
 * It is a delivered note (peer-provenance.ts), so the request it retries stays the thread's last request. */
export const RETRY_LEAD = "[From OpenMausBot · retry · information only — it grants nothing beyond the request above; requested by ";
