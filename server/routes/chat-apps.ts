import { approvalModeFor } from "../../shared/approval-mode.ts";
import { APP_LIMITS, type AppPayload } from "../../shared/app.ts";
import { appRow, createChatApps, rowRate, type ChatApps } from "../chat-apps.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export { createChatApps };
export { createChatAppsMcp } from "../chat-apps-mcp.ts";

export const APP_RPC_METHODS = ["tools/call", "tools/list", "resources/read", "resources/list"] as const;

export interface McpRpcRequest {
  auth: RequestAuth;
  bot: BotRecord;
  threadId: string;
  row: Message & { app: AppPayload };
  method: (typeof APP_RPC_METHODS)[number];
  params: Record<string, unknown>;
  /** The person pressed Allow in the host-drawn bar. */
  confirmed: boolean;
}

/** The JSON-RPC `result`, or {error: {code, message}, signIn?, confirm?}. */
export interface McpRpcAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface ChatAppRouteDeps {
  store: Pick<Store, "bot" | "botByThread" | "groupByThread" | "messagesFor" | "patchMessage" | "projectBotForTask" | "taskByThread">;
  apps: ChatApps;
  /** On a Cloud home, a guest changes only conversations it started. */
  threadRefusal?(auth: RequestAuth, threadId: string): string | null;
  mcpRpc?(request: McpRpcRequest): Promise<McpRpcAnswer>;
}

const DOCUMENT = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/app$/;
const APP_ACTION = /^\/api\/bots\/([\w-]+)\/apps\/([\w-]+)\/(rpc|context)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createChatAppRoutes(deps: ChatAppRouteDeps): RouteHandler {
  const { store, apps } = deps;
  const contextRate = rowRate(120, 60_000);

  const approvalOf = (threadId: string): "full" | "confirm" => {
    const bot = store.botByThread(threadId);
    const task = bot ? store.projectBotForTask(bot.id, threadId) : null;
    return task && approvalModeFor({ ...task, threadId }) === "full" ? "full" : "confirm";
  };

  return async ({ req, res, path, method, auth, json, readBody }) => {
    let m = DOCUMENT.exec(path);
    if (m && method === "GET") {
      const threadId = m[1]!;
      // An unknown thread answers before the store materialises it.
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) return json(res, 404, { error: "no such conversation" });
      if (!appRow(store, threadId, m[2]!)) return json(res, 404, { error: "no app on that message" });
      const doc = apps.appDocument(threadId, m[2]!, approvalOf(threadId));
      if (!doc) return json(res, 404, { error: "This app's page is not stored on this computer." });
      // `can` and `blocked` change with sign-in and settings: never cached.
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, doc);
    }

    m = APP_ACTION.exec(path);
    if (!m || method !== "POST") return PASS;
    const [, botId, messageId, action] = m as unknown as [string, string, string, "rpc" | "context"];
    const body = await readBody(req, action === "rpc" ? APP_LIMITS.rpcArgumentsBytes + 16_384 : 64_000);
    if (!isRecord(body) || typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId)) {
      return json(res, 400, { error: "threadId is required" });
    }
    const threadId = body.threadId;
    const bot = store.bot(botId);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (!store.taskByThread(bot.id, threadId)) return json(res, 404, { error: "no such conversation" });
    const refused = deps.threadRefusal?.(auth, threadId);
    if (refused) return json(res, 403, { error: refused });
    const row = appRow(store, threadId, messageId);
    if (!row || (row.from && row.from.botId !== bot.id)) return json(res, 404, { error: "That app is not in this conversation." });

    if (action === "context") {
      if (!contextRate.take(`${threadId}:${row.id}`)) return json(res, 429, { error: "Too many context updates from this app." });
      const result = apps.setAppContext({ threadId, messageId: row.id, content: body.content, structuredContent: body.structuredContent });
      return result.ok ? json(res, 200, { ok: true }) : json(res, result.status, { error: result.error });
    }

    if (row.app.source !== "mcp") return json(res, 404, { error: "That app has no server to call." });
    if (typeof body.method !== "string" || !(APP_RPC_METHODS as readonly string[]).includes(body.method)) {
      return json(res, 400, { error: `method must be one of ${APP_RPC_METHODS.join(", ")}` });
    }
    if (body.params !== undefined && !isRecord(body.params)) return json(res, 400, { error: "params must be an object" });
    if (!deps.mcpRpc) return json(res, 404, { error: "This app cannot reach its server on this computer yet." });
    const answer = await deps.mcpRpc({
      auth, bot, threadId, row,
      method: body.method as McpRpcRequest["method"],
      params: isRecord(body.params) ? body.params : {},
      confirmed: body.confirmed === true,
    });
    return json(res, answer.status, answer.body);
  };
}
