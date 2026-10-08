// X research routes: the four internal calls behind the agents server's x_*
// tools, and Settings → API keys' Test for the treg token.
//
// The internal handler runs inside index.ts's /api/internal/ block, after the
// capability bearer is checked (the route table runs before that block). It
// still re-checks the token and the bot's own switch on every call: the tool
// list a bot was shown at the start of its turn is not permission to spend.
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { json as sendJson } from "../harness/http.ts";
import {
  createTregXClient,
  DEFAULT_POSTS,
  MAX_POSTS,
  normalizeHandle,
  parsePostRef,
  X_MESSAGES,
  XResearchError,
  type XResearchClient,
  type XResearchErrorCode,
} from "../x-research.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface XResearchDeps {
  /** The saved treg token, read per request. */
  token: () => string | undefined;
  /** bot.xResearch === true */
  botEnabled: (botId: string) => boolean;
  /** Tests pass a fake; the server builds the real client per call. */
  client?: (token: string) => XResearchClient;
}

export interface XInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  /** The capability's own bot, never a body field. */
  botId: string;
  /** index.ts's readInternalBody: re-checks the capability after the read. */
  readBody: () => Promise<unknown>;
}

const PREFIX = "/api/internal/x/";
const ACTIONS = new Set(["search", "user-posts", "post", "profile"]);

/** 401 is never used: on internal routes it means the capability expired. */
function statusFor(code: XResearchErrorCode): number {
  return code === "bad_input" ? 400 : code === "not_found" ? 404 : 502;
}

const limit = z.number().int().min(1).max(MAX_POSTS).optional();
const sinceId = z.string().regex(/^\d{1,25}$/, "sinceId must be the digits of an X post id, such as a newestId from an earlier call").optional();
const searchBody = z.object({ query: z.string().trim().min(1).max(512), sort: z.enum(["latest", "top"]).optional(), limit, sinceId });
const userPostsBody = z.object({ handle: z.string(), limit, sinceId, includeReplies: z.boolean().optional() });
const postBody = z.object({ post: z.string(), replies: z.boolean().optional() });
const profileBody = z.object({ handle: z.string() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new XResearchError("bad_input", `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`);
}

function handleFrom(raw: string): string {
  const handle = normalizeHandle(raw);
  if (!handle) throw new XResearchError("bad_input", "handle must be an X handle such as @openmausbot, or an x.com profile link.");
  return handle;
}

async function run(action: string, body: unknown, client: XResearchClient): Promise<unknown> {
  if (action === "search") {
    const input = parse(searchBody, body);
    return client.search({ query: input.query, sort: input.sort ?? "latest", limit: input.limit ?? DEFAULT_POSTS, ...(input.sinceId ? { sinceId: input.sinceId } : {}) });
  }
  if (action === "user-posts") {
    const input = parse(userPostsBody, body);
    return client.userPosts({
      handle: handleFrom(input.handle),
      limit: input.limit ?? DEFAULT_POSTS,
      includeReplies: input.includeReplies ?? false,
      ...(input.sinceId ? { sinceId: input.sinceId } : {}),
    });
  }
  if (action === "post") {
    const input = parse(postBody, body);
    const ref = parsePostRef(input.post);
    if (!ref) throw new XResearchError("bad_input", "post must be an x.com or twitter.com post link, or a post id.");
    return client.post({ ...ref, replies: input.replies ?? false });
  }
  const input = parse(profileBody, body);
  return client.profile(handleFrom(input.handle));
}

export function createXResearchInternalRoutes(deps: XResearchDeps) {
  const clientFor = deps.client ?? ((token: string) => createTregXClient({ token }));
  return async (ctx: XInternalContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || !ctx.path.startsWith(PREFIX)) return PASS;
    const action = ctx.path.slice(PREFIX.length);
    if (!ACTIONS.has(action)) return PASS;
    const token = deps.token()?.trim();
    if (!token) return void ctx.json(ctx.res, 403, { error: X_MESSAGES.noKey });
    if (!deps.botEnabled(ctx.botId)) return void ctx.json(ctx.res, 403, { error: X_MESSAGES.botOff });
    const body = await ctx.readBody();
    try {
      ctx.json(ctx.res, 200, await run(action, body, clientFor(token)));
    } catch (error) {
      if (!(error instanceof XResearchError)) throw error;
      ctx.json(ctx.res, statusFor(error.code), { error: error.message, code: error.code });
    }
  };
}

/** Settings → API keys' Test: two free account calls; the verdict never
 * carries the token. Admin-only like every route not opened to clients. */
export function createXResearchKeyTestRoute(deps: Pick<XResearchDeps, "token" | "client">): RouteHandler {
  const clientFor = deps.client ?? ((token: string) => createTregXClient({ token }));
  return async ({ method, path, res, json }) => {
    if (method !== "POST" || path !== "/api/x-research/test") return PASS;
    res.setHeader("cache-control", "no-store");
    const token = deps.token()?.trim();
    if (!token) return void json(res, 400, { error: "No token to test. Paste one or save one first." });
    try {
      const { balanceUsd } = await clientFor(token).accountInfo();
      json(res, 200, { ok: true, dollars: balanceUsd });
    } catch (error) {
      if (!(error instanceof XResearchError)) throw error;
      const reason = error.code === "bad_key" ? "rejected" : error.code === "unavailable" ? "unreachable" : "unexpected";
      json(res, 200, { ok: false, reason, message: error.message });
    }
  };
}
