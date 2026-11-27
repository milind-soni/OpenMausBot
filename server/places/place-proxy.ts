// A My Cloud bot opened in place on this computer's page. The page talks only to this computer's own server, as for any
// bot: what it asks of a bot whose id carries My Cloud's key (shared/place-ids.ts) is forwarded here to My Cloud, as the
// person, with the owner session the desktop app opened there for this purpose. The page never learns My Cloud's address
// or that session: main hands both to this server over its private port (no HTTP route sets them), they live in this
// process's memory only, and every answer is rebuilt here from My Cloud's body with its ids in this page's names.
//
// Only what a conversation needs goes through (ROUTES): reading it and its other conversations, its live turns, sending,
// stopping, editing and reacting, answering its cards and approvals, the conversation's own settings, marking it read
// and its files. Anything else asked of such a bot is refused plainly
// with the words to open My Cloud's own page, which the bot's row offers.
//
// Who may ask: only the app's own window, by the desktop capability Chromium adds to its requests below JavaScript, from
// this server's own page (the same proof request-auth.ts asks of a change). A shell, a phone, a remote session, a bot's
// browser or another site never reaches My Cloud through here, reads included.
import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

import { intoPlace, isPlaceId, outOfPlace, ownId, PLACE_FILE_PREFIX, PLACE_KEY } from "../../shared/place-ids.ts";
import { fromOwnPage } from "../request-auth.ts";
import { userError, type UserErrorKey } from "../user-errors.ts";
import { PASS, type RouteContext, type RouteHandler } from "../routes/table.ts";

/** The live stream of the one bot open in place: `?bot=<cloud:id>`, and `since` (or Last-Event-ID) to resume. */
export const PLACE_EVENTS_PATH = `/api/places/${PLACE_KEY}/events`;
const OWNER_HEADER = "x-openmausbot-desktop-owner";
const CLOUD_POWER_HEADER = "x-omb-cloud-power";
const BACKGROUND_HEADER = "x-omb-background";
const SESSION_TOKEN = /^omb_sess_[\w-]{8,256}$/;
const OWN_ID = /^[\w-]{1,128}$/;
/** How long one forwarded request may take: a send on a Cloud that has to start first takes about 20 s. */
const REQUEST_MS = 90_000;
/** How long a file's bytes may stall once they started coming: a big download runs as long as it keeps moving. */
const IDLE_MS = 60_000;
/** My Cloud's routes that answer with a file's bytes (or a link or a list for one): never rewritten, always served as
 * bytes this origin never runs. Everything else forwarded is the app's own JSON, rewritten into this page's ids. */
const BYTE_ROUTE = /^\/api\/(?:threads\/[\w-]+\/messages\/[\w-]+\/(?:file|image)|attachments\/[\w-][\w.-]*)$/;
/** Headers of My Cloud's file answers that the page reads: a folder's list, a link a player can play, a kept original. */
const PAGE_FILE_HEADERS = ["x-openmausbot-folder", "x-openmausbot-media", "x-openmausbot-kept-original"];
const BODY_MAX = 4_000_000;
/** The most file names kept to send back a message that names one. */
const FILES_KEPT = 5_000;

