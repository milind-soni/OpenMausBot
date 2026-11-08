import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getConvexClient, limitLocalAction, requireLocalWorkspace, sessionTokenFromRequest } from "@/lib/localRealtime";
import { consumeGithubState, createGithubState, exchangeGitHubToken, githubAppConfig, githubAuthorizeUrl, githubRequest, peekGithubState } from "@/lib/github-workspace";
import { originUrl } from "@/lib/integration-bridge";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ step: string }> }) {
  if ((await context.params).step !== "start") return new Response(null, { status: 404 });
  try {
    const user = await requireLocalWorkspace(request);
    if (!["owner", "admin"].includes(user.workspaceRole)) throw new Error("Workspace admin access required");
    limitLocalAction(`github-connect:${user._id}`, 10, 60000);
    const app = githubAppConfig(); if (!app) throw new Error("The Origin GitHub App has not been configured yet");
    if (!app.appId || !app.privateKey) throw new Error("The instance operator must finish configuring the Origin GitHub App before connecting a workspace");
    const projectId = request.nextUrl.searchParams.get("projectId") || undefined;
    if (projectId) {
      const project = await getConvexClient().query(api.projects.get, { sessionToken: sessionTokenFromRequest(request), projectId: projectId as Id<"projects"> });
      if (project.teamId !== user.teamId) throw new Error("Project not found");
    }
    const { state, browser, challenge } = createGithubState({ teamId: user.teamId, userId: user._id, slug: user.slug, sessionToken: sessionTokenFromRequest(request), mode: "connect", projectId });
    // Installation alone does not authorize an existing app to act for this workspace.
    const url = githubAuthorizeUrl(state, challenge);
    const response = NextResponse.json({ url });
    response.cookies.set("origin.github", browser, { httpOnly: true, secure: originUrl().startsWith("https:"), sameSite: "lax", path: "/api/github", maxAge: 900 });
    return response;
  } catch (error) { return NextResponse.json({ error: errorText(error, "Could not connect") }, { status: 400 }); }
}
export async function GET(request: NextRequest, context: { params: Promise<{ step: string }> }) {
  const { step } = await context.params;
  let workspaceSlug = "";
  try {
    const state = request.nextUrl.searchParams.get("state") || "";
    const browser = request.cookies.get("origin.github")?.value || "";
    if (step === "install") {
      const pending = peekGithubState(state, browser);
      return NextResponse.redirect(githubAuthorizeUrl(state, createHash("sha256").update(pending.verifier).digest("base64url")));
    }
    if (step !== "callback") return new Response(null, { status: 404 });
    const pending = consumeGithubState(state, browser, "connect");
    workspaceSlug = pending.slug;
    const app = githubAppConfig(); const code = request.nextUrl.searchParams.get("code");
    if (!app || !code || request.nextUrl.searchParams.has("error")) throw new Error("GitHub connection cancelled");
    if (!app.appId || !app.privateKey) throw new Error("The Origin GitHub App configuration is incomplete");
    const access = await getConvexClient().query(api.workspaces.access, { sessionToken: pending.sessionToken, teamId: pending.teamId as Id<"teams"> });
    if (!["owner", "admin"].includes(access.role)) throw new Error("Workspace admin access required");
    const token = await exchangeGitHubToken({ client_id: app.clientId, client_secret: app.clientSecret, code, code_verifier: pending.verifier, redirect_uri: `${originUrl()}/api/github/oauth/callback` });
    const account = await githubRequest<{ id: number; login: string }>("/user", token.access_token);
    if (app.slug) {
      const result = await githubRequest<{ installations: { account: { id: number }; app_slug: string; suspended_at: string | null; permissions: { administration?: string } }[] }>("/user/installations?per_page=100", token.access_token);
      const installation = result.installations.find(item => item.app_slug === app.slug && item.account.id === account.id && !item.suspended_at);
      if (!installation || installation.permissions.administration !== "write") {
        if (pending.installationAttempted) throw new Error("GitHub installation needs Administration write permission on your personal account");
        const next = createGithubState({ teamId: pending.teamId, userId: pending.userId, slug: pending.slug, sessionToken: pending.sessionToken, mode: "connect", installationAttempted: true, projectId: pending.projectId });
        const response = NextResponse.redirect(`https://github.com/apps/${app.slug}/installations/new?state=${encodeURIComponent(next.state)}`);
        response.cookies.set("origin.github", next.browser, { httpOnly: true, secure: originUrl().startsWith("https:"), sameSite: "lax", path: "/api/github", maxAge: 900 });
        return response;
      }
    }
    const currentAccess = await getConvexClient().query(api.workspaces.access, { sessionToken: pending.sessionToken, teamId: pending.teamId as Id<"teams"> });
    if (!["owner", "admin"].includes(currentAccess.role)) throw new Error("Workspace admin access required");
    await getConvexClient().action(api.teamGitHub.share, {
      sessionToken: pending.sessionToken, teamId: pending.teamId as Id<"teams">,
      app: { ...app, appId: app.appId, privateKey: app.privateKey }, token,
    });
    const redirect = new URL(`${originUrl()}/${encodeURIComponent(pending.slug)}`);
    redirect.searchParams.set("github", "connected");
    if (pending.projectId) { redirect.searchParams.set("project", pending.projectId); redirect.searchParams.set("tab", "repo"); }
    const response = NextResponse.redirect(redirect);
    response.cookies.delete({ name: "origin.github", path: "/api/github" });
    return response;
  } catch (error) {
    console.warn("GitHub authorization callback failed", error instanceof Error ? error.message : "Authorization rejected");
    const response = NextResponse.redirect(`${originUrl()}/${encodeURIComponent(workspaceSlug)}?github=connection-failed`);
    response.cookies.delete({ name: "origin.github", path: "/api/github" });
    return response;
  }
}
