// What a link keeps on disk (server/bot-link/link.ts): its record, `bot-link.json`, and the links that ended while their
// Cloud could not be told, `bot-link-ended.json`.
import { z } from "zod";

import { linkedBotSchema, placeSchema } from "./protocol.ts";

export const workSchema = z.object({
  /** The place it came from: its result goes there and nowhere else. */
  peer: z.string(),
  root: z.string(), from: z.string(), person: z.string().optional(), at: z.number(),
  /** The assignment here that does the work; its words are read from the runtime's own row. */
  child: z.string().optional(),
  done: z.object({ ok: z.boolean(), outcome: z.string().optional(), /** Kept only when no assignment here ran. */ text: z.string().optional() }).optional(),
  /** When the requester said it has the result. */
  ackedAt: z.number().optional(),
});
export const peerSchema = z.object({
  place: placeSchema, bots: z.array(linkedBotSchema),
  /** On the Cloud: the one session that may use this computer's link. */
  sessionId: z.string().optional(),
  seenAt: z.number(),
});
export const stateSchema = z.object({
  v: z.literal(2),
  /** `dialer`: a computer, which asks. `acceptor`: the Cloud, which answers. */
  role: z.enum(["dialer", "acceptor"]),
  self: placeSchema,
  /** dialer: the Cloud's address, this link's sign-in there, and the account it was made for. */
  origin: z.string().optional(), token: z.string().optional(), account: z.string().optional(),
  /** dialer: the Cloud is on a plan that sleeps, so it is asked only when it is known awake or there is work for it. */
  sleeps: z.boolean().optional(),
  peers: z.record(z.string(), peerSchema),
  /** Another place's thread names, each with the thread here its work runs in. */
  threads: z.record(z.string(), z.object({ threadId: z.string(), at: z.number() })),
  /** Hand-offs taken from another place, by assignment id. */
  work: z.record(z.string(), workSchema),
});
export type LinkState = z.infer<typeof stateSchema>;
export type Work = z.infer<typeof workSchema>;
export const endedSchema = z.array(z.object({ origin: z.string(), token: z.string(), at: z.number() })).max(10);
/** A link that was turned off while its Cloud could not be told: the Cloud is told when it can next be reached. */
export type EndedLink = z.infer<typeof endedSchema>[number];