/** My Cloud's own routes, in its own ids, that a conversation opened in place uses. */
const ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/bots\/[\w-]+$/],
  ["POST", /^\/api\/bots\/[\w-]+\/tasks$/],
  ["POST", /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/],
  // The conversation's own settings: its title, a pinned message, Work until done, how it asks before acting; and
  // archiving it. The bot's settings stay on its own page.
  ["PATCH", /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/],
  ["DELETE", /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/],
  ["POST", /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+\/title$/],
  ["POST", /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+\/forks$/],
  ["POST", /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/],
  ["POST", /^\/api\/bots\/[\w-]+\/active-branch$/],
  ["POST", /^\/api\/bots\/[\w-]+\/always-allow$/],
  ["POST", /^\/api\/bots\/[\w-]+\/messages$/],
  ["POST", /^\/api\/bots\/[\w-]+\/read$/],
  ["POST", /^\/api\/bots\/[\w-]+\/interrupt$/],
  ["DELETE", /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/],
  ["POST", /^\/api\/bots\/[\w-]+\/queue\/[\w-]+\/steer$/],
  ["POST", /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/],
  ["POST", /^\/api\/threads\/[\w-]+\/respond$/],
  ["POST", /^\/api\/threads\/[\w-]+\/undo$/],
  ["POST", /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/],
  ["GET", /^\/api\/threads\/[\w-]+\/job$/],
  ["POST", /^\/api\/threads\/[\w-]+\/job\/[\w-]+\/stop$/],
  ["GET", /^\/api\/threads\/[\w-]+\/messages$/],
  ["GET", /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/(?:image|file|tool)$/],
  // A file a message names: its bytes, a folder's list, or a link a <video> or <audio> element can play (`?media=`).
  ["POST", /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/],
  ["GET", /^\/api\/attachments\/[\w-][\w.-]*$/],
];

/** The frames of My Cloud's stream that are about one bot's conversations. Anything else (its other bots, its rooms,
 * routines, settings, notifications, queues) is never this page's to apply. */
const BOT_FRAMES = new Set(["message", "message.patch", "thread"]);

export interface PlaceSession { origin: string; token: string }

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const decoded = (segment: string): string => { try { return decodeURIComponent(segment); } catch { return segment; } };

/** One segment of a path forwarded to My Cloud, decoded: a name of letters, digits, `_`, `-` and dots that never starts
 * with a dot, so never `.`, `..`, empty, or anything holding a slash, a backslash or a percent sign. */
const SEGMENT = /^[\w-][\w.-]*$/;

/** The request names My Cloud's bot, conversation or file in its path: the path in My Cloud's own ids, else null. A path
 * that names one but holds any other segment (`.`, `..`, an encoded slash) is answered here, never forwarded: "" stands
 * for "placed, and refused". */
export function placedPath(path: string): string | null {
  const parts = path.split("/");
  if (parts[1] !== "api") return null;
  if (parts[2] === "attachments" && parts.length >= 4) {
    const name = decoded(parts[3]!);
    if (!name.startsWith(PLACE_FILE_PREFIX)) return null;
    const own = name.slice(PLACE_FILE_PREFIX.length);
    return parts.length === 4 && SEGMENT.test(own) ? `/api/attachments/${own}` : "";
  }
  if ((parts[2] !== "bots" && parts[2] !== "threads") || parts.length < 4) return null;
  const id = decoded(parts[3]!);
  if (!isPlaceId(id)) return null;
  const own = ownId(id);
  const rest = parts.slice(4).map((part) => { const value = decoded(part); return isPlaceId(value) ? ownId(value) : value; });
  return OWN_ID.test(own) && rest.every((part) => SEGMENT.test(part)) ? ["", "api", parts[2], own, ...rest].join("/") : "";
}

const allowed = (method: string, path: string): boolean => ROUTES.some(([verb, pattern]) => verb === method && pattern.test(path));

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A message main sends this server over its private port: My Cloud's address and the owner session for it, or none. */
export function parsePlaceSession(message: unknown): PlaceSession | null | undefined {
  if (!record(message) || message.type !== "openmausbot:place-session" || message.place !== PLACE_KEY) return undefined;
  if (message.token === null) return null;
  if (typeof message.origin !== "string" || typeof message.token !== "string" || !SESSION_TOKEN.test(message.token)) return undefined;
  let origin: URL;
  try { origin = new URL(message.origin); } catch { return undefined; }
  if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.origin !== message.origin) return undefined;
  return { origin: origin.origin, token: message.token };
}

/** The one My Cloud stream frame, if this page applies it for the bot `own` (My Cloud's id), with the conversations it
 * learned from it. */
