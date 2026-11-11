import { NextRequest, NextResponse } from "next/server";
import { getConvexClient, requireLocalUser } from "@/lib/localRealtime";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { canSetupGitHubApp, consumeGithubState, saveGitHubApp, type GithubState } from "@/lib/github-workspace";
import { originUrl } from "@/lib/integration-bridge";

export const runtime = "nodejs";
async function requireSetupAdmin(state: GithubState) {
  const user = await requireLocalUser(state.sessionToken);
  const access = await getConvexClient().query(api.workspaces.access, { sessionToken: state.sessionToken, teamId: state.teamId as Id<"teams"> });
  if (user._id !== state.userId || !canSetupGitHubApp(user, access.role)) throw new Error("Setup unavailable");
}
export async function GET(request: NextRequest) {
  let slug = "";
  try {
    const state = consumeGithubState(request.nextUrl.searchParams.get("state") || "", request.cookies.get("origin.github")?.value || "", "setup");
    slug = state.slug;
    await requireSetupAdmin(state);
    const code = request.nextUrl.searchParams.get("code"); if (!code || !/^[a-zA-Z0-9]+$/.test(code)) throw new Error("Invalid setup code");
    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
    const app = await response.json();
    if (!response.ok || !app.client_id || !app.client_secret || !app.slug || !app.webhook_secret) throw new Error("GitHub App setup failed");
    await requireSetupAdmin(state);
    const saved = saveGitHubApp({ clientId: app.client_id, clientSecret: app.client_secret, slug: app.slug, webhookSecret: app.webhook_secret, appId: app.id, privateKey: app.pem });
    if (!saved) throw new Error("Another admin registered the GitHub App first");
    return NextResponse.redirect(`${originUrl()}/${encodeURIComponent(state.slug)}?github=app-ready`);
  } catch { return NextResponse.redirect(`${originUrl()}/${slug ? encodeURIComponent(slug) : ""}?github=setup-failed`); }
}
