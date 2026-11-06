// Security invariant: a phone's move writes only to bots a phone made here under a grant, and each stays open to a
// phone's move until `arrived` names it or for 24 hours, whichever comes first; after that it is the computer's own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { CloudOwner } from "./cloud-owner-lines.ts";
import { ARRIVED_BODY_MAX } from "./cloud-send-arrived.ts";
import { CHATS_BODY_MAX, VERIFY_BODY_MAX } from "./cloud-send-chats.ts";
import { REPEATED_QUERY, repeatsQueryKey } from "./cloud-send-files.ts";
import { KIND_BODY_MAX } from "./cloud-send-kinds.ts";
import { MEMORY_BODY_MAX } from "./cloud-send-memory.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RoutineManager } from "./routines.ts";
import { idsHere, keptBotIds } from "./routes/bots-create.ts";
import { PASS, type RouteContext, type RouteHandler } from "./routes/table.ts";
import type { Store } from "./store.ts";

export const PHONE_MOVE_REFUSAL = "This move only brings in the bots your phone asked to move.";
const OPEN_MS = 24 * 60 * 60 * 1000;
const fileSchema = z.object({ v: z.literal(1), bots: z.record(z.string(), z.number().finite()) });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** Security invariant: no file a phone moves configures an engine or git in a bot's folders, at any depth. Each of these
 * declares settings, hooks, plugins or MCP servers that the engine (or git, which the engines run there) acts on as this
 * computer's owner with no card. Instructions (AGENTS.md, CLAUDE.md) move as notes do. */
const ENGINE_CONFIG = new Set([".mcp.json", "opencode.json", "opencode.jsonc", ".opencode", ".claude", ".agents", ".codex", ".gemini", ".qwen", ".grok",
  ".cursor", ".github", ".copilot", ".factory", ".kimi", ".kimi-code", ".cline", ".clinerules", ".pi", ".dsh", ".git"]);
// APFS (macOS 27, checked) and NTFS match names ignoring case, and APFS also matches "ſ" to "s".
const configuresEngine = (path: string) => path.split("/").some((part) => ENGINE_CONFIG.has(part.normalize("NFKC").toLowerCase()));

/** The routes whose JSON body a phone's move is checked by, each read at its handler's own limit. */
export const MOVE_BODY_LIMITS = {
  "POST /api/bots": undefined,
  "PUT /api/cloud-send/kind": KIND_BODY_MAX,
  "POST /api/cloud-send/chats": CHATS_BODY_MAX,
  "POST /api/cloud-send/chats/verify": VERIFY_BODY_MAX,
  "POST /api/cloud-send/memory": MEMORY_BODY_MAX,
  "POST /api/cloud-send/arrived": ARRIVED_BODY_MAX,
} as const;
type BodyRoute = keyof typeof MOVE_BODY_LIMITS;

export interface PhoneMoveInDeps {
  dataDir: string;
  store: Pick<Store, "bots" | "groups" | "botByThread" | "groupByThread">;
  routines(): Pick<RoutineManager, "listRoutines"> | null;
  ownerName(): string;
  now?: () => number;
}

