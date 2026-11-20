import { track } from "@/lib/analytics";
import { CLOUD_PLAN_URL, openExternalLink, withSource } from "@/lib/app-links";
import type { CloudSource } from "@/lib/cloud-plan";
import { WHATS_NEW_SOURCES } from "@/lib/whats-new";

export type CloudAddRequest = { source: CloudSource; signIn?: true };

/** The desktop's own MausBot Cloud sign-in, which Add a Cloud runs on: none in a browser or on a desktop showing another computer. */
export function cloudAccountBridge() {
  return window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
}

export interface CloudWebHop { url: string; via: "web" | "cloud_page"; plan?: "pro" | "team" }

/** Add a Cloud where there is no Add a Cloud: on a Cloud, or to sign in, the Cloud website's own page for the account
 * (a team's, from its server, else the production one); anywhere else the plan's checkout on the Cloud website. */
export function cloudWebHop(request: CloudAddRequest, place: { cloudHome: boolean; teamCloudPage?: string }): CloudWebHop {
  if (place.cloudHome || request.signIn) {
    return { url: withSource((place.cloudHome && place.teamCloudPage) || CLOUD_PLAN_URL, request.source), via: "cloud_page" };
  }
  const plan = request.source === WHATS_NEW_SOURCES.team ? "team" : "pro";
  const buy = new URL("/pro/buy", CLOUD_PLAN_URL);
  if (plan === "team") buy.searchParams.set("plan", plan);
  return { url: withSource(buy.href, request.source), via: "web", plan };
}

export function openCloudOnWeb(request: CloudAddRequest, place: { cloudHome: boolean; teamCloudPage?: string }): void {
  const hop = cloudWebHop(request, place);
  void openExternalLink(hop.url).catch(() => {});
  track("cloud_checkout_opened", { ...(hop.plan ? { plan: hop.plan } : {}), source: request.source, via: hop.via });
}