export function frameForBot(frame: unknown, own: string, threads: Set<string>): unknown | null {
  if (!record(frame) || typeof frame.kind !== "string") return null;
  switch (frame.kind) {
    case "hello": case "ping": case "power": return frame;
    case "bot": {
      const bot = frame.bot;
      if (!record(bot) || bot.id !== own) return null;
      learnThreads(bot, threads);
      return frame;
    }
    case "bot.deleted": return frame.botId === own ? frame : null;
    case "runtime": return record(frame.event) && typeof frame.event.threadId === "string" && threads.has(frame.event.threadId) ? frame : null;
    default: return BOT_FRAMES.has(frame.kind) && typeof frame.threadId === "string" && threads.has(frame.threadId) ? frame : null;
  }
}

function learnThreads(bot: Record<string, unknown>, threads: Set<string>): void {
  if (typeof bot.threadId === "string") threads.add(bot.threadId);
  if (typeof bot.mainThreadId === "string") threads.add(bot.mainThreadId);
  if (Array.isArray(bot.tasks)) for (const task of bot.tasks) if (record(task) && typeof task.threadId === "string") threads.add(task.threadId);
}

/** Image kinds a page may draw inline from My Cloud: raster pictures only, never SVG (it can carry script). */
const INLINE_IMAGE = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i;
const INLINE_AUDIO = /^audio\//i;

/** The headers My Cloud's bytes are served with on this server's own (trusted) origin: never sniffed, never run, and
 * anything but a raster picture or a sound is a download, whatever My Cloud said it was. */
export function servedFileHeaders(upstream: Pick<Response, "headers">): Record<string, string> {
  const type = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": type, "cache-control": "private, no-store",
    "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
  };
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value && /^[\w ,=/*-]{1,200}$/.test(value)) headers[name] = value;
  }
  for (const name of PAGE_FILE_HEADERS) if (upstream.headers.get(name) === "1") headers[name] = "1";
  if (!INLINE_IMAGE.test(type) && !INLINE_AUDIO.test(type)) {
    const named = /filename\*?=(?:UTF-8'')?"?([^";]{1,200})"?/i.exec(upstream.headers.get("content-disposition") ?? "")?.[1];
    const safe = named ? named.replace(/[^\w .()-]/g, "_") : "";
    headers["content-disposition"] = safe ? `attachment; filename="${safe}"` : "attachment";
  }
  return headers;
}

/** Writes `chunk`, waiting for the page to take what it was sent before more is read from My Cloud. False once the page
 * has gone. */
async function written(res: ServerResponse, chunk: string | Uint8Array): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  return new Promise((done) => {
    const drained = () => { res.off("close", closed); done(true); };
    const closed = () => { res.off("drain", drained); done(false); };
    res.once("drain", drained);
    res.once("close", closed);
  });
}

/** My Cloud's stream events, as the page gets them: only the bot's frames, in its ids, each written once the page took
 * the last. Nothing is written once `signal` aborts (the session changed or went), even an event already read. */
export async function relayFrames(events: AsyncIterable<{ id: string | null; data: string }>, { bot, threads, signal, remember = () => {}, write }: {
  bot: string; threads: Set<string>; signal: AbortSignal; remember?: (name: string, path: string) => void; write: (chunk: string) => Promise<boolean>;
}): Promise<void> {
  for await (const event of events) {
    if (signal.aborted) return;
    let frame: unknown;
    try { frame = JSON.parse(event.data); } catch { continue; }
    const kept = frameForBot(frame, bot, threads);
    if (kept === null) continue;
    if (!(await write(`${event.id ? `id: ${event.id}\n` : ""}data: ${JSON.stringify(intoPlace(kept, remember))}\n\n`))) return;
  }
}

/** Events in the text/event-stream format, one at a time as their blank line arrives: never held for more. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "", data: string[] = [], id: string | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r\n|\r|\n/);
      pending = lines.pop()!;
      for (const line of lines) {
        if (line === "") {
          if (data.length) yield { id, data: data.join("\n") };
          data = [];
          id = null;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const text = colon < 0 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
        if (field === "data") data.push(text);
        else if (field === "id" && !text.includes("\0")) id = text;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * `fetch`: requests to My Cloud. The session arrives with `setSession` (main, over the private port) and goes with
 * `setSession(null)`; the app's capability with `setOwnerToken`.
 */
