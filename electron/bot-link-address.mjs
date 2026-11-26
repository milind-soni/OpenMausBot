// The address a bot of the person's other place has over the link (server/bot-link/protocol.ts): `link-<place key>-<its
// id there>`, the place key cut from that place's own identity. Main computes it for the rows the sidebar lists
// (places-together.mjs), so a row and the link's record of the same bot (a stand-in) carry one id.
// server/bot-link/address.test.ts holds this file and the server's own to the same answer.
import { createHash } from "node:crypto";

/** The eight hex characters that stand for one place in every address of its bots. */
export const placeKey = (placeId) => createHash("sha256").update(String(placeId)).digest("hex").slice(0, 8);

/** A bot's address in the other place: the place it lives in, and its id there. */
export const linkedAddress = (placeId, botId) => `link-${placeKey(placeId)}-${botId}`;
