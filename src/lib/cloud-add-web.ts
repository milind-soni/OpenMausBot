import { openExternalLink, withSource } from "@/lib/app-links";
import type { CloudSource } from "@/lib/cloud-plan";

export type CloudAddRequest = { source: CloudSource; signIn?: true };

/** The desktop's own MausBot Cloud sign-in, which Add a Cloud runs on: none in a browser or on a desktop showing another computer. */
export function cloudAccountBridge() {
  return window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
}

export interface CloudWebHop { url: string; via: "web" | "cloud_page"; plan?: "pro" | "team" }

/** Add a Cloud where there is no Add a Cloud: on a Cloud, or to sign in, the Cloud website's own page for the account
 * (a team's, from its server, else the production one); anywhere else the plan's checkout on the Cloud website. */
export function cloudWebHop(request: CloudAddRequest, place: { cloudHome: boolean; teamCloudPage?: string }): CloudWebHop | null {
  if (!place.cloudHome || !place.teamCloudPage) return null;
  return { url: withSource(place.teamCloudPage, request.source), via: "cloud_page" };
}

export function openCloudOnWeb(request: CloudAddRequest, place: { cloudHome: boolean; teamCloudPage?: string }): void {
  const hop = cloudWebHop(request, place);
  if (!hop) return;
  void openExternalLink(hop.url).catch(() => {});
}
