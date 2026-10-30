// Who a Team Cloud bot reports to. GET /api/team/people lists the members a bot can report to, with each one's
// picture; GET /api/team/people/<person>/picture serves it. PUT /api/bots/<id>/reports-to {email} changes one bot's
// owner: an Admin may, and so may the member who owns it now, to hand it over. PUT /api/team/reports-to {botIds, email}
// sets a whole department's at once, for an Admin.
// Security: all but the last are client-scoped, so the checks here are the gate. A member's name and picture are shown
// to the team's signed-in members and nobody else; nothing else of their profile (About you) is ever served here.
import { createHash } from "node:crypto";
import { z } from "zod";

import { botAvatarUrlSchema } from "../../shared/bot-avatar.ts";
import { botOwner, nameFromEmail, ownerEmail } from "../../shared/bot-owner.ts";
import { attachmentExists, readAttachment } from "../attachments.ts";
import { setReportsTo } from "../bot-owners.ts";
import type { CloudTeam } from "../cloud-team.ts";
import { personKey } from "../person-key.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import type { TeamPeople } from "../team-people.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const TEAM_PEOPLE_PATH = "/api/team/people";
export const TEAM_REPORTS_TO_PATH = "/api/team/reports-to";
const ONE_BOT = /^\/api\/bots\/([\w-]{1,128})\/reports-to$/;
const PICTURE = /^\/api\/team\/people\/(p_[\w-]{22})\/picture$/;
const ATTACHMENT = "/api/attachments/";

const ownerBody = z.object({ email: z.string().trim().min(3).max(254).nullable() }).strict();
const bulkBody = z.object({ botIds: z.array(z.string().min(1).max(128)).min(1).max(200), email: z.string().trim().min(3).max(254).nullable() }).strict();

export interface TeamOwnerRouteDeps {
  team: CloudTeam | null;
  people: TeamPeople | null;
  store: Pick<Store, "bots" | "bot" | "patchBot">;
  /** The name and picture of the member's team profile. */
  profileOf?(email: string): { name?: string; avatarUrl?: string };
  /** Whether the session may see this bot at all. */
  sees(auth: RequestAuth, botId: string): boolean;
  publicBot(bot: BotRecord): unknown;
}

/** The address a session speaks for: a team member's, or none (a loopback service, a session the Admin never signed). */
function sessionEmail(auth: RequestAuth): string | null {
  return auth.kind === "session" && auth.session.membershipAuthority === "team" && auth.session.email ? ownerEmail(auth.session.email) : null;
}

function storedPicture(avatarUrl: string | undefined): string | null {
  if (!avatarUrl || !botAvatarUrlSchema.safeParse(avatarUrl).success) return null;
  const name = avatarUrl.slice(ATTACHMENT.length);
  return attachmentExists(name) ? name : null;
}

/** Changes whenever the picture does, without naming the upload. */
const pictureVersion = (avatarUrl: string) => createHash("sha256").update(avatarUrl).digest("base64url").slice(0, 16);

function teamPictureUrl(email: string, avatarUrl: string): string {
  return `${TEAM_PEOPLE_PATH}/${personKey({ id: "", email })}/picture?v=${pictureVersion(avatarUrl)}`;
}