export function createPhoneMoveIn(deps: PhoneMoveInDeps) {
  const file = join(deps.dataDir, "phone-move-ins.json");
  const now = deps.now ?? Date.now;
  const opened = new Map<string, number>();
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) for (const [id, at] of Object.entries(parsed.data.bots)) opened.set(id, at);
  } catch { /* none yet */ }
  const save = () => {
    for (const [id, at] of opened) if (now() - at >= OPEN_MS) opened.delete(id);
    writeFileAtomic(file, `${JSON.stringify({ v: 1, bots: Object.fromEntries(opened) })}\n`, { mode: 0o600 });
  };
  const open = (bot: unknown): boolean => {
    const at = typeof bot === "string" ? opened.get(bot) : undefined;
    return at !== undefined && now() - at < OPEN_MS;
  };
  /** A conversation a phone's move may write to or check: one not here yet in any case, or one of a bot still open to the move. */
  const thread = (threadId: unknown, used: Set<string>, bot?: string): boolean => {
    if (typeof threadId !== "string" || deps.store.groupByThread(threadId)) return false;
    const held = deps.store.botByThread(threadId)?.id;
    if (held === undefined) return !used.has(threadId.toLowerCase());
    return bot === undefined ? open(held) : held === bot;
  };
  const conversations = (body: Record<string, unknown>) => (Array.isArray(body.conversations) ? body.conversations : []) as unknown[];

  function kind(body: Record<string, unknown>): Record<string, unknown> | null {
    const key = typeof body.key === "string" ? body.key : "";
    const bot = /^bot:([\w-]{1,128})$/u.exec(key)?.[1];
    if (bot) {
      if (!open(bot)) return null;
      if (!record(body.record)) return { ...body, mainIfUnused: true };
      const { installedPackage: _package, ...fields } = body.record;
      return { ...body, record: fields, mainIfUnused: true };
    }
    const routine = /^routine:([\w-]{1,128})$/u.exec(key)?.[1];
    const held = record(body.record) ? body.record : null;
    // The routine's own id is the one that arrives, whatever the key says.
    if (!routine || !held || (held.id !== undefined && held.id !== routine) || !open(held.botId) || held.target !== "bot") return null;
    if ((Array.isArray(body.runs) ? body.runs : []).some((run) => !record(run) || run.botId !== held.botId || (run.threadId !== undefined && (typeof run.threadId !== "string" || deps.store.botByThread(run.threadId)?.id !== held.botId)))) return null;
    if (held.resultsThreadId !== undefined && (typeof held.resultsThreadId !== "string" || deps.store.botByThread(held.resultsThreadId)?.id !== held.botId)) return null;
    if (deps.routines()?.listRoutines().some((other) => other.id === routine && other.botId !== held.botId)) return null;
    return { ...body, mainIfUnused: true };
  }

  /** Each body route's check: the body to hand on, or null to refuse. */
  const CHECKS: Record<BodyRoute, (body: Record<string, unknown>) => Record<string, unknown> | null> = {
    "POST /api/bots": (body) => {
      const kept = keptBotIds(body, deps.store);
      // Recorded before the bot is made: a create cut short here still lets the phone go on with it.
      if (!("error" in kept) && kept.id) { opened.set(kept.id, now()); save(); }
      return body;
    },
    "PUT /api/cloud-send/kind": kind,
    "POST /api/cloud-send/chats": (body) => {
      const used = idsHere(deps.store);
      return conversations(body).every((entry) => record(entry) && open(entry.bot) && entry.room === undefined && thread(entry.threadId, used, entry.bot as string)) ? body : null;
    },
    "POST /api/cloud-send/chats/verify": (body) => {
      const used = idsHere(deps.store);
      return conversations(body).every((entry) => record(entry) && thread(entry.threadId, used)) ? body : null;
    },
    "POST /api/cloud-send/memory": (body) => open(body.bot) && !Object.hasOwn(body, "about") && !Object.hasOwn(body, "teams") ? body : null,
    "POST /api/cloud-send/arrived": (body) => {
      const done = (Array.isArray(body.bots) ? body.bots : []).filter((id): id is string => typeof id === "string" && opened.has(id));
      for (const id of done) opened.delete(id);
      if (done.length) save();
      // A phone brings no webhooks, and no line a phone words is posted into a computer bot's chat.
      const { place: _place, ...rest } = body;
      return { ...rest, webhooks: [] };
    },
  };

  /** The phone's device id when this request is its move under a live grant; null for any other request. */
  const moving = (auth: RequestAuth): string | null =>
    auth.kind === "loopback" && auth.companionMove === true && auth.companionDevice ? auth.companionDevice : null;

  /** Runs before every route: a move's request reaches only bots still open to a phone's move. A move-marked request
   * that names no such bot and that a paired phone may make anyway (a PATCH, a new bot) goes on as that request. */
  const guard: RouteHandler = async (ctx: RouteContext) => {
    if (!moving(ctx.auth)) return PASS;
    if (repeatsQueryKey(ctx.url)) { ctx.req.resume(); ctx.json(ctx.res, 400, REPEATED_QUERY); return; }
    const refuse = () => { ctx.json(ctx.res, 403, { error: PHONE_MOVE_REFUSAL }); };
    const files = ctx.path === "/api/cloud-send/files";
    const path = files ? ctx.url.searchParams.get("path") ?? "" : "";
    const named = files ? /^(?:task-)?workspaces\/([\w-]+)\//u.exec(path)?.[1]
      : /^\/api\/bots\/([\w-]+)\/(?:skills|skill-template)$/u.exec(ctx.path)?.[1];
    if (files || named !== undefined) {
      if (open(named) && !configuresEngine(path)) return PASS;
      ctx.req.resume();
      return refuse();
    }
    const route = `${ctx.method} ${ctx.path}`;
    if (!Object.hasOwn(MOVE_BODY_LIMITS, route)) return PASS;
    const body = await ctx.readBody(ctx.req, MOVE_BODY_LIMITS[route as BodyRoute]);
    const next = record(body) ? CHECKS[route as BodyRoute](body) : null;
    if (next === null) return refuse();
    ctx.readBody = (async () => next) as RouteContext["readBody"];
    return PASS;
  };

  return {
    moving,
    brings: (auth: RequestAuth, botId: string): boolean => moving(auth) !== null && open(botId),
    /** { person: "", name: ownerName() } while moving: the computer's owner, whose lines here name nobody. */
    owner: (auth: RequestAuth): CloudOwner | null => (moving(auth) ? { person: "", name: deps.ownerName() } : null),
    guard,
  };
}
