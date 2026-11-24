// A bot's Skills page for a skill on all of the person's bots: put one of this bot's own skills on all of them, switch a
// shared one off for this bot alone, or take it off every bot. On a Team Cloud only the member the bot reports to may
// put a skill on, or take one off, all of their bots; anyone who may change the bot's skills may switch it for that bot.
import { z } from "zod";

import { ownerEmail } from "../../shared/bot-owner.ts";
import type { RequestAuth } from "../request-auth.ts";
import { listSkills } from "../skills.ts";
import { allBotsScopeOfBot, allBotsScopeOfPerson, allBotsSkills, setAllBotsSkillOff, skillsForAllBotsOnTeam } from "../skills-for-all-bots.ts";
import { copyDigest, ownCopy, putOnAllBots, removeFromAllBots, sharedCopy } from "../skills-for-all-bots-ops.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SkillsForAllBotsRouteDeps {
  store: Pick<Store, "bot">;
}

/** The store this request may change through this bot: the bot's person's, and on a Team Cloud only when that is who
 * is asking. */
export function requesterScope(bot: BotRecord, auth: RequestAuth): { scope: string } | { status: number; error: string } {
  const scope = allBotsScopeOfBot(bot);
  if (!scope) return { status: 409, error: "This bot belongs to no one, so it has no \"all my bots\"." };
  if (!skillsForAllBotsOnTeam()) return { scope };
  const email = auth.kind === "session" ? auth.session.email : undefined;
  if (!email || allBotsScopeOfPerson(ownerEmail(email), true) !== scope) {
    return { status: 403, error: "Only the person this bot reports to can change the skills on all of their bots." };
  }
  return { scope };
}

export function createSkillsForAllBotsRoutes(deps: SkillsForAllBotsRouteDeps): RouteHandler {
  return async ({ path, method, auth, json, readBody, req, res }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)(\/all-bots)?$/);
    if (!m) return PASS;
    const bot = deps.store.bot(m[1]!);
    if (!bot) return PASS;
    const name = m[2]!;
    if (m[3]) {
      if (method !== "POST") return PASS;
      const allowed = requesterScope(bot, auth);
      if ("error" in allowed) return json(res, allowed.status, { error: allowed.error });
      const own = listSkills(bot.id).find((skill) => skill.name === name);
      if (!own) return json(res, 404, { error: `This bot has no skill of its own named "${name}".` });
      // A skill still off here may be an import nobody has read yet: it reaches every bot only once it is on somewhere.
      if (!own.enabled) return json(res, 409, { error: `Turn "${name}" on for this bot first, after reading it.` });
      const copy = ownCopy(bot.id, name);
      if (!copy) return json(res, 409, { error: `"${name}" changed outside OpenMausBot; remove it and add it again.` });
      // A different copy already on all of their bots stays: this bot keeps its own until one of the two is removed.
      const existing = sharedCopy(allowed.scope, name);
      if (existing && copyDigest(existing) !== copyDigest(copy)) {
        return json(res, 409, { error: `A different "${name}" is already on all your bots. Remove this bot's own copy to use that one, or remove that one from all your bots first.` });
      }
      const put = putOnAllBots(allowed.scope, name, copy, { fresh: !existing });
      if ("error" in put) return json(res, 409, { error: put.error });
      return json(res, 200, { name, kept: put.kept.map((id) => deps.store.bot(id)?.name ?? id), retired: put.retired.length });
    }
    // Only a name on all of the person's bots that this bot does not shadow with its own; the rest is the per-bot routes'.
    const shared = !listSkills(bot.id).some((skill) => skill.name === name) && allBotsSkills(bot.id).find((skill) => skill.name === name);
    if (!shared) return PASS;
    if (method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      setAllBotsSkillOff(bot.id, name, !parsed.data.enabled);
      return json(res, 200, { skill: allBotsSkills(bot.id).find((skill) => skill.name === name) });
    }
    if (method === "DELETE") {
      const allowed = requesterScope(bot, auth);
      if ("error" in allowed) return json(res, allowed.status, { error: allowed.error });
      const removed = removeFromAllBots(allowed.scope, name);
      if ("error" in removed) return json(res, 409, { error: removed.error });
      return json(res, 200, { ok: true });
    }
    return PASS;
  };
}
