// The link between a person's own computers and their own Cloud, so the bots of each work together as bots of one place
// do. A computer's server asks the Cloud (server/bot-link/dial.ts, a home computer has no address to be reached at) and
// both directions travel over that one standing exchange. Nothing here runs until the person turns the link on: without
// its state file no frame is sent, taken or acted on.
//
// The Cloud keeps one link for each computer; a computer keeps one, to its Cloud. A bot of another place is a teammate
// addressed as `link-<that place's key>-<its id there>`. Work handed to one is an assignment in this place's runtime
// whose turn the other place runs: `run` sends the hand-off and resolves with its result. The working side takes a
// hand-off once per assignment id, runs it as work of its own bot, and keeps its result until the requester has it. A
// hand-off, its result and its stop go only to the place they belong to.
//
// Security: the link joins only servers the same person signs in to as owner (server/routes/bot-link.ts), and work that
// crosses it counts as the person's own, as it does between two bots of one place. Work the Cloud hands a computer, and
// any turn there that what the Cloud wrote started (a far room member's answer that names a bot), follows the person's
// grant to their Clouds on that computer (server/bot-link/far-side.ts; turning this link on grants it, the OpenMausBot
// icon takes it back). While "Let Clouds run commands on this computer" is off, such a turn runs in its thread's own
// scratch folder with no shell, computer use, browser, phones, own MCP servers, Data tools or reads outside that folder;
// connected apps and Email only read; it writes no memory, schedules nothing, changes no setting, answers nothing for the
// person and leaves no words in another conversation; an engine that can't be held to that refuses it. Work a computer
// hands its Cloud runs in the Cloud's box. Still open: what comes back (results, files, a far member's line in a room) is
// read by the person's own turns at their level, and the grant is read when each turn starts. Turning the link off on
// the computer ends all of it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import type { CoordinateBotsCall, Coordinator, CoordinatorHost, HandoffView, HostTurnResult } from "../coordinator.ts";
import type { PassedFile } from "../host/handoff-files.ts";
import { foldName, withTargetsHere, type CoordinateResult, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { isIdStart } from "../peer-roster.ts";
import type { Level } from "../runtime/types.ts";
import { BRIEF_MAX, EXCHANGE_BYTES, FILES_MAX, LINK_EXPIRES_MS, PEERS_MAX, frameSchema, handoffOfRoot, isLinkedId, linkRoot, linkedBotSchema, linkedId, parseLinked, peerKey, placeSchema,
  type FileMeta, type FileWay, type Frame, type HandoffFrame, type LinkedBot, type Numbered, type Place, type ResultFrame } from "./protocol.ts";

const FILE = "bot-link.json";
const ENDED_FILE = "bot-link-ended.json";
const DAY_MS = 24 * 60 * 60_000;
/** A result the requester has is kept this long, so the same hand-off sent again after a restart is answered from it. */
const KEEP_ACKED_MS = 7 * DAY_MS;
/** One never acknowledged is kept as long as the runtime keeps its row. */
const KEEP_RESULTS_MS = 30 * DAY_MS;
const KEEP_THREADS_MS = 30 * DAY_MS;
const RECORDS_MAX = 1_000;
/** While a hand-off runs in a place that is connected, its node is told it is alive this often; that place's own clocks
 * bound the work. While that place cannot be reached the node is held as `away` instead. */
const ALIVE_EVERY_MS = 60_000;
/** How often a place's last contact is written down. */
const SEEN_WRITE_MS = 60 * 60_000;
const STOPPED = "Coordinated work was stopped";
const SPOOL = "bot-link-files";
/** Bytes that crossed and were never stored (their hand-off was dropped, a side restarted) are removed after this long,
 * and the oldest go first when all of them together pass the size. */
export const SPOOL_KEEP_MS = DAY_MS;
export const SPOOL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** A file the other side refuses is not offered for ever. */
const FILE_TRIES = 3;
/** A file that could not cross yet is tried again after this long, doubling up to five minutes. */
const FILE_RETRY_MS = 5_000;
const FILE_RETRY_MAX_MS = 5 * 60_000;
/** This place's bots changed: the other places hear the new list once changes settle, so a burst of them is one hello. */
const TELL_AFTER_MS = 250;
/** Under changes that do not stop, the other places still hear at least this often. */
const TELL_WITHIN_MS = 1_500;

/** How a computer moves a file's bytes: it puts the ones it sends and gets the ones it is sent. `holds`: the Cloud already
 * has this file, so it is not sent again. `gone` on an error: the Cloud said it will not take it or has no such file, so
 * asking again would not help. */
export interface FileTransfer {
  holds(id: string, way: FileWay, index: number, file: PassedFile): Promise<boolean>;
  push(id: string, way: FileWay, index: number, file: PassedFile): Promise<void>;
  pull(id: string, way: FileWay, index: number, meta: FileMeta, to: string): Promise<void>;
}
const gone = (message: string) => Object.assign(new Error(message), { gone: true });
const isGone = (error: unknown) => Boolean((error as { gone?: unknown } | null)?.gone);
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
const metaOf = (files: readonly PassedFile[]): FileMeta[] => files.slice(0, FILES_MAX).map(({ name, mime, kind, bytes }) => ({ name: name.slice(0, 255), mime: mime.slice(0, 200), kind, bytes }));
const GONE = "The result is no longer kept.";

const workSchema = z.object({
  /** The place it came from: its result goes there and nowhere else. */
  peer: z.string(),
  root: z.string(), from: z.string(), person: z.string().optional(), at: z.number(),
  /** The assignment here that does the work; its words are read from the runtime's own row. */
  child: z.string().optional(),
  done: z.object({ ok: z.boolean(), outcome: z.string().optional(), /** Kept only when no assignment here ran. */ text: z.string().optional() }).optional(),
  /** When the requester said it has the result. */
  ackedAt: z.number().optional(),
});
const peerSchema = z.object({
  place: placeSchema, bots: z.array(linkedBotSchema),
  /** On the Cloud: the one session that may use this computer's link. */
  sessionId: z.string().optional(),
  seenAt: z.number(),
});
const stateSchema = z.object({
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
type Work = z.infer<typeof workSchema>;
const endedSchema = z.array(z.object({ origin: z.string(), token: z.string(), at: z.number() })).max(10);
/** A link that was turned off while its Cloud could not be told: the Cloud is told when it can next be reached. */
export type EndedLink = z.infer<typeof endedSchema>[number];

interface LocalBot { id: string; name: string; color?: string; hidden?: boolean; title?: string; description?: string; movedTo?: unknown;
  mascotBody?: string | null; mascotFaceColor?: string | null; mascotBodyColor?: string | null; mascotMaterial?: string | null; chiefOfStaff?: boolean; threadId?: string }

export interface BotLinkDeps {
  dataDir: string;
  coordinator(): Coordinator;
  bots(): readonly LocalBot[];
  bot(id: string): LocalBot | null | undefined;
  /** Why this bot takes no work now (it moved away, it is paused), or null. */
  refusal?(bot: LocalBot): string | null;
  /** Why this bot cannot take work from the other place now, though it takes other work (its engine cannot be held to
   * what such work may do here): asked only as a hand-off arrives, never part of what the other places are told. */
  acceptRefusal?(bot: LocalBot): string | null;
  model?(bot: LocalBot): string | undefined;
  level(bot: LocalBot): Level;
  /** Opens the thread another place's work runs in, and returns its id. */
  openThread(bot: LocalBot, title: string, opener: { botId: string; name: string; threadId: string }, brief: string): string | undefined;
  hasThread(botId: string, threadId: string): boolean;
  /** Work from the other place reached `botId`'s thread `threadId`: its main chat may say so (server/host/handed-line.ts). */
  handed?(input: { botId: string; threadId: string; from: { botId: string; name: string }; text: string }): void;
  personName(threadId: string): string | undefined;
  /** "Sent to …" in the requester's conversation. */
  sentRow(input: { sender: LocalBot; threadId: string; recipient: { id: string; name: string }; workThreadId: string; nodeId: string; reason?: string; doneWhen?: string;
    /** The room the sender speaks in: the bot of the other place is not in it, so it got the work directly. */ roomId?: string }): void;
  /** The files that travel with hand-offs (server/host/handoff-files.ts). Absent: files do not cross. */
  files?: {
    /** What this assignment carries one way, in the attachment store. */
    carried(assignmentId: string, way: FileWay): readonly PassedFile[];
    /** Bytes that crossed, at these paths, into the attachment store under attach_file's own type and size rules. */
    store(files: ReadonlyArray<{ path: string; name: string }>): Promise<PassedFile[]>;
    /** Keeps them on the assignment, so they reach the receiving conversation's inbox as any passed file does. */
    crossed(assignmentId: string, way: FileWay, from: { botId: string; name: string }, files: readonly PassedFile[]): void;
  };
  /** The teammate's result in the requester's conversation. */
  resultRow(parent: HandoffView, child: HandoffView, name: string): void;
  /** The turns of a room member that lives in another place (server/host/bot-link-rooms.ts). Such a turn is a hand-off
   * like any other: sent once, queued while that place is away, stopped with the room. Absent: no room has such a member. */
  rooms?: {
    /** For a room turn, what its hand-off says, worked out as it is sent so that it holds everything said in the room up
     * to then: who asks (the room), the words, and the person. Undefined: `node` is not a room turn. */
    brief(node: HandoffView): { from: { botId: string; name: string }; text: string; person?: string } | undefined;
    /** Why a room turn that waited can no longer go (the room or the thread is gone, the bot left it), or undefined. */
    problem(node: HandoffView): string | undefined;
    /** A room turn ended: its answer is the member's line in the room. True when `child` was a room turn. */
    reply(child: HandoffView, parent: HandoffView | undefined, name: string): boolean;
    /** Whether that bot of another place is a member of this room. */
    member(groupId: string, linked: string): boolean;
    /** On the Cloud: a computer's link ended for good, because it did not connect for the link's whole term. */
    expired?(peer: string, placeName: string): void;
  };
  /** The coordinator should look again: a place came back, or went. */
  kick(): void;
  /** The other places' bots changed: one came, went or changed, or a place was linked or unlinked. */
  directoryChanged?(): void;
  /** On the Cloud: ends the session a computer's link used. */
  revoke?(sessionId: string): void;
  now?: () => number;
  log?(line: string): void;
  /** How long after the last change to this place's bots the other places are told (TELL_AFTER_MS), and the longest a
   * change waits while more keep coming (TELL_WITHIN_MS). */
  tellAfterMs?: number;
  tellWithinMs?: number;
  /** The person paused this bot, or the plan keeps it asleep: it takes no work now. */
  paused?(bot: LocalBot): boolean;
}

export interface CoordinateContext {
  sender: LocalBot;
  address: { groupId?: string; threadId: string; botId: string };
  generation: string;
  parentId?: string;
  /** The caller is not one of this place's own turns. */
  external: boolean;
  /** Why this conversation may not hand work on at all (it left its room, its task is gone), as for any hand-off. */
  problem?: string;
  handed(nodeId: string): void;
}
type Remote = { peer: string; bot: LinkedBot };
/** `level`: what that place's version reads (protocol.ts), 1 until it says more. `told`: the level its last hello was made
 * for, and `bots` the list it carried. */
type Live = { online: boolean; seq: number; outbox: Numbered[]; level: number; told?: number; bots?: string };

export type BotLink = ReturnType<typeof createBotLink>;

export function createBotLink(deps: BotLinkDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const file = join(deps.dataDir, FILE), endedFile = join(deps.dataDir, ENDED_FILE);
  let state: LinkState | null = null;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    state = parsed.success ? parsed.data : null;
  } catch { state = null; }

  const live = new Map<string, Live>();
  const outboundListeners = new Set<(peer: string) => void>();
  /** `person`: the work traces to a person's own line, so they wait on it (dial.ts may wake a sleeping Cloud for it). */
  const wantedListeners = new Set<(person: boolean) => void>();
  /** Hand-offs this side sent whose result has not come back. */
  type Pending = { peer: string; frame: HandoffFrame; files: readonly PassedFile[]; settle(result: HostTurnResult): void; threadId: string; cancelled: boolean; busy?: boolean; tries: number };
  const pending = new Map<string, Pending>();
  /** Hand-offs whose result came: the rest that end here (cut by restarts, refused, stopped) are stopped where they run. */
  const resulted = new Set<string>();
  let alive: NodeJS.Timeout | undefined;
  /** A change to this place's bots waits here to be told, since `tellingSince`. */
  let telling: NodeJS.Timeout | undefined, tellingSince = 0;
  /** Hand-offs whose files are being taken in, and results whose files are being sent: one at a time each. */
  const accepting = new Set<string>(), resultsGoing = new Set<string>();
  /** What waits to be tried again because a file could not cross yet, by what it is for. */
  const retries = new Map<string, { timer: NodeJS.Timeout; delay: number }>();
  let transfer: FileTransfer | null = null;

  const save = () => { if (state) writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 }); };
  const linkOf = (peer: string): Live => { let one = live.get(peer); if (!one) { one = { online: false, seq: 0, outbox: [], level: 1 }; live.set(peer, one); } return one; };
  const isOnline = (peer: string) => live.get(peer)?.online === true;
  /** Places asleep that this computer is waking for work a person waits on (the dialer says so; never persisted). */
  const waking = new Set<string>();
  const placeName = (peer: string) => state?.peers[peer]?.place.name ?? "the other place";
  /** A bot that moved to another place for good leaves a hidden stub here; one still moving is here and says so. */
  const movedAway = (bot: LocalBot) => (bot.movedTo as { state?: unknown } | null | undefined)?.state === "moved";
  const directory = (): LinkedBot[] => deps.bots().filter((bot) => !bot.hidden && !movedAway(bot) && /^[\w-]{1,128}$/u.test(bot.id)).map((bot) => ({
    id: bot.id, name: bot.name, ...(bot.title ? { title: bot.title.slice(0, 200) } : {}), ...(bot.description ? { description: bot.description.slice(0, 400) } : {}),
    ...(deps.model?.(bot) ? { model: deps.model(bot)!.slice(0, 200) } : {}), level: deps.level(bot),
    ...(bot.color ? { color: bot.color.slice(0, 64) } : {}), ...(bot.mascotBody ? { mascotBody: bot.mascotBody.slice(0, 64) } : {}), ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor.slice(0, 64) } : {}),
    ...(bot.mascotBodyColor ? { mascotBodyColor: bot.mascotBodyColor.slice(0, 64) } : {}), ...(bot.mascotMaterial ? { mascotMaterial: bot.mascotMaterial.slice(0, 64) } : {}),
    ...(bot.chiefOfStaff ? { chief: true } : {}), ...(bot.threadId ? { threadId: bot.threadId } : {}),
    ...(deps.paused?.(bot) || deps.refusal?.(bot) ? { paused: true } : {}),
  })).slice(0, 500);

  function send(peer: string, frame: Frame): void {
    if (!state?.peers[peer]) return;
    const one = linkOf(peer);
    one.outbox.push({ seq: ++one.seq, frame });
    for (const listener of outboundListeners) listener(peer);
  }
  /** A place on the first version takes a hello only with the fields that version knows. */
  const basic = ({ id, name, title, description, model, level }: LinkedBot): LinkedBot => ({ id, name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(model ? { model } : {}), ...(level ? { level } : {}) });
  const hello = (peer: string, bots = directory()) => {
    if (!state) return;
    const one = linkOf(peer);
    one.bots = JSON.stringify(bots);
    one.told = one.level;
    // A hello not yet taken says less than this one: only the newest goes.
    one.outbox = one.outbox.filter((entry) => entry.frame.t !== "hello");
    send(peer, { t: "hello", place: state.self, bots: one.level >= 2 ? bots : bots.map(basic) });
  };
  /** Each place that was told this place's bots and now holds another list hears the new one. A place not yet in a session
   * hears it when its session starts, and one that is away when it is back. */
  const tellBots = () => {
    telling = undefined;
    if (!state) return;
    const bots = directory(), listed = JSON.stringify(bots);
    for (const peer of Object.keys(state.peers)) { const one = live.get(peer); if (one?.bots !== undefined && one.bots !== listed) hello(peer, bots); }
  };

  const spoolRoot = join(deps.dataDir, SPOOL);
  const spoolOf = (peer: string, id: string) => join(spoolRoot, createHash("sha256").update(`${peer}\0${id}`).digest("hex").slice(0, 32));
  /** Where one crossing file's bytes wait before they are stored: named for its type, never by a path the other side chose. */
  const spoolFile = (peer: string, id: string, way: FileWay, index: number, name: string) =>
    join(spoolOf(peer, id), way, `${index}-${basename(name.replace(/\\/gu, "/")).replace(/[^\w.-]+/gu, "_").slice(-120) || "file"}`);
  const unspool = (peer: string, id: string) => { rmSync(spoolOf(peer, id), { recursive: true, force: true }); };

  /** Tries `again` later, after a wait that doubles; `settled` forgets it. */
  function retryLater(key: string, again: () => void): void {
    const delay = Math.min((retries.get(key)?.delay ?? FILE_RETRY_MS / 2) * 2, FILE_RETRY_MAX_MS);
    clearTimeout(retries.get(key)?.timer);
    const timer = setTimeout(() => { if (retries.get(key)?.timer === timer && state) again(); }, delay);
    timer.unref?.();
    retries.set(key, { timer, delay });
  }
  const settled = (key: string) => { clearTimeout(retries.get(key)?.timer); retries.delete(key); };

  /** A computer puts the files a frame names before it sends the frame, each only if the Cloud does not hold it already;
   * the Cloud sends the frame and the computer gets them. */
  async function carry(id: string, way: FileWay, files: readonly PassedFile[]): Promise<void> {
    if (!files.length || state?.role !== "dialer") return;
    if (!transfer) throw new Error("not connected");
    for (const [index, file] of files.slice(0, FILES_MAX).entries()) if (!await transfer.holds(id, way, index, file)) await transfer.push(id, way, index, file);
  }

  /** The files a frame names, in the attachment store: got from the Cloud, or already put here by the computer. */
  async function fetched(peer: string, id: string, way: FileWay, metas: readonly FileMeta[] | undefined): Promise<PassedFile[]> {
    if (!metas?.length || !deps.files) return [];
    const waiting = metas.map((meta, index) => ({ path: spoolFile(peer, id, way, index, meta.name), name: meta.name, meta }));
    if (state?.role === "dialer") {
      if (!transfer) throw new Error("not connected");
      mkdirSync(join(spoolOf(peer, id), way), { recursive: true, mode: 0o700 });
      for (const [index, file] of waiting.entries()) {
        let have = -1;
        try { have = statSync(file.path).size; } catch { /* not got yet */ }
        if (have !== file.meta.bytes) await transfer.pull(id, way, index, file.meta, file.path);
      }
    } else if (waiting.some((file) => !existsSync(file.path))) throw gone("its files did not arrive");
    let stored: PassedFile[];
    try {
      stored = await deps.files.store(waiting);
    } catch (error) {
      unspool(peer, id);
      throw gone(said(error));
    }
    unspool(peer, id);
    return stored;
  }

  /** Bytes left behind by hand-offs that never came to be stored: the old go, and the oldest go while there are too many. */
  function sweep(): void {
    let entries: Array<{ path: string; at: number; bytes: number }>;
    try {
      entries = readdirSync(spoolRoot).map((name) => {
        const path = join(spoolRoot, name);
        let at = 0, bytes = 0;
        const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else { const stat = statSync(full); bytes += stat.size; at = Math.max(at, stat.mtimeMs); } } };
        try { walk(path); if (at === 0) at = statSync(path).mtimeMs; } catch { /* going */ }
        return { path, at, bytes };
      });
    } catch { return; }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.sort((a, b) => a.at - b.at)) {
      if (now() - entry.at <= SPOOL_KEEP_MS && total <= SPOOL_MAX_BYTES) continue;
      rmSync(entry.path, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }

  function setOnline(peer: string, next: boolean): void {
    const peerState = state?.peers[peer];
    if (!peerState) return;
    if (next) waking.delete(peer);
    if (next && now() - peerState.seenAt > SEEN_WRITE_MS) { peerState.seenAt = now(); save(); }
    const one = linkOf(peer);
    if (one.online === next) return;
    one.online = next;
    deps.kick();
  }

  const remoteOf = (linked: string): Remote | undefined => {
    const address = parseLinked(linked), bot = address ? state?.peers[address.peer]?.bots.find((one) => one.id === address.botId) : undefined;
    return address && bot ? { peer: address.peer, bot } : undefined;
  };
  /** The bot of another place `raw` names: by its address here, or by a name no bot here has and only one bot elsewhere has.
   * A bot's id here, in any case, or the start of one (8+ characters), stays with the local resolver, so a bot elsewhere
   * named after it never takes that bot's work or its files. */
  function resolve(raw: string): Remote | undefined {
    const matches = candidates(raw), awake = matches.length > 1 ? matches.filter((remote) => !remote.bot.paused) : matches;
    return awake.length === 1 ? awake[0] : undefined;
  }
  /** Every bot of another place `raw` could name, by the rules of `resolve`: one is that bot, more say nothing. */
  function candidates(raw: string): Remote[] {
    if (!state) return [];
    const wanted = raw.trim(), lower = wanted.toLowerCase();
    // A bot that moved away is named by its own id still: that is the bot of the place it moved to, never its stub here.
    const stub = deps.bots().find((bot) => movedAway(bot) && bot.id.toLowerCase() === lower);
    if (stub) return Object.entries(state.peers).flatMap(([peer, known]) => known.bots.filter((bot) => bot.id === stub.id).map((bot) => ({ peer, bot })));
    const local = deps.bots().filter((bot) => !movedAway(bot));
    if (local.some((bot) => bot.id.toLowerCase() === lower)) return [];
    if (isLinkedId(wanted)) { const remote = remoteOf(wanted); return remote ? [remote] : []; }
    if (isIdStart(wanted) && local.some((bot) => bot.id.toLowerCase().startsWith(lower))) return [];
    const named = foldName(wanted);
    if (!named || local.some((bot) => !bot.hidden && foldName(bot.name) === named)) return [];
    return Object.entries(state.peers).flatMap(([peer, known]) => known.bots.filter((bot) => foldName(bot.name) === named).map((bot) => ({ peer, bot })));
  }
  /** A name more than one bot of the other places has (and no bot here): which one is meant, by its address. */
  function sharedName(raw: string): string | null {
    // A bot its place paused would refuse the work, so it is no choice to offer.
    const matches = candidates(raw).filter((remote) => !remote.bot.paused);
    if (matches.length < 2) return null;
    const listed = matches.slice(0, 12).map((remote) => `${remote.bot.name} on ${placeName(remote.peer)} (id ${linkedId(remote.peer, remote.bot.id)})`).join("; ");
    return `${matches.length} bots of the person's other places are named "${raw.trim().slice(0, 120)}", so nothing was sent: ${listed}${matches.length > 12 ? `; and ${matches.length - 12} more` : ""}. Send it again with the id of the one you mean.`;
  }

  const offlineNote = (peer: string) => waking.has(peer) ? wakingNote(peer) : `${placeName(peer)} is offline now (off, asleep or not connected), so this waits and is delivered when it is back`;
  const wakingNote = (peer: string) => `${placeName(peer)} was asleep and is waking up for this now, so this is delivered as soon as it answers`;

  function keepAlive(): void {
    if (pending.size === 0) { if (alive) { clearInterval(alive); alive = undefined; } return; }
    if (alive) return;
    alive = setInterval(() => { for (const entry of pending.values()) if (!entry.cancelled && isOnline(entry.peer)) deps.coordinator().progress(entry.threadId); }, ALIVE_EVERY_MS);
    alive.unref?.();
  }

  /** The requester's side of one hand-off: sent now and again at every new session until its result is here. */
  function runRemote(node: HandoffView, signal: AbortSignal): Promise<HostTurnResult> {
    const coordinator = deps.coordinator();
    const address = parseLinked(node.botId)!;
    const parent = node.parentId ? coordinator.node(node.parentId) : undefined;
    const sender = parent ? deps.bot(parent.botId) : undefined;
    const record = coordinator.status(node.id)?.assignment;
    const origin = record?.origin;
    const frame: HandoffFrame = {
      t: "handoff", id: node.id, to: address.botId,
      from: { botId: parent?.botId ?? "unknown", name: (sender?.name ?? "Teammate").slice(0, 120), threadId: parent?.threadId ?? node.threadId },
      thread: node.threadId, text: node.text.slice(0, BRIEF_MAX), mode: node.mode,
      origin: { kind: origin?.kind ?? "outside", ...(origin?.kind === "person" && origin.quote ? { quote: origin.quote.slice(0, 2_000) } : {}) },
      ...(parent && deps.personName(parent.threadId) ? { person: deps.personName(parent.threadId)!.slice(0, 120) } : {}),
      ...(record?.doneWhen ? { doneWhen: record.doneWhen.slice(0, 2_000) } : {}),
    };
    const room = deps.rooms?.brief(node);
    if (room) {
      frame.from = { botId: room.from.botId.slice(0, 200), name: room.from.name.trim().slice(0, 120) || "Room", threadId: frame.from.threadId };
      frame.text = room.text.slice(0, BRIEF_MAX);
      if (room.person) frame.person = room.person.slice(0, 120); else delete frame.person;
    }
    const files = deps.files?.carried(node.id, "sent") ?? [];
    if (files.length) frame.files = metaOf(files);
    return new Promise<HostTurnResult>((settle) => {
      const entry: Pending = { peer: address.peer, frame, files, settle, threadId: node.threadId, cancelled: false, tries: 0 };
      const abort = () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        send(entry.peer, { t: "cancel", id: node.id });
        settle({ ok: false, text: STOPPED });
      };
      pending.set(node.id, entry);
      keepAlive();
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      dispatch(entry);
    });
  }
  /** Sends a hand-off, its files first where a computer sends them. Files that could not go yet are tried again on a
   * timer and with the next session; ones the Cloud refuses three times end the hand-off with the reason. */
  function dispatch(entry: Pending): void {
    const id = entry.frame.id, mine = () => !entry.cancelled && pending.get(id) === entry;
    if (!mine()) return;
    if (!entry.files.length || state?.role !== "dialer") { send(entry.peer, entry.frame); return; }
    if (entry.busy) return;
    entry.busy = true;
    carry(id, "sent", entry.files).then(() => { settled(`out:${id}`); if (mine()) send(entry.peer, entry.frame); }, (error) => {
      log(`bot link: the files of ${id} did not go (${said(error)})`);
      if (!mine()) return;
      if (!isGone(error) || (entry.tries += 1) < FILE_TRIES) { retryLater(`out:${id}`, () => dispatch(entry)); return; }
      settled(`out:${id}`);
      pending.delete(id);
      resulted.add(id);
      keepAlive();
      entry.settle({ ok: false, text: `Its files could not be sent to ${placeName(entry.peer)} (${said(error)}), so the work was not started there.` });
    }).finally(() => { entry.busy = false; });
  }

  /** A kept result as the frame its requester gets: the words come from the runtime's own row of the work. */
  function resultFrame(id: string, work: Work): ResultFrame | null {
    if (!work.done) return null;
    const text = work.done.text ?? (work.child ? deps.coordinator().status(work.child)?.assignment.result : undefined) ?? (work.done.ok ? GONE : "");
    return { t: "result", id, ok: work.done.ok, text: text.slice(0, 200_000), ...(work.done.outcome ? { outcome: work.done.outcome } : {}) };
  }
  /** The files a finished assignment here returns to its requester. */
  const returned = (work: Work): readonly PassedFile[] => (work.done?.ok && work.child && work.ackedAt === undefined ? deps.files?.carried(work.child, "returned") ?? [] : []);
  /** Sends a kept result, the files it returns first where a computer sends them. */
  function dispatchResult(id: string): void {
    const work = state?.work[id], frame = work ? resultFrame(id, work) : null;
    if (!work || !frame) return;
    const files = returned(work);
    if (!files.length) { send(work.peer, frame); return; }
    const withFiles: ResultFrame = { ...frame, files: metaOf(files) };
    if (state?.role !== "dialer") { send(work.peer, withFiles); return; }
    if (resultsGoing.has(id)) return;
    resultsGoing.add(id);
    carry(id, "returned", files).then(() => { settled(`back:${id}`); send(work.peer, withFiles); }, (error) => {
      log(`bot link: the files of ${id}'s result did not go (${said(error)})`);
      if (isGone(error)) { settled(`back:${id}`); send(work.peer, { ...frame, text: `${frame.text}\n\n(The files it attached could not be sent across.)` }); }
      else retryLater(`back:${id}`, () => dispatchResult(id));
    }).finally(() => { resultsGoing.delete(id); });
  }

  /** The work ended here. `text` only when no assignment of this place holds the words. */
  function recordResult(id: string, result: { ok: boolean; outcome?: string; text?: string }, childId?: string): void {
    if (!state) return;
    const work = state.work[id];
    if (!work || work.done) return;
    if (childId) work.child = childId;
    work.done = { ok: result.ok, ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.text !== undefined ? { text: result.text.slice(0, 2_000) } : {}) };
    save();
    dispatchResult(id);
  }

  /** The working side of one hand-off. A second arrival of the same id starts nothing: it is answered from the record. */
  function accept(peer: string, frame: HandoffFrame): void {
    if (!state) return;
    const known = state.work[frame.id];
    if (known) { if (known.peer === peer && known.done) dispatchResult(frame.id); return; }
    if (!frame.files?.length || !deps.files) { start(peer, frame, []); return; }
    if (accepting.has(frame.id)) return;
    accepting.add(frame.id);
    fetched(peer, frame.id, "sent", frame.files).then((files) => { settled(`in:${frame.id}`); start(peer, frame, files); }, (error) => {
      if (!state?.peers[peer] || state.work[frame.id]) return;
      // Not got yet: tried again on a timer, and when the requester sends the hand-off again with the next session.
      if (!isGone(error)) { log(`bot link: the files of ${frame.id} are not here yet (${said(error)})`); retryLater(`in:${frame.id}`, () => accept(peer, frame)); return; }
      settled(`in:${frame.id}`);
      state.work[frame.id] = { peer, root: linkRoot(frame.id), from: frame.from.name, at: now() };
      recordResult(frame.id, { ok: false, text: `The files sent with this could not be taken in (${said(error)}), so the work was not started.`, outcome: "refused" });
    }).finally(() => { accepting.delete(frame.id); });
  }

  function start(peer: string, frame: HandoffFrame, files: readonly PassedFile[]): void {
    if (!state || state.work[frame.id]) return;
    const root = linkRoot(frame.id);
    const address = { botId: linkedId(peer, frame.from.botId), threadId: root };
    const work: Work = { peer, root, from: frame.from.name, ...(frame.person ? { person: frame.person } : {}), at: now() };
    const refuse = (text: string) => { state!.work[frame.id] = work; recordResult(frame.id, { ok: false, text, outcome: "refused" }); };
    const bot = deps.bot(frame.to);
    if (!bot || bot.hidden) return refuse("That bot is no longer here.");
    const refusal = deps.refusal?.(bot) ?? deps.acceptRefusal?.(bot);
    if (refusal) return refuse(refusal);
    const coordinator = deps.coordinator();
    try {
      coordinator.beginTurn({ id: root, address, brief: frame.text, level: deps.level(bot), opener: {
        requester: { kind: "external_runtime", runId: root, botId: address.botId, threadId: address.threadId },
        origin: { kind: frame.origin.kind, source: frame.origin.kind === "routine" ? "routine" : "peer", ref: frame.from.threadId, ...(frame.origin.quote ? { quote: frame.origin.quote } : {}) },
      } });
      const key = `${peer}:${frame.thread}`;
      let threadId = state.threads[key]?.threadId;
      if (!threadId || !deps.hasThread(bot.id, threadId)) {
        const opened = deps.openThread(bot, `@${frame.from.name} · work`, { botId: address.botId, name: frame.from.name, threadId: address.threadId }, frame.text);
        if (!opened) throw new Error("That bot is no longer here.");
        threadId = opened;
      }
      state.threads[key] = { threadId, at: now() };
      const { node } = coordinator.enqueue(address, root, undefined, { botId: bot.id, threadId }, frame.text, {
        mode: frame.mode, reply: frame.mode === "notify" ? "none" : "poll", thread: "standing", ...(frame.doneWhen ? { doneWhen: frame.doneWhen } : {}) });
      if (files.length) deps.files?.crossed(node.id, "sent", { botId: address.botId, name: frame.from.name }, files);
      work.child = node.id;
      state.work[frame.id] = work;
      // A room's turn for a member of this place is not a hand-off to the bot (its work thread is named after the room).
      // A failure there never stops the work: it is logged, and the hand-off goes on.
      if (!frame.thread.includes(":room:")) {
        try { deps.handed?.({ botId: bot.id, threadId, from: { botId: address.botId, name: frame.from.name }, text: frame.text }); }
        catch (error) { log(`bot link: the hand-off line for ${frame.id} was not written (${said(error)})`); }
      }
      save();
      coordinator.endTurn(root, { ok: true, text: "" });
      if (frame.mode === "notify") recordResult(frame.id, { ok: true, text: "" });
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      try { coordinator.endTurn(root, { ok: false, text: said }); } catch { /* the root never began */ }
      refuse(said);
    }
  }

  function take(peer: string, frame: Frame): void {
    if (!state?.peers[peer]) return;
    switch (frame.t) {
      case "hello": {
        const known = state.peers[peer]!;
        // A computer is the place it paired as: its name may change, its identity may not.
        if (frame.place.id !== known.place.id) { log("bot link: a hello from another place than the one paired was dropped"); return; }
        if (JSON.stringify([frame.place, frame.bots]) !== JSON.stringify([known.place, known.bots])) { known.place = frame.place; known.bots = frame.bots; save(); deps.kick(); deps.directoryChanged?.(); }
        return;
      }
      case "handoff": return accept(peer, frame);
      case "result": {
        const entry = pending.get(frame.id);
        if (entry && entry.peer !== peer) return;
        const finish = (note = "") => {
          settled(`got:${frame.id}`);
          send(peer, { t: "done", id: frame.id });
          unspool(peer, frame.id);
          if (!entry || pending.get(frame.id) !== entry) return;
          pending.delete(frame.id);
          resulted.add(frame.id);
          keepAlive();
          if (!entry.cancelled) entry.settle({ ok: frame.ok, text: `${frame.text || (frame.ok ? "" : "The work failed there without saying why.")}${note}` });
        };
        if (!entry || entry.cancelled || !frame.files?.length || !deps.files) return finish();
        if (entry.busy) return;
        entry.busy = true;
        // The result is acknowledged only once its files are here, so the working side keeps them until then.
        fetched(peer, frame.id, "returned", frame.files).then((files) => {
          deps.files!.crossed(frame.id, "returned", { botId: linkedId(peer, entry.frame.to), name: state?.peers[peer]?.bots.find((bot) => bot.id === entry.frame.to)?.name ?? "Teammate" }, files);
          finish();
        }, (error) => {
          if (isGone(error)) finish(`\n\n(The files it attached could not be brought across: ${said(error)}.)`);
          else { log(`bot link: the files of ${frame.id}'s result are not here yet (${said(error)})`); retryLater(`got:${frame.id}`, () => take(peer, frame)); }
        }).finally(() => { entry.busy = false; });
        return;
      }
      case "done": {
        const work = state.work[frame.id];
        if (work?.peer === peer && work.done && work.ackedAt === undefined) { work.ackedAt = now(); save(); }
        return;
      }
      case "cancel": {
        const work = state.work[frame.id];
        if (!work) { state.work[frame.id] = { peer, root: linkRoot(frame.id), from: "", at: now() }; recordResult(frame.id, { ok: false, text: STOPPED, outcome: "stopped" }); return; }
        if (work.peer !== peer) return;
        if (work.done) { dispatchResult(frame.id); return; }
        deps.coordinator().cancelDirect(work.root, `Stopped by ${work.from || "the requester"}`);
        return;
      }
      case "bye": return state.role === "acceptor" ? dropPeer(peer, `The link to ${placeName(peer)} was turned off before the work came back.`) : off(true);
    }
  }

  function prune(): void {
    if (!state) return;
    const at = now();
    let dropped = false;
    for (const [id, work] of Object.entries(state.work)) {
      if (work.done && (work.ackedAt !== undefined ? at - work.ackedAt > KEEP_ACKED_MS : at - work.at > KEEP_RESULTS_MS)) { delete state.work[id]; dropped = true; }
    }
    for (const [key, thread] of Object.entries(state.threads)) if (at - thread.at > KEEP_THREADS_MS) { delete state.threads[key]; dropped = true; }
    const oldest = <T extends { at: number }>(records: Record<string, T>, keep: (record: T) => boolean) => {
      const extra = Object.keys(records).length - RECORDS_MAX;
      if (extra <= 0) return;
      for (const [id] of Object.entries(records).filter(([, record]) => !keep(record)).sort(([, a], [, b]) => a.at - b.at).slice(0, extra)) { delete records[id]; dropped = true; }
    };
    oldest(state.work, (work) => !work.done);
    oldest(state.threads, () => false);
    if (dropped) save();
  }

  /** On the Cloud: a computer that has not asked for LINK_EXPIRES_MS is no longer linked. */
  function expire(): void {
    if (state?.role !== "acceptor") return;
    for (const [peer, known] of Object.entries(state.peers)) {
      if (isOnline(peer) || now() - known.seenAt <= LINK_EXPIRES_MS) continue;
      log(`bot link: ${known.place.name} has not connected for ${Math.round(LINK_EXPIRES_MS / DAY_MS)} days; its link ended`);
      dropPeer(peer, `${known.place.name} has not connected for ${Math.round(LINK_EXPIRES_MS / DAY_MS)} days, so the link to it ended and this was not done.`);
      deps.rooms?.expired?.(peer, known.place.name);
    }
  }

  function failPending(peer: string | null, reason: string): void {
    for (const [id, entry] of pending) {
      if (peer !== null && entry.peer !== peer) continue;
      pending.delete(id);
      resulted.add(id);
      unspool(entry.peer, id);
      if (!entry.cancelled) entry.settle({ ok: false, text: reason });
    }
    keepAlive();
  }

  /** On the Cloud: one computer's link ends. Its session is revoked and work waiting for it ends with the reason. */
  function dropPeer(peer: string, reason: string): void {
    const known = state?.peers[peer];
    if (!state || !known) return;
    delete state.peers[peer];
    live.delete(peer);
    if (known.sessionId) deps.revoke?.(known.sessionId);
    failPending(peer, reason);
    if (Object.keys(state.peers).length === 0) { off(true); return; }
    save();
    deps.directoryChanged?.();
    for (const listener of outboundListeners) listener(peer);
    deps.kick();
  }

  function readEnded(): EndedLink[] {
    try { const parsed = endedSchema.safeParse(JSON.parse(readFileSync(endedFile, "utf8"))); return parsed.success ? parsed.data.filter((one) => now() - one.at <= LINK_EXPIRES_MS) : []; } catch { return []; }
  }
  function writeEnded(ended: EndedLink[]): void {
    if (ended.length === 0) { rmSync(endedFile, { force: true }); return; }
    writeFileAtomic(endedFile, JSON.stringify(ended.slice(-10)), { mode: 0o600 });
  }

  /** The link is off here: nothing more is sent, and work waiting on another place ends with the reason. `told`: the other
   * side knows. A computer whose Cloud could not be told keeps what it takes to tell it later. */
  function off(told: boolean): void {
    if (!state) return;
    const was = state;
    state = null;
    clearTimeout(telling);
    telling = undefined;
    // The end is written down before the link's record goes, so a server stopped in between still tells its Cloud later.
    if (!told && was.role === "dialer" && was.origin && was.token) writeEnded([...readEnded().filter((one) => one.token !== was.token), { origin: was.origin, token: was.token, at: now() }]);
    try { rmSync(file, { force: true }); } catch (error) { log(`bot link: its record was not removed (${String(error)})`); }
    if (was.role === "acceptor") for (const known of Object.values(was.peers)) if (known.sessionId) deps.revoke?.(known.sessionId);
    const peers = [...live.keys()];
    live.clear();
    waking.clear();
    for (const retry of retries.values()) clearTimeout(retry.timer);
    retries.clear();
    rmSync(spoolRoot, { recursive: true, force: true });
    failPending(null, "The link between this place and the person's other place was turned off before the work came back.");
    for (const peer of peers) for (const listener of outboundListeners) listener(peer);
    deps.kick();
    deps.directoryChanged?.();
  }

  function receipt(remote: Remote, outcome: PeerDeliveryReceipt["outcome"], detail: string, more: Partial<PeerDeliveryReceipt> = {}): PeerDeliveryReceipt {
    return { botId: linkedId(remote.peer, remote.bot.id), botName: remote.bot.name, outcome, detail: detail.slice(0, 400), ...more };
  }

  /** coordinate_bots for targets that live in another place; the rest go on as they always did (`local`). */
  async function coordinate(call: CoordinateBotsCall, context: CoordinateContext, local: (call: CoordinateBotsCall) => Promise<CoordinateResult>): Promise<CoordinateResult> {
    if (!state || context.external) return local(call);
    for (const raw of call.botIds) { const shared = sharedName(raw); if (shared) return { status: 403, body: { error: shared } }; }
    const away = new Map<string, Remote>();
    for (const raw of call.botIds) { const remote = resolve(raw); if (remote) away.set(raw, remote); }
    if (away.size === 0) return local(call);
    const here = call.botIds.filter((raw) => !away.has(raw));
    const receipts: PeerDeliveryReceipt[] = [];
    const refused: string[] = [];
    const targets = [...new Map([...away.values()].map((remote) => [linkedId(remote.peer, remote.bot.id), remote])).values()];
    const mode = call.consult ? "consult" as const : call.reply === "none" ? "notify" as const : "work" as const;
    const coordinator = deps.coordinator();
    for (const remote of targets) {
      const place = placeName(remote.peer), linked = linkedId(remote.peer, remote.bot.id);
      const unsupported = unsupportedHere(call, context, place);
      if (unsupported) { refused.push(unsupported); receipts.push(receipt(remote, "failed", unsupported)); continue; }
      const threadId = `${linked}:${call.thread === "new" ? `${context.generation}:${receipts.length}` : context.address.threadId}`;
      try {
        const { node, duplicate } = coordinator.enqueue(context.address, context.generation, context.parentId, { botId: linked, threadId }, call.message, {
          mode, reply: call.reply === "none" ? "none" : "resume", thread: call.thread === "new" ? "new" : "standing", rework: call.rework, ...(call.doneWhen ? { doneWhen: call.doneWhen } : {}) });
        const returns = mode === "notify" ? "nothing comes back from it" : "its result will resume you";
        if (!duplicate && call.files?.length) deps.files?.crossed(node.id, "sent", { botId: context.sender.id, name: context.sender.name }, call.files);
        const files = call.files?.length && !deps.files ? " Its files were not sent: files do not cross to the other place here, so put what it needs in the message." : "";
        const online = isOnline(remote.peer);
        // Said first, so a computer whose Cloud sleeps has asked it to wake before the bot is told what happens next. Only
        // work a person's own line started may wake it; a routine's or a scheduled run's waits as before.
        const person = coordinator.status(node.id)?.assignment?.origin?.kind === "person";
        if (!online) for (const listener of wantedListeners) listener(person);
        const told = !online && waking.has(remote.peer) ? `Finish your turn and tell the person ${place} is waking up for it.` : `Finish your turn and tell the person it waits for ${place}.`;
        receipts.push(receipt(remote, duplicate && node.status !== "queued" ? "injected" : "queued",
          duplicate ? `already sent to ${remote.bot.name} on ${place}: it is ${node.status === "queued" ? "queued" : "under way"} and ${returns}`
            : online ? `sent to ${remote.bot.name} on ${place}; ${returns}.${files}` : `${offlineNote(remote.peer)}; ${returns} then. ${told}${files}`,
          { requestId: node.id }));
        if (!duplicate) {
          context.handed(node.id);
          deps.sentRow({ sender: context.sender, threadId: context.address.threadId, recipient: { id: linked, name: `${remote.bot.name} (${place})` }, workThreadId: threadId, nodeId: node.id, ...(context.address.groupId && !deps.rooms?.member(context.address.groupId, linked) ? { roomId: context.address.groupId } : {}),
            ...(call.reason ? { reason: call.reason } : {}), ...(call.doneWhen ? { doneWhen: call.doneWhen } : {}) });
        }
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        refused.push(said);
        receipts.push(receipt(remote, "failed", said));
      }
    }
    return withTargetsHere(call, here, { receipts, refused, message: `Handed to the person's other place. ${call.reply === "none" ? "Nothing comes back from a one-way notice." : "Finish your turn now: the result resumes you when it is back."}` }, local);
  }
  /** Why this call cannot go to another place at all, or null. */
  function unsupportedHere(call: CoordinateBotsCall, context: CoordinateContext, place: string): string | null {
    // A bot of another place is in no room here. Named from a room, it gets the work directly, in a thread of its own
    // there, and its result comes back to the room, as for any bot outside a room.
    return context.problem ? context.problem
      : call.groupId && call.groupId !== context.address.groupId ? `${place}'s bots are in no room here: hand it to the bot from your own conversation, or from the room you are speaking in`
      : call.answers || call.post || call.ownThread ? `That does not reach ${place} yet: send the bot plain work or a question instead`
      : call.consult && call.reply === "none" ? "consult asks a question whose answer comes back to you; leave reply out" : null;
  }
  /** The coordinator's host with other places' bots in it: their nodes run there, every other node as before. */
  function host(inner: CoordinatorHost): CoordinatorHost {
    const awayNode = (node: HandoffView) => isLinkedId(node.botId);
    const peerOf = (node: HandoffView) => parseLinked(node.botId)?.peer ?? "";
    const workOf = (parent: HandoffView | undefined) => (parent && awayNode(parent) ? state?.work[handoffOfRoot(parent.id)] : undefined);
    const nameOf = (linked: string) => { const remote = remoteOf(linked); return remote ? `${remote.bot.name} (${placeName(remote.peer)})` : "Teammate"; };
    return {
      ...inner,
      validate: (node, parent) => {
        if (!awayNode(node)) return inner.validate(node, parent && awayNode(parent) ? undefined : parent);
        if (!node.parentId) return undefined;
        if (!state) return "The link to the person's other place was turned off, so this was not delivered.";
        const left = deps.rooms?.problem(node);
        if (left) return left;
        return remoteOf(node.botId) ? undefined : "That bot's place is no longer linked, or the bot is no longer there.";
      },
      // A node that only stands for who asked (a room, another place's requester) has no parent and runs nothing: it is
      // never busy, so it ends as soon as the work under it has ended, whether or not any place is connected.
      busy: (node) => (awayNode(node) ? Boolean(node.parentId) && !isOnline(peerOf(node)) : inner.busy(node)),
      holdReason: (node) => (awayNode(node) ? offlineNote(peerOf(node)) : inner.holdReason?.(node) as string),
      // Work for a place that cannot be reached, waiting to go or already running there, is held by no clock.
      away: (node) => (awayNode(node) ? Boolean(state) && Boolean(node.parentId) && !isOnline(peerOf(node)) : inner.away?.(node) ?? false),
      run: (node, resumed, signal, composed) => {
        if (!awayNode(node)) return inner.run(node, resumed, signal, composed);
        if (!node.parentId) return Promise.resolve({ ok: true, text: "" });
        return runRemote(node, signal);
      },
      report: (child, parent) => {
        if (awayNode(child)) {
          // It ended here without its result (cut by restarts, refused, failed): the place that runs it is told to stop.
          if (child.parentId && !resulted.delete(child.id) && child.status !== "completed") send(peerOf(child), { t: "cancel", id: child.id });
          if (deps.rooms?.reply(child, parent, nameOf(child.botId))) return;
          if (!parent || child.mode === "notify") return;
          deps.resultRow(parent, child, nameOf(child.botId));
          return;
        }
        inner.report(child, parent);
        if (parent && awayNode(parent) && state?.work[handoffOfRoot(parent.id)]) {
          recordResult(handoffOfRoot(parent.id), { ok: child.status === "completed", ...(child.outcome ? { outcome: child.outcome } : {}) }, child.id);
        }
      },
      names: (node, parent) => {
        if (awayNode(node)) return { requester: (parent && deps.bot(parent.botId)?.name) || "Teammate", assignee: nameOf(node.botId) };
        const work = workOf(parent);
        if (!work) return inner.names(node, parent);
        const { thread: _thread, ...names } = inner.names(node);
        return { ...names, requester: `${work.from} (${placeName(work.peer)})`, ...(work.person ? { person: work.person } : {}) };
      },
      park: (node, question, restored) => { if (!awayNode(node)) inner.park(node, question, restored); },
      remind: (node, closesAt) => { if (!awayNode(node)) inner.remind?.(node, closesAt); },
      levelOf: (target, source) => (isLinkedId(target.botId) ? { level: remoteOf(target.botId)?.bot.level ?? "full" } : inner.levelOf(target, source)),
      chiefOf: (address) => (isLinkedId(address.botId) ? false : inner.chiefOf(address)),
      outward: (node) => (awayNode(node) ? [] : inner.outward?.(node) ?? []),
      shareAnswer: (first, joiner) => (awayNode(first) || awayNode(joiner) ? false : inner.shareAnswer?.(first, joiner) ?? false),
      statusReply: (requester, prompt, signal) => (isLinkedId(requester) ? Promise.resolve(undefined) : inner.statusReply?.(requester, prompt, signal) ?? Promise.resolve(undefined)),
    };
  }

  const cloudPeer = () => (state?.role === "dialer" ? Object.keys(state.peers)[0] ?? null : null);

  return {
    host, coordinate, resolve, candidates,
    on: () => state !== null,
    /** What this place is called, as the other places were told. */
    selfName: () => state?.self.name ?? "",
    placeName,
    /** This place is linked here now. */
    has: (peer: string) => Boolean(state?.peers[peer]),
    /** One place is connected, or (with no place named) any is. */
    online: (peer?: string) => (peer === undefined ? [...live.values()].some((one) => one.online) : isOnline(peer)),
    role: () => state?.role ?? null,
    /** On a computer: its one link's other end. */
    cloudPeer,
    /** For the transport: where to ask, and as whom. */
    dial: () => (state?.role === "dialer" && state.origin && state.token ? { origin: state.origin, token: state.token } : null),
    /** On the Cloud: the computer whose link this session is. */
    peerOfSession: (sessionId: string) => (state?.role === "acceptor" ? Object.entries(state.peers).find(([, known]) => known.sessionId === sessionId)?.[0] ?? null : null),
    status: () => (state ? { on: true as const, role: state.role, online: [...live.values()].some((one) => one.online), self: state.self,
      ...(state.role === "dialer" ? { origin: state.origin ?? null, account: state.account ?? null, peer: Object.values(state.peers)[0]?.place ?? null } : {}),
      peers: Object.entries(state.peers).map(([peer, known]) => ({ ...known.place, online: isOnline(peer), bots: known.bots.length })),
      bots: Object.values(state.peers).reduce((sum, known) => sum + known.bots.length, 0), waiting: pending.size }
      : (() => { const ended = [...new Set(readEnded().map((one) => one.origin))]; return { on: false as const, ...(ended.length ? { ended } : {}) }; })()),
    /** Every bot of every linked place, with its address here. `kind`: what that place is, in the words the sidebar's
     * own rows use for where a bot lives: a computer links to its Cloud, a Cloud to computers. */
    linked: () => Object.entries(state?.peers ?? {}).flatMap(([peer, known]) => known.bots.map((bot) => ({ id: linkedId(peer, bot.id), peer, place: known.place, kind: state!.role === "dialer" ? "cloud" as const : "computer" as const, online: isOnline(peer), bot }))),
    /** What a bot that named no bot here or there is told past "no such bot" while the link is on: the other places' bots
     * it can reach through the link, each by the id that reaches it. */
    reachableElsewhere(): string {
      if (!state) return "";
      const far = Object.entries(state.peers).flatMap(([peer, known]) => known.bots.filter((bot) => !bot.paused).map((bot) => ({ peer, bot })));
      const places = [...new Set(Object.keys(state.peers).map(placeName))].join(", ");
      if (!far.length) return `This place is linked to ${places}, but no bot there can be reached through the link now.`;
      const listed = far.slice(0, 12).map(({ peer, bot }) => `${bot.name} on ${placeName(peer)} (id ${linkedId(peer, bot.id)})`).join(", ");
      return `Through the link to ${places} you can also reach: ${listed}${far.length > 12 ? `, and ${far.length - 12} more` : ""}.`;
    },
    /** Other places' bots as list_bots names them. */
    agents: () => Object.entries(state?.peers ?? {}).flatMap(([peer, known]) => known.bots.map((bot) => ({ id: linkedId(peer, bot.id), name: bot.name, section: "", model: bot.model ?? "", busy: false,
      status: isOnline(peer) ? "linked" : "offline", statusText: isOnline(peer) ? `on ${known.place.name}` : waking.has(peer) ? `on ${known.place.name}, waking up now: work for it is delivered as soon as it answers` : `on ${known.place.name}, offline now: work for it waits until it is back`,
      title: bot.title || undefined, description: bot.description || undefined }))),
    /** Turned on, on a computer: it keeps the Cloud's address, its sign-in there and the account that was for. */
    turnOn(input: { self: Place; origin: string; token: string; account?: string; peer: Place }): void {
      const key = peerKey(input.peer.id);
      const kept = state?.role === "dialer" && state.origin === input.origin && state.peers[key] ? state : null;
      if (state && !kept) off(false);
      state = { v: 2, role: "dialer", self: input.self, origin: input.origin, token: input.token, ...(input.account ? { account: input.account } : {}), ...(kept?.sleeps ? { sleeps: true } : {}),
        peers: { [key]: { place: input.peer, bots: kept?.peers[key]?.bots ?? [], seenAt: now() } }, threads: kept?.threads ?? {}, work: kept?.work ?? {} };
      save();
      deps.kick();
      deps.directoryChanged?.();
    },
    /** On the Cloud: one computer is paired. The session its link used before is returned, for the caller to end; other
     * computers' links are left as they are. Null when no more computers fit. */
    pair(input: { self: Place; sessionId: string; computer: Place }): { peer: string; replaced?: string } | null {
      const key = peerKey(input.computer.id);
      const known = state?.role === "acceptor" ? state.peers[key] : undefined;
      if (!known && state?.role === "acceptor" && Object.keys(state.peers).length >= PEERS_MAX) return null;
      if (state?.role !== "acceptor") state = { v: 2, role: "acceptor", self: input.self, peers: {}, threads: {}, work: {} };
      state.self = input.self;
      state.peers[key] = { place: input.computer, bots: known?.place.id === input.computer.id ? known.bots : [], sessionId: input.sessionId, seenAt: now() };
      save();
      deps.kick();
      deps.directoryChanged?.();
      return { peer: key, ...(known?.sessionId ? { replaced: known.sessionId } : {}) };
    },
    /** On the Cloud: one computer's link ends (all of them when none is named). */
    unpair(computerId?: string): void {
      if (state?.role !== "acceptor") return;
      const reason = "The link to that computer was turned off before the work came back.";
      for (const peer of computerId === undefined ? Object.keys(state.peers) : [peerKey(computerId)]) dropPeer(peer, reason);
    },
    /** Turned off on a computer. `told`: its Cloud knows; otherwise the Cloud is told when it can next be reached. */
    turnOff(told: boolean): void { off(told); },
    ended: readEnded,
    /** These ended links' Clouds know now. */
    forgetEnded(tokens: readonly string[]): void { writeEnded(readEnded().filter((one) => !tokens.includes(one.token))); },
    /** A session with a place began: each side sends again what the other has not acknowledged. */
    sessionStarted(peer: string): void {
      if (!state?.peers[peer]) return;
      linkOf(peer).outbox = [];
      prune();
      hello(peer);
      for (const [id, entry] of pending) { if (entry.peer !== peer) continue; if (entry.cancelled) send(peer, { t: "cancel", id }); else dispatch(entry); }
      for (const [id, work] of Object.entries(state.work)) if (work.peer === peer && work.done && work.ackedAt === undefined) dispatchResult(id);
    },
    /** Housekeeping, at start and once a day: old records go, and on the Cloud a computer long gone is unlinked. */
    tidy(): void { prune(); expire(); sweep(); },
    /** This place's bots changed (one was made, renamed, hidden, moved, deleted, paused, its look, model or level changed):
     * once changes settle (or every TELL_WITHIN_MS while they do not), the other places hear the new list, and nothing when
     * what they are told did not change. */
    botsChanged(): void {
      if (!state) return;
      const at = Date.now();
      if (!telling) tellingSince = at;
      clearTimeout(telling);
      telling = setTimeout(tellBots, Math.max(0, Math.min(deps.tellAfterMs ?? TELL_AFTER_MS, tellingSince + (deps.tellWithinMs ?? TELL_WITHIN_MS) - at)));
      telling.unref?.();
    },
    setOnline,
    /** What that place's version reads, as its last exchange said. One that turns out to read more than its last hello
     * was made for is told again, in full. */
    setLevel(peer: string, level: number): void {
      if (!state?.peers[peer]) return;
      const one = linkOf(peer);
      one.level = level;
      if (one.told !== undefined && level > one.told) hello(peer);
    },
    /** A computer's way to move a file's bytes, while it has one. */
    setTransfer(next: FileTransfer | null): void { transfer = next; },
    /** On the Cloud: whether a file a computer is about to put is one it need not send: the Cloud has its bytes, or the
     * hand-off or result it belongs to is already known, finished or given up. */
    holds(peer: string, id: string, way: FileWay, index: number, name: string, bytes: number): boolean {
      if (!state?.peers[peer] || !deps.files) return true;
      if (way === "sent" ? Boolean(state.work[id]) : pending.get(id)?.peer !== peer) { unspool(peer, id); return true; }
      try { return statSync(spoolFile(peer, id, way, index, name)).size === bytes; } catch { return false; }
    },
    /** On the Cloud: where the bytes of a file a computer puts go. Null when they are not wanted. */
    incoming(peer: string, id: string, way: FileWay, index: number, name: string): string | null {
      if (!state?.peers[peer] || !deps.files || index < 0 || index >= FILES_MAX) return null;
      if (way === "sent" ? Boolean(state.work[id]) : pending.get(id)?.peer !== peer) return null;
      mkdirSync(join(spoolOf(peer, id), way), { recursive: true, mode: 0o700 });
      return spoolFile(peer, id, way, index, name);
    },
    /** On the Cloud: a file a computer gets: one a hand-off out to that computer carries, or one a result for it returns. */
    outgoingFile(peer: string, id: string, way: FileWay, index: number): PassedFile | undefined {
      if (!state?.peers[peer] || !deps.files) return undefined;
      if (way === "sent") { const entry = pending.get(id); return entry?.peer === peer ? entry.files[index] : undefined; }
      const work = state.work[id];
      return work?.peer === peer ? returned(work)[index] : undefined;
    },
    /** Frames from a place, each checked; one that does not parse is dropped. */
    receive(peer: string, frames: readonly unknown[]): void {
      for (const raw of frames) {
        const parsed = frameSchema.safeParse(raw);
        if (!parsed.success) { log("bot link: a frame that did not parse was dropped"); continue; }
        try { take(peer, parsed.data); } catch (error) { log(`bot link: ${parsed.data.t} failed (${String(error)})`); }
      }
    },
    /** What waits to go to a place, after `ack` (frames up to it were taken and are dropped), as much as one exchange carries. */
    outgoing(peer: string, ack: number): Numbered[] {
      const one = live.get(peer);
      if (!one) return [];
      one.outbox = one.outbox.filter((entry) => entry.seq > ack);
      const taken: Numbered[] = [];
      let bytes = 0;
      for (const entry of one.outbox) {
        bytes += Buffer.byteLength(JSON.stringify(entry.frame), "utf8");
        if (taken.length > 0 && (bytes > EXCHANGE_BYTES || taken.length >= 500)) break;
        taken.push(entry);
      }
      return taken;
    },
    hasOutgoing: (peer: string, ack = 0) => live.get(peer)?.outbox.some((entry) => entry.seq > ack) === true,
    onOutgoing(listener: (peer: string) => void): () => void { outboundListeners.add(listener); return () => outboundListeners.delete(listener); },
    /** Work was handed to a place that is not connected: a computer asks its Cloud for it now. */
    /** There is work for a place that is not connected, handed over outside `coordinate` (a room turn). */
    wanted(person = false): void { for (const listener of wantedListeners) listener(person); },
    onWanted(listener: (person: boolean) => void): () => void { wantedListeners.add(listener); return () => wantedListeners.delete(listener); },
    /** The dialer is waking this place, asleep, for work a person waits on (until it answers or parks again). */
    setWaking(peer: string, on: boolean): void { if (on) waking.add(peer); else waking.delete(peer); },
    sleeps: () => state?.sleeps === true,
    setSleeps(sleeps: boolean): void { if (state && state.role === "dialer" && (state.sleeps === true) !== sleeps) { state.sleeps = sleeps; save(); } },
    close(): void { if (alive) clearInterval(alive); alive = undefined; clearTimeout(telling); telling = undefined; for (const retry of retries.values()) clearTimeout(retry.timer); retries.clear(); outboundListeners.clear(); wantedListeners.clear(); },
  };
}
