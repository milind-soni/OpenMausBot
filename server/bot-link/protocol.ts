// What crosses the link between a person's computer and their Cloud (server/bot-link/link.ts). Every frame may arrive
// twice: a hand-off and its result carry the assignment's id, and the receiving side acts on an id once.
import { createHash } from "node:crypto";
import { z } from "zod";

/** A bot of another place is addressed here as `link-<that place's key>-<its id there>`, so the same id in two places,
 * or on two computers, is as many bots. The key is cut from the place's own identity. */
export const LINK_PREFIX = "link-";
const ADDRESS = /^link-([0-9a-f]{8})-(.+)$/su;
export const peerKey = (placeId: string): string => createHash("sha256").update(placeId).digest("hex").slice(0, 8);
export const linkedId = (peer: string, botId: string): string => `${LINK_PREFIX}${peer}-${botId}`;
export const isLinkedId = (botId: string | undefined): botId is string => typeof botId === "string" && botId.startsWith(LINK_PREFIX);
export const parseLinked = (linked: string): { peer: string; botId: string } | null => { const found = ADDRESS.exec(linked); return found ? { peer: found[1]!, botId: found[2]! } : null; };
/** The root that stands for a hand-off taken from another place, and the hand-off's id behind such a root. */
export const linkRoot = (handoffId: string): string => `${LINK_PREFIX}${handoffId}`;
export const handoffOfRoot = (rootId: string): string => rootId.slice(LINK_PREFIX.length);

export const SYNC_PATH = "/api/bot-link/sync";
export const PAIR_PATH = "/api/bot-link/pair";
export const STATE_PATH = "/api/bot-link";
/** One file of a hand-off or of its result, as bytes: the computer puts the ones it sends and gets the ones it is sent. */
export const FILE_PATH = "/api/bot-link/file";
/** As many as one assignment may carry in all (server/host/handoff-files.ts). */
export const FILES_MAX = 20;
/** How long the Cloud holds a sync open when it has nothing to send. */
export const HOLD_MS = 25_000;
/** A computer that has not asked for this long is offline. */
export const SEEN_MS = HOLD_MS + 20_000;
/** A link the computer has not used for this long ends on the Cloud: its sign-in is revoked and work waiting for it fails. */
export const LINK_EXPIRES_MS = 30 * 24 * 60 * 60_000;
/** One exchange carries about this much; what is left goes with the next. */
export const EXCHANGE_BYTES = 1_500_000;
/** Computers one Cloud links at a time. */
export const PEERS_MAX = 10;
export const BRIEF_MAX = 12_000;
const RESULT_MAX = 200_000;

const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(120);
export const placeSchema = z.object({ id, name }).strict();
export type Place = z.infer<typeof placeSchema>;

const level = z.enum(["ask", "edits", "auto", "full", "custom"]);
export const linkedBotSchema = z.object({
  id, name, title: z.string().max(200).optional(), description: z.string().max(400).optional(), model: z.string().max(200).optional(), level: level.optional(),
}).strict();
export type LinkedBot = z.infer<typeof linkedBotSchema>;

export const fileMeta = z.object({ name: z.string().min(1).max(255), mime: z.string().max(200), kind: z.enum(["image", "file"]), bytes: z.number().int().nonnegative() }).strict();
export type FileMeta = z.infer<typeof fileMeta>;
const files = z.array(fileMeta).max(FILES_MAX).optional();
export const fileWay = z.enum(["sent", "returned"]);
export type FileWay = z.infer<typeof fileWay>;

const handoff = z.object({
  t: z.literal("handoff"), id, to: id,
  from: z.object({ botId: id, name, threadId: id }).strict(),
  /** The requester's name for the thread the work runs in: the same one continues the same thread on the working side. */
  thread: id,
  text: z.string().max(BRIEF_MAX),
  mode: z.enum(["work", "consult", "notify"]),
  origin: z.object({ kind: z.enum(["person", "routine", "outside"]), quote: z.string().max(2_000).optional() }).strict(),
  person: z.string().max(120).optional(),
  doneWhen: z.string().max(2_000).optional(),
  /** The files that travel with it: their bytes cross apart, by FILE_PATH, before the working side starts. */
  files,
}).strict();
export type HandoffFrame = z.infer<typeof handoff>;

export const frameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), place: placeSchema, bots: z.array(linkedBotSchema).max(500) }).strict(),
  handoff,
  z.object({ t: z.literal("result"), id, ok: z.boolean(), text: z.string().max(RESULT_MAX), outcome: z.string().max(40).optional(), files }).strict(),
  z.object({ t: z.literal("done"), id }).strict(),
  z.object({ t: z.literal("cancel"), id }).strict(),
  z.object({ t: z.literal("bye") }).strict(),
]);
export type Frame = z.infer<typeof frameSchema>;
export type ResultFrame = Extract<Frame, { t: "result" }>;

export const numbered = z.object({ seq: z.number().int().positive(), frame: z.unknown() }).strict();
export type Numbered = { seq: number; frame: Frame };

export const syncRequest = z.object({
  /** The computer starts a new session: each side sends again what the other has not acknowledged. */
  fresh: z.boolean().optional(),
  /** The highest frame of the Cloud's this computer has taken. */
  ack: z.number().int().nonnegative(),
  frames: z.array(z.unknown()).max(500),
  wait: z.number().int().min(0).max(HOLD_MS),
}).strict();
export const syncAnswer = z.object({ session: z.string().min(1).max(80), frames: z.array(numbered).max(2_000) }).strict();
