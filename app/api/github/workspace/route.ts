import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient, requireLocalWorkspace, sessionTokenFromRequest } from "@/lib/localRealtime";
import { canSetupGitHubApp, disconnectWorkspaceGitHub, githubAppConfig, workspaceGitHubInfo } from "@/lib/github-workspace";
import { permissionNotice } from "@/lib/github-app";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    const config = githubAppConfig(); const connection = workspaceGitHubInfo(user.teamId);
    const shared = await getConvexClient().query(api.teamGitHub.status, { sessionToken: sessionTokenFromRequest(request), teamId: user.teamId });
    return NextResponse.json({ configured: Boolean(config), canSetup: await canSetupGitHubApp(user, user.workspaceRole), login: shared.shared?.accountLogin || connection?.login || null,
      configurationNotice: !config ? "The instance operator must set up the Origin GitHub App once before new workspaces can connect. An existing legacy workspace connection does not configure the App."
        : !config.appId || !config.privateKey ? "The Origin GitHub App configuration is incomplete. The instance operator must configure its App ID and private key before new workspaces can connect." : null,
      prPermissionNotice: config ? permissionNotice : null, permissionApprovalUrl: "https://github.com/settings/installations",
      installationUrl: config?.slug ? `https://github.com/apps/${config.slug}/installations/new` : null });
  } catch { return NextResponse.json({ error: "Workspace access required" }, { status: 403 }); }
}
export async function DELETE(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    if (!["owner", "admin"].includes(user.workspaceRole)) throw new Error("Only admins can do this");
    await getConvexClient().mutation(api.teamGitHub.unshare, { sessionToken: sessionTokenFromRequest(request), teamId: user.teamId });
    disconnectWorkspaceGitHub(user.teamId);
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "Workspace admin access required" }, { status: 403 }); }
}
