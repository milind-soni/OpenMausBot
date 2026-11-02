// GET /api/team/groups: a Team Cloud's groups of people, for anyone on the team (the same people GET /api/team/people
// lists). POST /api/team/groups {name, members} adds one; PUT and DELETE /api/team/groups/<id> change or remove it,
// admins only. A change rewrites the sharing of every bot the group was given, so each bot's visibility (who sees it at
// all) keeps matching its members; a group whose members would make any of those bots visible to more than
// MAX_VISIBILITY_PEOPLE is refused before anything is saved.
import type { BotAccess } from "../../shared/bot-access.ts";
import { botOwner } from "../../shared/bot-owner.ts";
import type { AdminActionRow } from "../admin-activity.ts";
import { accessOf, MAX_VISIBILITY_PEOPLE } from "../bot-visibility.ts";
import type { CloudTeam } from "../cloud-team.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import { groupBody, type TeamGroup, type TeamGroups } from "../team-groups.ts";
import type { TeamPeople } from "../team-people.ts";
import { tooWide } from "./bot-access.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const TEAM_GROUPS_PATH = "/api/team/groups";
const ONE_GROUP = /^\/api\/team\/groups\/([\w-]{1,64})$/;

export interface TeamGroupRouteDeps {
  team: CloudTeam | null;
  people: Pick<TeamPeople, "has"> | null;
  groups: TeamGroups | null;
  store: Pick<Store, "bots">;
  /** routes/bot-access.ts's writeAccess, bound to the server. */
  writeAccess(bot: BotRecord, access: BotAccess): unknown;
  broadcast(payload: Record<string, unknown>): void;
  /** Settings → Activity. */
  record?(auth: RequestAuth, row: Omit<AdminActionRow, "at" | "actor">): void;
}

/** The bots that give this group a level, with their sharing as it should be after the change (without the group when
 * it is removed). */
function affected(store: Pick<Store, "bots">, id: string, removed: boolean): Array<{ bot: BotRecord; access: BotAccess }> {
  const out: Array<{ bot: BotRecord; access: BotAccess }> = [];
  for (const bot of store.bots) {
    const access = accessOf(bot);
    if (!access.groups || !Object.hasOwn(access.groups, id)) continue;
    if (!removed) { out.push({ bot, access }); continue; }
    const groups = { ...access.groups };
    delete groups[id];
    out.push({ bot, access: { everyone: access.everyone, people: access.people, ...(Object.keys(groups).length ? { groups } : {}) } });
  }
  return out;
}

/** Rewrites the sharing of every bot that gives this group a level, so each one's visibility follows its members. One
 * bot that can't be written doesn't stop the rest; it is rewritten again at the group's next change. */
export function rewriteGroupBots(store: Pick<Store, "bots">, id: string, removed: boolean, writeAccess: (bot: BotRecord, access: BotAccess) => unknown): void {
  for (const { bot, access } of affected(store, id, removed)) {
    try {
      writeAccess(bot, access);
    } catch (error) {
      console.warn(`team groups: could not update ${bot.id} for group ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createTeamGroupRoutes(deps: TeamGroupRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const one = ONE_GROUP.exec(path);
    if (path !== TEAM_GROUPS_PATH && !one) return PASS;
    const { team, people, groups } = deps;
    if (!team || !people || !groups) return json(res, 404, { error: "Groups of people are for a team's Cloud." });
    const listed = () => groups.list();
    if (method === "GET" && !one) return json(res, 200, { groups: listed() });
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: `Only ${team.name}'s admins can change its groups.` });
    const target = one ? groups.get(one[1]!) : undefined;
    if (one && !target) return json(res, 404, { error: "no such group" });
    const settle = (id: string, before: TeamGroup | undefined, after: TeamGroup | undefined) => {
      rewriteGroupBots(deps.store, id, !after, deps.writeAccess);
      deps.broadcast({ kind: "teamGroups", groups: listed() });
      const action = !before ? "group.create" : after ? "group.update" : "group.delete";
      const name = after?.name ?? before?.name;
      deps.record?.(auth, { category: "people", action, target: { kind: "group", id, ...(name ? { name } : {}) },
        ...(before ? { before: { name: before.name, members: before.members } } : {}), ...(after ? { after: { name: after.name, members: after.members } } : {}) });
    };

    if (method === "DELETE" && target) {
      groups.remove(target.id);
      settle(target.id, target, undefined);
      return json(res, 200, { groups: listed() });
    }
    if (!(method === "POST" && !one) && !(method === "PUT" && target)) return json(res, 405, { error: "method not allowed" });
    const parsed = groupBody.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send a name and the members' email addresses." });
    const stranger = parsed.data.members.find((email) => !people.has(email) && !target?.members.includes(email.trim().toLowerCase()));
    if (stranger) return json(res, 400, { error: `${stranger.slice(0, 80)} isn't in ${team.name}. Add people from the team.` });
    if (target) {
      // Checked against the members it would have, before anything is saved.
      const members = new Set(parsed.data.members.map((email) => email.trim().toLowerCase()));
      const wide = affected(deps.store, target.id, false).find(({ bot, access }) => {
        const others = { ...access, groups: { ...access.groups } };
        delete others.groups[target.id];
        return tooWide({ ...others, people: { ...others.people, ...Object.fromEntries([...members].map((email) => [email, "view" as const])) } }, botOwner(bot));
      });
      if (wide) return json(res, 400, { error: `With these members, more than ${MAX_VISIBILITY_PEOPLE} people would see ${wide.bot.name}. Give everyone in the team a level on it instead.` });
    }
    const saved = groups.put(target?.id ?? null, parsed.data);
    if (!saved) return json(res, 400, { error: `A team can have at most 100 groups.` });
    settle(saved.id, target, saved);
    return json(res, target ? 200 : 201, { group: saved, groups: listed() });
  };
}
