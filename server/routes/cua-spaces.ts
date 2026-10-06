import type { LocalVmTarget } from "../container-computer.ts";
import type { CuaSpacesAvailability } from "../cua-spaces-computer.ts";
import type { LocalVmStatus } from "../local-vm-backend.ts";
import type { BotRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createCuaSpacesRoutes(deps: {
  availability: () => Promise<CuaSpacesAvailability>;
  previewBot: (botId: string, url: URL) => BotRecord | null;
  previewSurface: (bot: BotRecord, threadId?: string) => Promise<string | undefined>;
  target: (botId: string, threadId?: string) => LocalVmTarget;
  status: (target: LocalVmTarget) => Promise<LocalVmStatus>;
  touch: (target: LocalVmTarget) => void;
  viewerLink: (target: LocalVmTarget) => Promise<unknown>;
}): RouteHandler {
  return async ({ req, res, url, path, method, auth, json }) => {
    // Settings availability never creates or changes a Space.
    if (method === "GET" && path === "/api/local-computer/cua-spaces") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await deps.availability());
    }
    const match = /^\/api\/bots\/([\w-]+)\/local-computer\/viewer$/.exec(path);
    if (!match || method !== "POST") return PASS;
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    // A viewer ticket authorizes this machine's desktop. It is never handed
    // to a paired phone or remote session, and does not pause the bot.
    if (auth.kind !== "loopback") {
      return json(res, 403, { error: "Open the Cua Space from OpenMausBot on the computer that runs it" });
    }
    const bot = deps.previewBot(match[1], url);
    if (!bot) return json(res, 404, { error: "no such bot" });
    const threadId = url.searchParams.has("threadId") ? bot.threadId : undefined;
    if (threadId && await deps.previewSurface(bot, threadId) !== "vm") {
      return json(res, 409, { error: "This conversation is not using the Local VM" });
    }
    const target = deps.target(bot.id, threadId);
    if (!target.space) return json(res, 409, { error: "This bot's Local VM is not a Cua Space" });
    const status = await deps.status(target);
    if (!status.managed || status.container !== "running") {
      return json(res, 409, { error: status.problem ?? "The Cua Space is not running" });
    }
    deps.touch(target);
    res.setHeader("cache-control", "private, no-store");
    return json(res, 200, await deps.viewerLink(target));
  };
}