export function createPlaceProxy({ fetch: fetchImpl = globalThis.fetch as Fetch, requestMs = REQUEST_MS, idleMs = IDLE_MS }: { fetch?: Fetch; requestMs?: number; idleMs?: number } = {}) {
  let session: PlaceSession | null = null;
  /** Every live stream open on the session: a new session, or none, ends them all at once. */
  const streams = new Set<AbortController>();
  let ownerToken: string | null = null;
  const files = new Map<string, string>();
  const remember = (name: string, path: string) => {
    files.delete(name);
    files.set(name, path);
    if (files.size > FILES_KEPT) files.delete(files.keys().next().value!);
  };
  const recall = (name: string) => files.get(name);

  /** The app's own window, from this server's own page: the only caller anything here answers. */
  const ownWindow = ({ req, auth }: Pick<RouteContext, "req" | "auth">): boolean =>
    auth.kind === "loopback" && auth.trust !== "service" && auth.companionDevice === undefined && ownerToken !== null
      && sameToken(req.headers[OWNER_HEADER], ownerToken) && fromOwnPage(req);

  const refuse = (res: ServerResponse, json: RouteContext["json"], status: number, key: UserErrorKey, code: string) => json(res, status, { ...userError(key), code });

  /** My Cloud's answer in this page's terms. Its sleeping, sign-in and limit answers are said as My Cloud's, so this
   * page never takes them for its own server going to sleep, its own sign-in ending or its own bot limit. */
  async function answer(ctx: RouteContext, upstream: Response, bytes = false, idle: () => void = () => {}): Promise<void> {
    const { res, json } = ctx;
    if (upstream.status === 503 && upstream.headers.get(CLOUD_POWER_HEADER) === "asleep") {
      await upstream.body?.cancel().catch(() => {});
      return refuse(res, json, 503, "serverError.place.asleep", "place_asleep");
    }
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {});
      return refuse(res, json, 502, "serverError.place.signIn", "place_signin");
    }
    const type = upstream.headers.get("content-type") ?? "";
    if (bytes) return answerBytes(ctx, upstream, idle);
    if (/^application\/json\b/i.test(type) || !upstream.ok) {
      let body: unknown = null;
      try { body = await upstream.json(); } catch { body = null; }
      if (!upstream.ok && !record(body)) return refuse(res, json, upstream.status === 404 ? 404 : 502, "serverError.place.unsupported", "place_unsupported");
      const placed = intoPlace(body, remember);
      if (!upstream.ok && record(placed)) {
        // A refusal of My Cloud's is passed on in its words, never as one of this server's own kinds.
        const { code: _code, ...said } = placed;
        return json(res, upstream.status === 403 ? 409 : upstream.status, { ...said, code: "place_refused" });
      }
      return json(res, upstream.status, placed);
    }
    return answerBytes(ctx, upstream, idle);
  }

  /** A file route's answer, decided by the route and never by what My Cloud says the bytes are: passed on exactly as
   * they came (a JSON file a bot made stays byte for byte its own), with the headers that keep this origin from running
   * them. Only a link a player asked for moves onto the conversation's place route. A refusal (a range past the end,
   * a file no longer there) reaches the page with its own status. */
  async function answerBytes(ctx: RouteContext, upstream: Response, idle: () => void): Promise<void> {
    const { res } = ctx;
    const headers = servedFileHeaders(upstream);
    if (upstream.headers.get("x-openmausbot-media") === "1" && upstream.ok) {
      const said = await upstream.json().catch(() => null) as { url?: unknown; mime?: unknown } | null;
      const placed = record(said) ? intoPlace({ url: said.url, mime: said.mime }) : {};
      const body = Buffer.from(JSON.stringify(placed));
      res.writeHead(upstream.status, { ...headers, "content-type": "application/json", "content-length": String(body.byteLength) });
      res.end(body);
      return;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body) { res.end(); return; }
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      idle();
      if (!(await written(res, chunk))) { await upstream.body.cancel().catch(() => {}); return; }
    }
    res.end();
  }

  async function forward(ctx: RouteContext, own: PlaceSession, path: string): Promise<void> {
    const { req, res, url, method, json, readBody } = ctx;
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const type = String(req.headers["content-type"] ?? "");
      if (type && !/^application\/json\b/i.test(type)) { req.resume(); return refuse(res, json, 415, "serverError.place.unsupported", "place_unsupported"); }
      let parsed: unknown;
      try { parsed = await readBody(req, BODY_MAX); } catch (error) { return json(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
      body = JSON.stringify(outOfPlace(parsed, recall));
    }
    const search = new URLSearchParams();
    for (const [name, value] of url.searchParams) search.append(name, isPlaceId(value) ? ownId(value) : value);
    const query = search.size ? `?${search}` : "";
    const stop = new AbortController();
    const gone = () => { if (!res.writableEnded) stop.abort(); };
    res.once("close", gone);
    const bytes = BYTE_ROUTE.test(path);
    // The wait for My Cloud's answer is bounded; a file's bytes then run as long as they keep moving.
    let timer = setTimeout(() => stop.abort(), requestMs);
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => stop.abort(), idleMs); };
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${own.origin}${path}${query}`, {
        method, redirect: "error", cache: "no-store", body,
        signal: stop.signal,
        headers: {
          accept: String(req.headers.accept ?? "application/json"), authorization: `Bearer ${own.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(req.headers[BACKGROUND_HEADER] ? { [BACKGROUND_HEADER]: "1" } : {}),
          ...(typeof req.headers.range === "string" && /^bytes=[\d,-]{1,100}$/.test(req.headers.range) ? { range: req.headers.range } : {}),
        },
      });
    } catch {
      clearTimeout(timer);
      res.off("close", gone);
      if (res.headersSent || res.destroyed) return;
      return refuse(res, json, 502, "serverError.place.offline", "place_offline");
    }
    if (bytes) idle();
    try { await answer(ctx, upstream, bytes, idle); } catch {
      if (!res.headersSent) refuse(res, json, 502, "serverError.place.offline", "place_offline"); else res.destroy();
    } finally { clearTimeout(timer); res.off("close", gone); }
  }

  /** The bot's live stream: My Cloud's own stream, opened as the person, cut to this bot's frames and passed on frame by
   * frame as each arrives. It lives exactly as long as the page's connection: closing either closes the other. */
  async function stream(ctx: RouteContext, own: PlaceSession): Promise<void> {
    const { req, res, url, json } = ctx;
    const named = url.searchParams.get("bot");
    const bot = isPlaceId(named) ? ownId(named) : "";
    if (!OWN_ID.test(bot)) return json(res, 400, { error: "name the bot" });
    const stop = new AbortController();
    streams.add(stop);
    stop.signal.addEventListener("abort", () => { streams.delete(stop); if (!res.writableEnded) res.end(); }, { once: true });
    res.on("close", () => stop.abort());
    // Neither the read nor the stream is the person using My Cloud: a page left open never keeps it awake, and one that
    // fell asleep answers so rather than being counted as a visit (the person's own sends and clicks wake it).
    const headers = { authorization: `Bearer ${own.token}`, [BACKGROUND_HEADER]: "1" };
    const threads = new Set<string>();
    // The conversations the bot has now, so the frames of each are known before the stream's first word about the bot.
    let seed: Response;
    try {
      seed = await fetchImpl(`${own.origin}/api/bots/${encodeURIComponent(bot)}?messages=0`, { redirect: "error", cache: "no-store", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_MS)]), headers: { ...headers, accept: "application/json" } });
    } catch {
      return stop.signal.aborted ? undefined : refuse(res, json, 502, "serverError.place.offline", "place_offline");
    }
    if (!seed.ok) return answer(ctx, seed);
    const seeded = await seed.json().catch(() => null) as { bot?: Record<string, unknown> } | null;
    if (!record(seeded?.bot)) return refuse(res, json, 502, "serverError.place.unsupported", "place_unsupported");
    learnThreads(seeded.bot, threads);
    const since = url.searchParams.get("since") ?? (typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null);
    const query = new URLSearchParams({ window: "1", frames: "thread", screens: "off", ...(since ? { since } : {}) });
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${own.origin}/api/events?${query}`, { redirect: "error", cache: "no-store", signal: stop.signal, headers: { ...headers, accept: "text/event-stream" } });
    } catch {
      return stop.signal.aborted ? undefined : refuse(res, json, 502, "serverError.place.offline", "place_offline");
    }
    if (!upstream.ok || !upstream.body || !/^text\/event-stream\b/i.test(upstream.headers.get("content-type") ?? "")) {
      if (!upstream.ok) return answer(ctx, upstream);
      await upstream.body?.cancel().catch(() => {});
      return refuse(res, json, 502, "serverError.place.unsupported", "place_unsupported");
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders();
    req.socket.setTimeout(0);
    // Not awaited: the request is answered, and the stream runs on until either side closes it.
    void (async () => {
      try {
        await relayFrames(sseEvents(upstream.body!), { bot, threads, signal: stop.signal, remember, write: (chunk) => written(res, chunk) });
      } catch {
        // The end of either side ends the stream; the page reconnects.
      } finally {
        stop.abort();
        if (!res.writableEnded) res.end();
      }
    })();
  }

  const route: RouteHandler = async (ctx) => {
    const { path, method, res, json } = ctx;
    const events = path === PLACE_EVENTS_PATH;
    const placed = events ? null : placedPath(path);
    if (!events && placed === null) return PASS;
    if (placed === "") { ctx.req.resume(); return refuse(res, json, 404, "serverError.place.unsupported", "place_unsupported"); }
    if (!ownWindow(ctx)) { ctx.req.resume(); return refuse(res, json, 404, "serverError.place.unsupported", "place_unsupported"); }
    if (!session) { ctx.req.resume(); return refuse(res, json, 503, "serverError.place.offline", "place_closed"); }
    if (events) return method === "GET" ? stream(ctx, session) : json(res, 405, { error: "Use GET." });
    if (!allowed(method, placed!)) { ctx.req.resume(); return refuse(res, json, 404, "serverError.place.unsupported", "place_unsupported"); }
    return forward(ctx, session, placed!);
  };

  return {
    route,
    setSession(next: PlaceSession | null) {
      if (session && (next?.token !== session.token || next?.origin !== session.origin)) for (const stop of streams) stop.abort();
      session = next;
      if (!next) files.clear();
    },
    setOwnerToken(token: string | null) { ownerToken = typeof token === "string" && token ? token : null; },
    hasSession: () => session !== null,
  };
}

export type PlaceProxy = ReturnType<typeof createPlaceProxy>;

/** This server's one proxy, and main's private port feeding it: the session, and the app's capability as main sends it
 * at start (the same message request-auth.ts is given it by). Plain Node, with no port, leaves it with neither. */
export const placeProxy: PlaceProxy = createPlaceProxy();
type Port = { on(event: "message", listener: (event: { data?: unknown }) => void): void };
export function listenPlacePort(port: Port | undefined, proxy: PlaceProxy = placeProxy): void {
  port?.on("message", (event) => {
    const message = event.data;
    const session = parsePlaceSession(message);
    if (session !== undefined) { proxy.setSession(session); return; }
    if (record(message) && message.type === "openmausbot:desktop-mutation-token" && typeof message.token === "string") proxy.setOwnerToken(message.token);
  });
}
listenPlacePort((process as NodeJS.Process & { parentPort?: Port }).parentPort);

export const placeProxyRoutes: RouteHandler = (ctx) => placeProxy.route(ctx);

