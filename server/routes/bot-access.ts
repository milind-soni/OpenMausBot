// PUT /api/bots/<id>/access { everyone, people }: a Team Cloud bot's sharing, set whole (the app's Undo puts the previous
// one back). Security: client-scoped, so this handler is the gate: only someone who can edit the bot changes it, a new
// person must be a member of the team, and the bot's visibility follows in the same write so the rest of the server's
// "who sees it" checks stay true.
import type { BotAccess } from "../../shared/bot-access.ts";
import { visibilityFromAccess } from "../../shared/bot-access.ts";
import { botOwner } from "../../shared/bot-owner.ts";
import type { WireBot } from "../../shared/wire.ts";
import { accessOf, groupMembersNow, MAX_VISIBILITY_PEOPLE, parseBotAccess, sameAudience } from "../bot-visibility.ts";
import type { CloudTeam } from "../cloud-team.ts";
import { refusalFor } from "../host/bot-access-gate.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { TeamGroups } from "../team-groups.ts";
import type { TeamPeople } from "../team-people.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ONE_BOT = /^\/api\/bots\/([\w-]{1,128})\/access$/;

export interface BotAccessRouteDeps {
  team: CloudTeam | null;
  people: Pick<TeamPeople, "has"> | null;
  groups?: Pick<TeamGroups, "get"> | null;
  store: Pick<Store, "bot" | "patchBot" | "groups" | "sections">;
  levelOf(auth: RequestAuth, botId: string): string;
  wireBot(bot: BotRecord): WireBot;
  publicGroupState(group: GroupRecord): unknown;
  broadcast(payload: Record<string, unknown>): void;
  audienceChanged(): void;
}

/** The bot's sharing with `next` applied: the owner is never listed (they always edit), and nobody new comes in from
 * outside the team. An entry the bot already had (an older list's address or @domain) may stay; a group must be one of
 * the team's. */
export function settledAccess(bot: BotRecord, next: BotAccess, member: (email: string) => boolean, group: (id: string) => boolean = () => false):
  { ok: true; access: BotAccess } | { ok: false; error: string } {
  const before = accessOf(bot).people;
  const owner = botOwner(bot);
  const people: BotAccess["people"] = {};
  for (const [entry, level] of Object.entries(next.people)) {
    if (entry === owner) continue;
    if (!Object.hasOwn(before, entry) && !member(entry)) return { ok: false, error: `${entry} isn't in this team. Add people from the team.` };
    people[entry] = level;
  }
  for (const id of Object.keys(next.groups ?? {})) if (!group(id)) return { ok: false, error: "That group isn't in this team any more." };
  const access: BotAccess = { everyone: next.everyone, people, ...(next.groups && Object.keys(next.groups).length ? { groups: next.groups } : {}) };
  return tooWide(access, owner) ? { ok: false, error: `Shared this way, more than ${MAX_VISIBILITY_PEOPLE} people would see it. Give everyone in the team a level instead.` } : { ok: true, access };
}

/** Visibility lists each person who sees the bot, at most MAX_VISIBILITY_PEOPLE; a longer one would read as admins only. */
export function tooWide(access: BotAccess, owner: string | null): boolean {
  const visibility = visibilityFromAccess(access, owner, groupMembersNow);
  return typeof visibility === "object" && visibility.people.length > MAX_VISIBILITY_PEOPLE;
}

/** Stores a bot's sharing with its visibility in the same write, and tells everyone whose view of it changed. */
export function writeAccess(deps: Pick<BotAccessRouteDeps, "store" | "publicGroupState" | "broadcast" | "audienceChanged">, bot: BotRecord, access: BotAccess): BotRecord | null {
  const visibility = visibilityFromAccess(access, botOwner(bot), groupMembersNow);
  const audienceMoved = !sameAudience(bot.visibility, visibility);
  const updated = deps.store.patchBot(bot.id, { access, visibility });
  if (updated && audienceMoved) {
    for (const group of deps.store.groups.filter((candidate) => candidate.memberIds.includes(updated.id))) {
      deps.broadcast({ kind: "group", group: deps.publicGroupState(group) });
    }
    deps.broadcast({ kind: "sections", sections: deps.store.sections });
    deps.audienceChanged();
  }
  return updated;
}

export function createBotAccessRoutes(deps: BotAccessRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const one = method === "PUT" ? ONE_BOT.exec(path) : null;
    if (!one) return PASS;
    const { team, people, store } = deps;
    if (!team || !people) return json(res, 400, { error: "Only a team's bots are shared." });
    const bot = store.bot(one[1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (deps.levelOf(auth, bot.id) !== "edit") return json(res, 403, { error: refusalFor(bot.name, "edit") });
    const parsed = parseBotAccess(await readBody(req));
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    const current = store.bot(bot.id);
    if (!current) return json(res, 404, { error: "no such bot" });
    const settled = settledAccess(current, parsed.access, (email) => people.has(email), (id) => Boolean(deps.groups?.get(id)));
    if (!settled.ok) return json(res, 400, { error: settled.error });
    const updated = writeAccess(deps, current, settled.access);
    return updated ? json(res, 200, { bot: deps.wireBot(updated) }) : json(res, 404, { error: "no such bot" });
  };
}
