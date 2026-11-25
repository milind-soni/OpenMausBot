// A bot's Skills page for a skill on all of the person's bots: put one of this bot's own skills on all of them, or take a
// shared one off every bot. A bot's copy is one of its own skills, so its switch is the per-bot routes'. On a Team Cloud
// only the member the bot reports to may change what all of their bots have.
import { ownerEmail } from "../../shared/bot-owner.ts";
import type { SkillsForAllBotsHost } from "../host/skills-for-all-bots-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import { listSkills } from "../skills.ts";
import { allBotsScopeOfBot, allBotsScopeOfPerson, allBotsUnavailable, SHARED_WITHOUT_TEAM, skillsForAllBotsOnTeam } from "../skills-for-all-bots.ts";
import { removeFromAllBots } from "../skills-for-all-bots-ops.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SkillsForAllBotsRouteDeps {
  store: Pick<Store, "bot">;
  host: Pick<SkillsForAllBotsHost, "fromSkillsPage">;
}

/** The store this request may change through this bot: the bot's person's, and on a Team Cloud only when that is who
 * is asking. */
export function requesterScope(bot: BotRecord, auth: RequestAuth): { scope: string } | { status: number; error: string } {
  if (allBotsUnavailable()) return { status: 409, error: SHARED_WITHOUT_TEAM };
  const scope = allBotsScopeOfBot(bot);
  if (!scope) return { status: 409, error: "This bot belongs to no one, so it has no \"all my bots\"." };
  if (!skillsForAllBotsOnTeam()) return { scope };
  const email = auth.kind === "session" ? auth.session.email : undefined;
  if (!email || allBotsScopeOfPerson(ownerEmail(email), true) !== scope) {
    return { status: 403, error: "Only the person this bot reports to can change the skills on all of their bots." };
  }
  return { scope };
}

/** A bot's skills as its Skills page lists them, each own skill that is on marked when this person may put it on all of
 * their bots, so the button shows only where it works. */
export function withAllBotsOffer<T extends { name: string; enabled: boolean; allBots?: true; origin?: string }>(bot: BotRecord, auth: RequestAuth, skills: T[]): Array<T & { canUseOnAllBots?: true }> {
  if ("error" in requesterScope(bot, auth)) return skills;
  const own = new Set(listSkills(bot.id).map((skill) => skill.name));
  return skills.map((skill) => (own.has(skill.name) && skill.enabled && !skill.allBots && (skill.origin === undefined || skill.origin === "private") ? { ...skill, canUseOnAllBots: true as const } : skill));
}

export function createSkillsForAllBotsRoutes(deps: SkillsForAllBotsRouteDeps): RouteHandler {
  return async ({ path, method, auth, json, res }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)(\/all-bots)?$/);
    if (!m) return PASS;
    const bot = deps.store.bot(m[1]!);
    if (!bot) return PASS;
    const name = m[2]!;
    if (m[3] && method === "POST") {
      const allowed = requesterScope(bot, auth);
      if ("error" in allowed) return json(res, allowed.status, { error: allowed.error });
      const done = deps.host.fromSkillsPage(bot, name, allowed.scope);
      return json(res, done.status, done.body);
    }
    if (method !== "DELETE" || !listSkills(bot.id).some((skill) => skill.name === name && skill.allBots)) return m[3] ? json(res, 404, { error: `no skill named "${name}" is on all your bots` }) : PASS;
    // Only Remove on the Skills page (…/all-bots) takes a shared skill off every bot of the person's. A plain delete of a
    // bot's shared copy is what a send, a move or a team file does to replace one bot's skill, so it is refused.
    if (!m[3]) return json(res, 409, { error: `"${name}" is on all your bots. Remove it from all of them on this bot's Skills page, or turn it off for this bot.` });
    const allowed = requesterScope(bot, auth);
    if ("error" in allowed) return json(res, allowed.status, { error: allowed.error });
    const removed = removeFromAllBots(allowed.scope, name);
    if ("error" in removed) return json(res, 409, { error: removed.error });
    return json(res, 200, { ok: true });
  };
}
