// GET and PUT /api/me: a person's own profile on a Team Cloud (people-about.ts): the name and picture they go by and their
// "About you", read into their own turns only, with the address of their verified sign-in. Anywhere else the server's one
// profile (Settings → Profile) is the person's, and this answers 404.
import { botAvatarUrlSchema } from "../../shared/bot-avatar.ts";
import type { CloudTeam } from "../cloud-team.ts";
import type { MemberProfile, MemberProfilePatch } from "../host/cloud-team-host.ts";
import { ABOUT_ME_MAX, PERSON_NAME_MAX, type SeedField } from "../people-about.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface MeRouteDeps {
  team: CloudTeam | null;
  session(auth: RequestAuth): SessionRecord | null;
  profile(session: SessionRecord): MemberProfile;
  save(session: SessionRecord, patch: MemberProfilePatch): MemberProfile;
  /** `fillEmpty`: the desktop app's one-time seed from the person's own computer (seedMemberProfile). */
  seed(session: SessionRecord, offer: { name?: string; avatarUrl?: string }): { profile: MemberProfile; filled: SeedField[] };
  seeded(session: SessionRecord): SeedField[];
  /** After a save: the person's own windows and phones show it. */
  changed(): void;
}

export function createMeRoutes(deps: MeRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/me") return PASS;
    if (!deps.team) return json(res, 404, { error: "not found" });
    const session = deps.session(auth);
    if (!session) return json(res, 403, { error: "Sign in to this team to have a profile." });
    const team = { id: deps.team.id, name: deps.team.name };
    if (method === "GET") return json(res, 200, { team, ...deps.profile(session), seeded: deps.seeded(session) });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, 64 * 1024);
    const given = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const patch: MemberProfilePatch = {};
    for (const key of ["aboutMe", "name", "avatarUrl"] as const) {
      if (given[key] === undefined) continue;
      if (typeof given[key] !== "string") return json(res, 400, { error: `${key} must be text` });
      patch[key] = given[key];
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: "send { name, avatarUrl, aboutMe }: what to change about you" });
    if (given.fillEmpty !== undefined && given.fillEmpty !== true) return json(res, 400, { error: "fillEmpty is true or absent" });
    if (given.fillEmpty === true && patch.aboutMe !== undefined) return json(res, 400, { error: "Only your name and picture fill in from your computer" });
    if (patch.aboutMe !== undefined && patch.aboutMe.length > ABOUT_ME_MAX * 2) return json(res, 400, { error: `About you is at most ${ABOUT_ME_MAX} characters` });
    if (patch.name !== undefined && patch.name.trim().length > PERSON_NAME_MAX) return json(res, 400, { error: `Your name is at most ${PERSON_NAME_MAX} characters` });
    if (patch.avatarUrl && !botAvatarUrlSchema.safeParse(patch.avatarUrl).success) return json(res, 400, { error: "Your picture must be one you uploaded here" });
    if (given.fillEmpty === true) {
      const { profile, filled } = deps.seed(session, patch);
      if (filled.length) deps.changed();
      return json(res, 200, { team, ...profile, filled });
    }
    const saved = deps.save(session, patch);
    deps.changed();
    return json(res, 200, { team, ...saved });
  };
}
