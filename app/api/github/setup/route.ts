import { NextResponse } from "next/server";
import { limitLocalAction, requireLocalWorkspace, sessionTokenFromRequest } from "@/lib/localRealtime";
import { canSetupGitHubApp, createGithubState, githubAppConfig } from "@/lib/github-workspace";
import { originUrl } from "@/lib/integration-bridge";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    if (githubAppConfig()) throw new Error("GitHub App is already configured");
    if (!canSetupGitHubApp(user, user.workspaceRole)) throw new Error("Only a workspace owner or admin can set up GitHub");
    limitLocalAction(`github-setup:${user._id}`, 3, 60000);
    const { state, browser } = createGithubState({ teamId: user.teamId, userId: user._id, sessionToken: sessionTokenFromRequest(request), slug: user.slug, mode: "setup" });
    const origin = originUrl();
    const response = NextResponse.json({ action: `https://github.com/settings/apps/new?state=${state}`, manifest: {
      name: "Origin Workspace", url: origin, public: true,
      redirect_url: `${origin}/api/github/setup/callback`, callback_urls: [`${origin}/api/github/oauth/callback`],
      setup_url: `${origin}/api/github/oauth/install`, request_oauth_on_install: false,
      hook_attributes: { url: `${origin}/api/github/webhook`, active: true },
      default_permissions: { administration: "write", issues: "write", contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
      default_events: ["issues", "pull_request", "pull_request_review", "check_suite", "check_run", "push"],
    } });
    response.cookies.set("origin.github", browser, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/github", maxAge: 900 });
    return response;
  } catch (error) { return NextResponse.json({ error: errorText(error, "Setup failed") }, { status: 403 }); }
}
