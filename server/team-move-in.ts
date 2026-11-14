// A Team Cloud's side of a person moving one of their own bots in from My Cloud (electron/team-move.mjs runs it with
// the send a one-time move uses). Anyone in the team may move a bot of their own in. The move gets one sign-in of its
// own, which reaches only that bot's move routes and records and ends when the bot has arrived; from then on the bot
// is the team's and only its admins change it. Its chats arrive as the mover's own conversations (private to them alone,
// never the bot's main chat), its routines arrive switched off and are switched on at the end, and nothing
// personal comes with it: no notes about the person, no logins, apps or keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { CloudOwner } from "./cloud-owner-lines.ts";
import type { CloudTeam } from "./cloud-team.ts";
import { CHATS_BODY_MAX } from "./cloud-send-chats.ts";
import { personKey } from "./person-key.ts";
import { botProfileSettings, type RequestAuth } from "./request-auth.ts";
import type { RoutineManager } from "./routines.ts";
import { PASS, type RouteContext, type RouteHandler } from "./routes/table.ts";
import type { SessionRecord, SessionRegistry } from "./sessions.ts";

const BOT_ID = /^[\w-]{8,128}$/u;
const KIND_BODY_MAX = 8 * 1024 * 1024;

interface MoveIn {
  person: string;
  email: string;
  /** The mover's name, as their lines read and as a bot of the same name is told apart: "Ada". */
  who: string;
  /** The name it arrives under: its own, or "Scout (Ada)" beside a bot of that name. */
  name: string;
  /** Its main chat where it comes from, which arrives as one of the mover's conversations. */
  threadId: string | null;
  state: "moving" | "done";
  at: number;
  doneAt?: number;
}

const moveInSchema = z.object({
  person: z.string().regex(/^p_[\w-]{22}$/u), email: z.string().max(320), who: z.string().min(1).max(40), name: z.string().min(1).max(120), threadId: z.string().regex(/^[\w-]{1,200}$/u).nullable(),
  state: z.enum(["moving", "done"]), at: z.number().finite(), doneAt: z.number().finite().optional(),
});
const fileSchema = z.object({ v: z.literal(1), bots: z.record(z.string().regex(BOT_ID), moveInSchema) });
const beginSchema = z.object({
  v: z.literal(1),
  bot: z.object({ id: z.string().regex(BOT_ID), name: z.string().trim().min(1).max(80), threadId: z.string().regex(/^[\w-]{1,200}$/u).optional() }),
  label: z.string().max(80).optional(),
});
const doneSchema = z.object({ v: z.literal(1), on: z.array(z.string().max(200)).max(500) });

