// Slack for Team Clouds: the three routes the Admin calls with a session it opened for the member who wrote in Slack
// (docs/team-slack.md). Only a Team Cloud has them; anywhere else each answers 404 with no code, which the Admin reads
// as a Cloud that can't take Slack messages yet.
import type { ServerResponse } from "node:http";

import type { TeamSlackAnswer, TeamSlackHost } from "../host/team-slack-host.ts";
import { teamSlackMessageSchema } from "../team-slack.ts";
import { PASS, type RouteHandler } from "./table.ts";

const STOP = /^\/api\/slack\/team\/messages\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/stop$/;

/** The contract's `bot` and `bots` are not the app's bot records, so they skip the filter every JSON body sent to a
 * member passes through, which would add the app's own fields to them. */
function answerWith(res: ServerResponse, answer: TeamSlackAnswer): void {
  res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(answer.body));
}

export function createTeamSlackRoutes(deps: { host: TeamSlackHost | null }): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/slack/team/")) return PASS;
    const { host } = deps;
    if (!host) return json(res, 404, { error: "not found" });
    if (path === "/api/slack/team/bots" && method === "GET") return answerWith(res, host.bots(auth));
    if (path === "/api/slack/team/messages" && method === "POST") {
      const parsed = teamSlackMessageSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Send a message as docs/team-slack.md says.", code: "bad_request" });
      return answerWith(res, await host.message(auth, parsed.data));
    }
    const stop = method === "POST" ? STOP.exec(path) : null;
    if (stop) {
      await readBody(req);
      return answerWith(res, await host.stop(auth, stop[1]!));
    }
    return json(res, 404, { error: "not found" });
  };
}
