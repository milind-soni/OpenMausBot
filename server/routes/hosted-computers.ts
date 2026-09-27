import { z } from "zod";
import { isAddedProvider, type AddedProvider } from "../../shared/hosted-computers.ts";
import type { HostedComputerManager } from "../hosted-computers/manager.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { RequestAuth } from "../request-auth.ts";

type Bot = { id: string; computer?: string; cloudBackend?: string };
const empty = z.object({}).strict();
const command = z.object({ command: z.string().trim().min(1).max(4000) }).strict();
const unavailable = "This cloud computer is unavailable. Please retry or contact NATION support.";
export function createHostedComputerRoutes(deps: {
  manager: HostedComputerManager;
  bot: (id: string) => Bot | undefined;
  access: (botId: string, auth: RequestAuth) => string | null;
  enabled: () => boolean;
  busy: (id: string) => boolean;
  claim: (key: string) => () => void;
  authorizeTool: (authorization: string | string[] | undefined) => { provider: AddedProvider; key: string } | null;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const internal = path.match(/^\/api\/internal\/hosted-computer\/(execute|screenshot)$/);
    if (internal) {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!deps.enabled()) return json(res, 403, { error: unavailable });
      const target = deps.authorizeTool(req.headers.authorization);
      if (!target) return json(res, 403, { error: "This computer turn is no longer available." });
      const parsed = (internal[1] === "execute" ? command : empty).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Invalid computer request" });
      const current = deps.authorizeTool(req.headers.authorization);
      if (!current || current.provider !== target.provider || current.key !== target.key || !deps.enabled()) return json(res, 403, { error: "This computer turn ended." });
      const authorized = () => {
        const cap = deps.authorizeTool(req.headers.authorization);
        return deps.enabled() && cap?.provider === target.provider && cap.key === target.key;
      };
      try {
        const result = internal[1] === "execute"
          ? await deps.manager.execute(target.provider, target.key, command.parse(parsed.data).command, authorized)
          : await deps.manager.screenshot(target.provider, target.key);
        if (!authorized()) return json(res, 403, { error: "This computer turn ended." });
        res.setHeader("cache-control", "private, no-store");
        return json(res, 200, result);
      } catch { return json(res, 502, { error: unavailable }); }
    }
    const match = path.match(/^\/api\/bots\/([\w-]+)\/computer(?:\/(provision|sleep|screenshot|exec|join|remove))?$/);
    if (!match) return PASS;
    const bot = deps.bot(match[1]);
    if (!bot || !isAddedProvider(bot.cloudBackend)) return PASS;
    const key = deps.access(bot.id, auth);
    if (!key) return json(res, 403, { error: "Forbidden" });
    res.setHeader("cache-control", "private, no-store");
    if (!deps.enabled()) return json(res, 403, { error: unavailable });
    if (!match[2] && method === "GET") {
      try { return json(res, 200, { surface: "cloud", ...await deps.manager.status(bot.cloudBackend, key) }); }
      catch { return json(res, 502, { error: unavailable }); }
    }
    if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "Content-Type must be application/json" });
    if (!["provision", "sleep", "screenshot"].includes(match[2] ?? "")) return json(res, 403, { error: "This action is unavailable. Commands run through the agent's tools." });
    if (!empty.safeParse(await readBody(req)).success) return json(res, 400, { error: "Invalid computer request" });
    if (deps.access(bot.id, auth) !== key || !deps.enabled()) return json(res, 403, { error: "Forbidden" });
    const currentBot = deps.bot(bot.id);
    if (currentBot?.cloudBackend !== bot.cloudBackend || currentBot?.computer !== bot.computer) return json(res, 409, { error: "Computer settings changed. Refresh and retry." });
    if (bot.computer !== "cloud") return json(res, 409, { error: "Set this agent to work on its cloud computer first." });
    if (match[2] !== "screenshot" && deps.busy(bot.id)) return json(res, 409, { error: "This computer is in use. Stop the agent before changing it." });
    const release = match[2] === "screenshot" ? () => {} : deps.claim(key);
    try {
      if (match[2] === "provision") return json(res, 200, { ok: true, ...await deps.manager.start(bot.cloudBackend, key, true) });
      if (match[2] === "sleep") return json(res, 200, await deps.manager.stop(bot.cloudBackend, key));
      return json(res, 200, await deps.manager.screenshot(bot.cloudBackend, key));
    } catch { return json(res, 502, { error: unavailable }); }
    finally { release(); }
  };
}