/** A move-in sign-in's own routes, by method and path; `B` stands for the bot it moves in. Everything else is refused. */
const ALLOWED: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/auth\/session$/u },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/u },
  { methods: ["GET"], path: /^\/api\/cloud-send$/u },
  { methods: ["GET"], path: /^\/api\/cloud-send\/manifest$/u },
  { methods: ["GET", "POST"], path: /^\/api\/cloud-send\/files$/u },
  { methods: ["PUT"], path: /^\/api\/cloud-send\/kind$/u },
  { methods: ["GET", "POST"], path: /^\/api\/cloud-send\/chats$/u },
  { methods: ["POST"], path: /^\/api\/cloud-send\/chats\/(?:attachments|settings|owner|verify)$/u },
  { methods: ["POST"], path: /^\/api\/cloud-send\/chats\/attachment\/[A-Za-z0-9-]{1,80}\.[A-Za-z0-9]{1,10}$/u },
  { methods: ["POST"], path: /^\/api\/attachments$/u },
  { methods: ["POST"], path: /^\/api\/bots$/u },
  { methods: ["PATCH"], path: /^\/api\/bots\/(?<bot>[\w-]+)$/u },
  { methods: ["POST"], path: /^\/api\/bots\/(?<bot>[\w-]+)\/skill-template$/u },
  { methods: ["GET"], path: /^\/api\/bots\/(?<bot>[\w-]+)\/skills$/u },
  { methods: ["GET", "PATCH", "DELETE"], path: /^\/api\/bots\/(?<bot>[\w-]+)\/skills\/[a-z0-9-]{1,64}$/u },
  { methods: ["POST"], path: /^\/api\/team-move-in\/(?<bot>[\w-]+)\/done$/u },
];

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
/** A person's name as it goes in a bot's name: "Ada", or their address's first part. */
function personLabel(label: string | undefined, email: string): string {
  const named = (label ?? "").replace(/[^\p{L}\p{N} .'-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40);
  return named || email.split("@")[0]!.slice(0, 40) || "you";
}

/** The bot a request's sign-in moves in; null for every other sign-in. */
export function moveInBot(auth: RequestAuth): string | null {
  return auth.kind === "session" && typeof auth.session.moveIn === "string" ? auth.session.moveIn : null;
}

/** Why a move-in sign-in may not make this request; null when it may. Its own bot's routes only, and its files only
 * by the bot's own folders. */
export function moveInRefusal(session: Pick<SessionRecord, "moveIn">, method: string, path: string, url: URL): string | null {
  const bot = session.moveIn;
  if (!bot) return null;
  const upper = method.toUpperCase();
  const rule = ALLOWED.find((entry) => entry.methods.includes(upper) && entry.path.test(path));
  const refused = "This sign-in only moves one bot in.";
  if (!rule) return refused;
  const named = rule.path.exec(path)?.groups?.bot;
  if (named !== undefined && named !== bot) return refused;
  if (path === "/api/cloud-send/files") {
    if (upper === "GET" && url.searchParams.has("path")) return refused;
    const target = url.searchParams.get("path");
    if (upper === "POST" && !(target?.startsWith(`workspaces/${bot}/`) || target?.startsWith(`task-workspaces/${bot}/`))) return refused;
  }
  return null;
}

export interface TeamMoveInDeps {
  team: CloudTeam;
  dataDir: string;
  sessions: Pick<SessionRegistry, "issueMoveIn" | "revokeMoveIns">;
  store: {
    bots: ReadonlyArray<{ id: string; name: string }>;
    bot(id: string): { id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string }> } | null | undefined;
    botByThread(threadId: string): { id: string } | null | undefined;
    groupByThread(threadId: string): { id: string } | null | undefined;
  };
  routines(): Pick<RoutineManager, "listRoutines" | "update"> | null;
  library(): Record<string, unknown>;
  starters: { get(threadId: string): string | undefined; set(threadId: string, person: string | undefined): void };
  now?: () => number;
}

export function createTeamMoveIn(deps: TeamMoveInDeps) {
  const file = join(deps.dataDir, "team-move-ins.json");
  const now = deps.now ?? Date.now;
  const read = (): Record<string, MoveIn> => {
    try { const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))); return parsed.success ? parsed.data.bots : {}; } catch { return {}; }
  };
  let moves = read();
  const save = () => writeFileAtomic(file, `${JSON.stringify({ v: 1, bots: moves })}\n`, { mode: 0o600 });
  const moving = (auth: RequestAuth): { bot: string; move: MoveIn } | null => {
    const bot = moveInBot(auth);
    const move = bot ? moves[bot] : undefined;
    return bot && move?.state === "moving" && auth.kind === "session" && personKey(auth.session) === move.person ? { bot, move } : null;
  };
  /** A conversation a move-in may write to: one not here yet, or one of the mover's own with this bot. */
  const ownThread = (bot: string, move: MoveIn, threadId: string) => {
    if (deps.store.groupByThread(threadId)) return false;
    const owner = deps.store.botByThread(threadId);
    return !owner || (owner.id === bot && deps.starters.get(threadId) === move.person);
  };

  /** A move-in's request body, checked against its one bot; a sentence when it reaches anything else. */
  function checked(path: string, method: string, body: unknown, bot: string, move: MoveIn): unknown | string {
    const refused = `This sign-in only moves ${move.name} into ${deps.team.name}.`;
    if (!record(body)) return body;
    if (path === "/api/bots" && method === "POST") {
      if (body.id !== bot) return refused;
      const reportsTo = typeof body.reportsTo === "string" && same(body.reportsTo, move.email) ? body.reportsTo : undefined;
      return { ...botProfileSettings(body), id: bot, name: move.name, useDefaults: false,
        ...(record(body.settings) ? { settings: botProfileSettings(body.settings) } : {}), ...(reportsTo ? { reportsTo } : {}) };
    }
    if (path === `/api/bots/${bot}` && method === "PATCH") {
      const kept = botProfileSettings(body);
      if (typeof kept.name === "string") kept.name = move.name;
      return kept;
    }
    if (path === "/api/cloud-send/kind") {
      const key = typeof body.key === "string" ? body.key : "";
      if (key === `bot:${bot}`) return record(body.record) ? { ...body, record: botProfileSettings(body.record) } : body;
      const routine = /^routine:([\w-]{1,128})$/u.exec(key);
      if (routine && record(body.record) && body.record.botId === bot && body.record.target === "bot") {
        const elsewhere = deps.routines()?.listRoutines().find((held) => held.id === routine[1] && held.botId !== bot);
        if (elsewhere) return refused;
        const own = body.record;
        // A routine reports into a conversation of the mover's that came with it, never into the team's main chat.
        const reports = typeof own.resultsThreadId === "string" && deps.store.botByThread(own.resultsThreadId)?.id === bot && deps.starters.get(own.resultsThreadId) === move.person;
        return !reports && move.threadId ? { ...body, record: { ...own, resultsThreadId: move.threadId } } : body;
      }
      const skill = /^library-skill:([a-z0-9-]{1,64})$/u.exec(key);
      if (skill && !Object.hasOwn(deps.library(), skill[1]!)) return body;
      return refused;
    }
    if (path === "/api/cloud-send/chats") {
      const conversations = Array.isArray(body.conversations) ? body.conversations : [];
      if (conversations.some((entry) => !record(entry) || entry.bot !== bot || entry.room !== undefined || typeof entry.threadId !== "string" || !ownThread(bot, move, entry.threadId))) return refused;
      // Each is the mover's own conversation from the moment it arrives, and the lines its owner wrote on My Cloud are theirs.
      for (const entry of conversations) deps.starters.set((entry as { threadId: string }).threadId, move.person);
      const from = typeof body.owner === "string" ? body.owner : null;
      const theirs = (row: unknown) => {
        if (!from || !record(row)) return row;
        const sender = record(row.sender) && row.sender.id === from ? { ...row.sender, id: move.person, name: move.who } : row.sender;
        const card = record(row.card) && record(row.card.answeredBy) && row.card.answeredBy.person === from
          ? { ...row.card, answeredBy: { ...row.card.answeredBy, person: move.person, name: move.who } } : row.card;
        return sender === row.sender && card === row.card ? row : { ...row, ...(sender ? { sender } : {}), ...(card ? { card } : {}) };
      };
      const { owner: _owner, ...rest } = body;
      return { ...rest, conversations: conversations.map((entry) => {
        const conversation = entry as Record<string, unknown>;
        const rows = (Array.isArray(conversation.rows) ? conversation.rows : []).map(theirs);
        if (conversation.task) return { ...conversation, rows };
        const first = record(rows[0]) && typeof rows[0].at === "number" ? rows[0].at : now();
        return { ...conversation, rows, task: { threadId: conversation.threadId, title: move.name, createdAt: first } };
      }) };
    }
    if (["/api/cloud-send/chats/settings", "/api/cloud-send/chats/owner", "/api/cloud-send/chats/verify"].includes(path)) {
      const conversations = Array.isArray(body.conversations) ? body.conversations : [];
      return conversations.every((entry) => record(entry) && typeof entry.threadId === "string" && ownThread(bot, move, entry.threadId)) ? body : refused;
    }
    return body;
  }

  /** The body limit each checked route reads with: the handler's own. */
  const LIMITS: Record<string, number> = { "/api/cloud-send/kind": KIND_BODY_MAX, "/api/cloud-send/chats": CHATS_BODY_MAX };
  const checks = (method: string, path: string, bot: string) => (method === "POST" && path === "/api/bots") || (method === "PATCH" && path === `/api/bots/${bot}`)
    || (method === "PUT" && path === "/api/cloud-send/kind") || (method === "POST" && /^\/api\/cloud-send\/chats(?:\/(?:settings|owner|verify))?$/u.test(path));

  /** Runs before every route on a Team Cloud: a move-in's body is read once, checked, and handed on as checked. */
  const guard: RouteHandler = async (ctx: RouteContext) => {
    const bot = moveInBot(ctx.auth);
    if (!bot) return PASS;
    const live = moving(ctx.auth);
    if (!live) { ctx.req.resume(); ctx.json(ctx.res, 403, { error: `This bot is already in ${deps.team.name}.` }); return; }
    if (!checks(ctx.method, ctx.path, bot)) return PASS;
    const body = await ctx.readBody(ctx.req, LIMITS[ctx.path] ?? 2 * 1024 * 1024);
    const next = checked(ctx.path, ctx.method, body, bot, live.move);
    if (typeof next === "string") { ctx.json(ctx.res, 403, { error: next }); return; }
    ctx.readBody = (async () => next) as RouteContext["readBody"];
    return PASS;
  };

  const routes: RouteHandler = async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/team-move-in" && method === "POST") {
      if (auth.kind !== "session" || auth.session.membershipAuthority !== "team" || !auth.session.email || !auth.session.teamRole || auth.session.moveIn) {
        req.resume();
        return json(res, 403, { error: `Only someone in ${deps.team.name} can move a bot in.` });
      }
      const parsed = beginSchema.safeParse(await readBody(req, 64 * 1024));
      if (!parsed.success) return json(res, 400, { error: "send { v: 1, bot: { id, name, threadId }, label }" });
      const { bot, label } = parsed.data;
      const person = personKey(auth.session);
      const held = moves[bot.id];
      if (held && held.person !== person) return json(res, 409, { error: `Someone else is moving this bot into ${deps.team.name}.` });
      if (held?.state === "done") return json(res, 200, { v: 1, done: true, name: held.name });
      if (!held && deps.store.bot(bot.id)) return json(res, 409, { error: `${deps.team.name} already has this bot.` });
      if (!held) {
        const who = personLabel(label, auth.session.email);
        const taken = deps.store.bots.some((other) => other.id !== bot.id && same(other.name, bot.name));
        moves[bot.id] = { person, email: auth.session.email, who, name: taken ? `${bot.name} (${who})`.slice(0, 80) : bot.name,
          threadId: bot.threadId ?? null, state: "moving", at: now() };
        save();
      }
      const issued = deps.sessions.issueMoveIn({ label: `Move to ${deps.team.name}`, email: auth.session.email, teamRole: auth.session.teamRole, bot: bot.id });
      return json(res, 200, { v: 1, token: issued.token, name: moves[bot.id]!.name });
    }
    const done = /^\/api\/team-move-in\/([\w-]+)\/done$/u.exec(path);
    if (done && method === "POST") {
      const bot = done[1]!;
      const live = moving(auth);
      if (!live || live.bot !== bot) { req.resume(); return json(res, 403, { error: "This sign-in only moves one bot in." }); }
      const parsed = doneSchema.safeParse(await readBody(req, 64 * 1024));
      if (!parsed.success) return json(res, 400, { error: "send { v: 1, on: [keys] }" });
      const routines = deps.routines();
      let switched = 0;
      for (const key of parsed.data.on) {
        const id = /^routine:([\w-]{1,128})$/u.exec(key)?.[1];
        const routine = id ? routines?.listRoutines().find((held) => held.id === id && held.botId === bot) : undefined;
        if (!routine || routine.enabled) continue;
        if (routines!.update(routine.id, { enabled: true })) switched++;
      }
      moves[bot] = { ...live.move, state: "done", doneAt: now() };
      save();
      deps.sessions.revokeMoveIns(bot);
      return json(res, 200, { v: 1, switched });
    }
    return PASS;
  };

  return {
    guard,
    routes,
    /** The mover, as the lines and routines that arrive name them. */
    owner(auth: RequestAuth): CloudOwner | null {
      const live = moving(auth);
      return live ? { person: live.move.person, name: live.move.who } : null;
    },
    /** What a move-in's reads are kept to: its one bot. */
    scope: (auth: RequestAuth): string | null => moving(auth)?.bot ?? null,
    /** The move-ins as kept: for tests and the operator. */
    list: () => ({ ...moves }),
    reload: () => { moves = read(); },
  };
}

export type TeamMoveIn = ReturnType<typeof createTeamMoveIn>;
