import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { track } from "@/lib/analytics";
import { teamPeoplePage } from "@/lib/app-links";
import { TEAMS_NOTICE } from "@/lib/notices";
import { startTeamUrl, whatsNewAudience } from "@/lib/whats-new";
import type { WelcomeViewer } from "@/lib/onboarding";

/** The Team plan's checkout on the Cloud website, tagged for this popup on the Cloud's funnel. */
export const TEAMS_SOURCE = "app_whats_new_teams";
export const startTeamsUrl = (staging = false) => startTeamUrl(staging).replace(/src=[^&]*/, `src=${TEAMS_SOURCE}`);

/** What the Teams popup offers this person: on a Team Cloud, its Owner and Admins invite people from the team's People
 * page and its members are only told, as is a desktop whose Cloud sign-in is already in a team; everyone else starts a
 * team, in the app's own Add a Cloud when they have a Cloud plan of their own on this desktop (the website's Get Team
 * only tells them to write in), else on the website. */
export type TeamsAction =
  | { kind: "invite"; url: string }
  | { kind: "got-it" }
  | { kind: "start"; inApp: boolean; url: string };

export function teamsAction({ team, viewer, account, canAddCloud }: {
  team: { id: string; cloudPage?: string } | null | undefined;
  viewer: Pick<WelcomeViewer, "canSave" | "teamRole"> | null;
  /** This desktop's MausBot Cloud sign-in, on its own page; null elsewhere. */
  account: CloudAccountState | null;
  /** The app's Add a Cloud can open here. */
  canAddCloud: boolean;
}): TeamsAction {
  if (team) {
    const admin = viewer?.teamRole === "owner" || viewer?.teamRole === "admin" || (viewer?.teamRole === undefined && viewer?.canSave === true);
    const url = admin ? teamPeoplePage(team, "invite") : null;
    return url ? { kind: "invite", url } : { kind: "got-it" };
  }
  const audience = account === null ? null : whatsNewAudience(account);
  if (audience === "team") return { kind: "got-it" };
  return { kind: "start", inApp: canAddCloud && audience === "own", url: startTeamsUrl(account?.staging === true) };
}

export type TeamsStep = "seen" | "invite" | "start_team" | "see_team_plans" | "got_it" | "not_now" | "close";
type TeamsAudience = "team_admin" | "team_member" | "no_team";

export function teamsAudience(action: TeamsAction): TeamsAudience {
  return action.kind === "invite" ? "team_admin" : action.kind === "got-it" ? "team_member" : "no_team";
}

/** The `whats_new` event, as the earlier popup counts its steps, under this popup's campaign. */
export function reportTeams(action: TeamsStep, shown: TeamsAction) {
  track("whats_new", { action, slide: "teams", audience: teamsAudience(shown), campaign: TEAMS_NOTICE });
}