export function createTeamOwnerRoutes(deps: TeamOwnerRouteDeps): RouteHandler {
  const profileOf = (email: string) => deps.profileOf?.(email) ?? {};
  const nameOf = (email: string) => profileOf(email).name?.trim() || nameFromEmail(email);
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const one = method === "PUT" ? ONE_BOT.exec(path) : null;
    const listing = method === "GET" && path === TEAM_PEOPLE_PATH;
    const picture = method === "GET" ? PICTURE.exec(path) : null;
    const bulk = method === "PUT" && path === TEAM_REPORTS_TO_PATH;
    if (!one && !listing && !picture && !bulk) return PASS;
    const { team, people } = deps;
    if (!team || !people) return picture ? json(res, 404, { error: "not found" }) : json(res, 400, { error: "Only a team's bots report to someone." });
    const admin = auth.scopes.includes("admin");
    const me = sessionEmail(auth);
    const members = () => {
      const known = people.list();
      return me && !known.some((person) => person.email === me) && auth.kind === "session" && auth.session.teamRole
        ? [...known, { email: me, role: auth.session.teamRole }] : known;
    };

    if (listing) {
      return json(res, 200, { people: members().map(({ email, role }) => {
        const avatarUrl = me ? profileOf(email).avatarUrl : undefined;
        return { email, name: nameOf(email), role, ...(email === me ? { you: true } : {}),
          ...(avatarUrl && storedPicture(avatarUrl) ? { pictureUrl: teamPictureUrl(email, avatarUrl) } : {}) };
      }) });
    }

    if (picture) {
      if (!me) return json(res, 403, { error: `Only ${team.name}'s members see each other's pictures.` });
      const email = members().find((person) => personKey({ id: "", email: person.email }) === picture[1])?.email;
      const avatarUrl = email ? profileOf(email).avatarUrl : undefined;
      const name = storedPicture(avatarUrl);
      const stored = name ? readAttachment(name) : null;
      if (!avatarUrl || !stored) return json(res, 404, { error: "no such picture" });
      // Revalidated on every use, so the member check above runs each time; the address changes with the picture.
      const headers = { "content-type": stored.mime, "cache-control": "private, no-cache", etag: `"${pictureVersion(avatarUrl)}"`, "x-content-type-options": "nosniff" };
      if (req.headers["if-none-match"] === headers.etag) {
        res.writeHead(304, headers);
        return void res.end();
      }
      res.writeHead(200, { ...headers, "content-length": String(stored.bytes.byteLength) });
      return void res.end(stored.bytes);
    }

    const unknownPerson = (email: string | null) => email !== null && email !== me && !people.has(email);
    const conflict = (email: string | null) => json(res, 409, {
      error: `${email ? nameOf(ownerEmail(email)) : "That person"} already has a Chief of Staff. Take the crown off one of them first.`,
    });

    if (bulk) {
      if (!admin) return json(res, 403, { error: `Only ${team.name}'s admins can set who a department's bots report to.` });
      const parsed = bulkBody.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Send botIds and an email." });
      const { email } = parsed.data;
      if (unknownPerson(email)) return json(res, 400, { error: `Choose someone in ${team.name}.` });
      const botIds = parsed.data.botIds.filter((id) => !deps.store.bot(id)?.defaultBot?.person);
      const changed = setReportsTo(deps.store, botIds, email);
      if (!changed.ok) return changed.reason === "chief-conflict" ? conflict(email) : json(res, 404, { error: "One or more bots are unavailable." });
      return json(res, 200, { bots: changed.bots.map((bot) => deps.publicBot(bot)) });
    }

    const beforeRead = deps.store.bot(one![1]!);
    if (!beforeRead || !deps.sees(auth, beforeRead.id)) return json(res, 404, { error: "no such bot" });
    const parsed = ownerBody.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send the email of the person it reports to." });
    const bot = deps.store.bot(one![1]!);
    if (!bot || !deps.sees(auth, bot.id)) return json(res, 404, { error: "no such bot" });
    if (bot.defaultBot?.person) return json(res, 409, { error: `${bot.name} is ${nameOf(ownerEmail(bot.defaultBot.person))}'s own MausBot: it always reports to them.` });
    if (!admin && (me === null || botOwner(bot) !== me)) {
      return json(res, 403, { error: `Only ${team.name}'s admins, or the person ${bot.name} reports to, can change who it reports to.` });
    }
    const { email } = parsed.data;
    if (unknownPerson(email)) return json(res, 400, { error: `Choose someone in ${team.name}.` });
    const changed = setReportsTo(deps.store, [bot.id], email);
    if (!changed.ok) return changed.reason === "chief-conflict" ? conflict(email) : json(res, 404, { error: "no such bot" });
    return json(res, 200, { bot: deps.publicBot(changed.bots[0]!) });
  };
}
