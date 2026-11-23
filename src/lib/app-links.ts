import { APP_NAME } from "../../shared/product";
import { REPOSITORY_URL, repositoryDoc, SERVICES } from "../../shared/services";

export { APP_NAME };
export const APP_REPOSITORY = REPOSITORY_URL;
/** Cloud pages, only ever linked from Cloud screens, which a build with no Cloud never shows. */
const CLOUD_SITE = SERVICES.cloud ?? "https://cloud.invalid";
export const DOCS_URL = `${APP_REPOSITORY}/tree/main/docs`;
export const HELP_CENTER_URL = DOCS_URL;
export const APPROVAL_LEVELS_URL = `${APP_REPOSITORY}/blob/main/docs/approval-levels.md`;
export const PASSKEY_HELP_URL = repositoryDoc("apps/docs/content/docs/troubleshooting/google-sign-in-cloud-browser.mdx");
export const FEEDBACK_URL = `${REPOSITORY_URL}/issues`;
export const RELEASES_URL = `${APP_REPOSITORY}/releases`;
export const PRICING_URL = `${CLOUD_SITE}/pricing`;
/** The website's Team plans: `#teams` opens the pricing page on its Team tab. */
export const TEAM_PLANS_URL = `${PRICING_URL}#teams`;
export const CLOUD_PLAN_URL = `${CLOUD_SITE}/cloud`;
/** The Admin's team People page (openmaus-cloud docs/team-seats.md): people, seats and roles are managed there, never in
 * the app. `invite` opens its invite box (Owner and Admins); `seats` its seat stepper (the Owner, whose card pays). */
export const TEAM_PEOPLE_PAGES = { invite: "people?do=invite", seats: "people?do=seats" } as const;
/** `cloudPage`: the Admin's Cloud pages for this team's Cloud (`<admin origin>/cloud`), sent by the server. */
export function teamPeoplePage(team: { id: string; cloudPage?: string } | null | undefined, open: keyof typeof TEAM_PEOPLE_PAGES = "invite"): string | null {
  return team?.cloudPage ? `${team.cloudPage}/team/${encodeURIComponent(team.id)}/${TEAM_PEOPLE_PAGES[open]}` : null;
}
export function withSource(url: string, source: string): string {
  const target = new URL(url);
  target.searchParams.set("src", source);
  return target.href;
}
export const LICENSE_URL = `${APP_REPOSITORY}/blob/main/LICENSE`;

export function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

export function desktopAppVersion(): string {
  return (typeof window !== "undefined" && window.ogb?.app?.version) || appVersion();
}

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export function platformLabel(platform?: string): string | null {
  return (platform && PLATFORM_NAMES[platform]) ?? null;
}

export async function openExternalLink(url: string): Promise<void> {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** A browser hands a mailto: link to its own mail app; the desktop app's window may not navigate to one, so main opens it. */
export async function openEmailDraft(url: string): Promise<void> {
  if (window.ogb) return openExternalLink(url);
  window.location.href = url;
}
