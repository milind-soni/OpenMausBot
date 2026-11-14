// A deep link only: this server holds no Slack logic, contacts nobody, and the link carries identifiers, never a credential.
import { hostedSlackManagement } from "../hosted-slack.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface HostedSlackRouteDeps {
  bot(id: string): { id: string; hidden?: boolean } | null | undefined;
  hostedReady(): boolean;
  env?: NodeJS.ProcessEnv;
}

export function createHostedSlackRoutes(deps: HostedSlackRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/slack-management$/);
    if (!m || method !== "GET") return PASS;
    const bot = deps.bot(m[1]!);
    if (!bot || bot.hidden) return json(res, 404, { error: "no such bot" });
    res.setHeader("cache-control", "no-store");
    // The id in the link is the stored bot's, not the text from the request.
    return json(res, 200, hostedSlackManagement(bot.id, deps.hostedReady(), deps.env));
  };
}
