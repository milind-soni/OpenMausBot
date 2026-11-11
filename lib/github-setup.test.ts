// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/github/setup/route";
import { GET } from "../app/api/github/setup/callback/route";
import { GET as workspaceGET } from "../app/api/github/workspace/route";
import { createGithubState, githubAppConfig, saveGitHubApp } from "./github-workspace";
import { convexStore, seedWorkspace, signedBridge, type Backend } from "../testing/convex-store";

const current = vi.hoisted(() => ({ role: "owner", email: "operator@pg3.test", userId: "operator-user", legacy: "", teamId: "", backend: null as unknown }));
vi.mock("../convex/lib/auth", async importOriginal => ({ ...await importOriginal<typeof import("../convex/lib/auth")>(), get DEFAULT_OWNER_EMAIL() { return current.legacy; } }));
vi.mock("./integration-bridge", async importOriginal => ({ ...await importOriginal<typeof import("./integration-bridge")>(), integrationBridge: async (operation: string, args: unknown) => {
  if (!operation.startsWith("store.")) throw new Error(`unexpected ${operation}`);
  return signedBridge(current.backend as Backend, operation, args);
} }));
vi.mock("./workspace-session", () => ({
  sessionTokenFromRequest: () => "fixture-session",
  requireLocalUser: async () => ({ _id: current.userId, email: current.email }),
  getConvexClient: () => ({ query: async () => {
    if (current.role === "removed") throw new Error("Workspace access revoked");
    return { role: current.role };
  } }),
  requireLocalWorkspace: async () => {
    if (current.role === "removed") throw new Error("Workspace access revoked");
    return { _id: current.userId, email: current.email, workspaceRole: current.role, slug: "pg3", teamId: current.teamId };
  },
}));
beforeEach(async () => {
  const backend = convexStore();
  current.backend = backend;
  current.teamId = (await seedWorkspace(backend)).teamId;
});
afterEach(() => {
  current.role = "owner"; current.email = "operator@pg3.test"; current.userId = "operator-user"; current.legacy = "";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const manifest = () => POST(new Request(`http://localhost:3000/api/github/setup?teamId=${current.teamId}`, { method: "POST" }));
async function callback() {
  const { state, browser } = await createGithubState({ teamId: current.teamId, userId: current.userId, sessionToken: "fixture-session", slug: "pg3", mode: "setup" });
  return new NextRequest(`http://localhost:3000/api/github/setup/callback?state=${state}&code=fixtureCode`, { headers: { cookie: `origin.github=${browser}` } });
}
const conversion = () => vi.fn(async () => Response.json({ client_id: "fixture-id", client_secret: "fixture-client-secret", slug: "fixture-app", webhook_secret: "fixture-webhook", id: 123, pem: "fixture-pem" }));

const workspaceStatus = async () => (await workspaceGET(new Request(`http://localhost:3000/api/github/workspace?teamId=${current.teamId}`))).json();
const stranger = () => { current.userId = "stranger-user"; current.email = "stranger@evil.test"; };

test("GitHub App setup: any workspace owner or admin gets the manifest while no App exists; members and viewers do not", async () => {
  for (const who of [() => undefined, stranger]) {
    who();
    for (const role of ["owner", "admin"]) {
      current.role = role;
      const response = await manifest();
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(await response.json()).toMatchObject({ action: expect.stringContaining("https://github.com/settings/apps/new?state="), manifest: { default_permissions: { contents: "write", pull_requests: "write", checks: "read" }, default_events: expect.arrayContaining(["pull_request", "push", "issues"]) } });
      expect(await workspaceStatus()).toMatchObject({ configured: false, canSetup: true });
    }
    for (const role of ["member", "viewer"]) {
      current.role = role;
      expect((await manifest()).status).toBe(403);
      expect(await workspaceStatus()).toMatchObject({ canSetup: false });
    }
    current.role = "removed";
    expect((await manifest()).status).toBe(403);
  }
});

test("GitHub App setup: the legacy owner email no longer gates setup, and nobody can once an App exists", async () => {
  current.legacy = "legacy@pg3.test";
  expect((await manifest()).status).toBe(200);
  await saveGitHubApp({ clientId: "existing", clientSecret: "existing-secret" });
  expect((await manifest()).status).toBe(403);
  expect(await workspaceStatus()).toMatchObject({ configured: true, canSetup: false });
});

test("GitHub App setup: ORIGIN_ADMIN_EMAILS, when set, limits setup to those owners and admins", async () => {
  vi.stubEnv("ORIGIN_ADMIN_EMAILS", " Ops@PG3.test , second@pg3.test,");
  expect((await manifest()).status).toBe(403);
  current.email = "ops@pg3.test"; current.userId = "ops-user";
  expect((await manifest()).status).toBe(200);
  current.email = "SECOND@pg3.test"; current.role = "admin";
  expect((await manifest()).status).toBe(200);
  current.role = "member";
  expect((await manifest()).status).toBe(403);
});

test("GitHub App setup: the callback re-checks the role, so a demoted admin's state cannot save an App", async () => {
  const request = await callback(), fetcher = conversion();
  current.role = "member";
  vi.stubGlobal("fetch", fetcher);
  expect((await GET(request)).headers.get("location")).toBe("http://localhost:3000/pg3?github=setup-failed");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await githubAppConfig()).toBeNull();
});

test("GitHub App setup: two admins finishing at once keep the first App", async () => {
  const late = await callback();
  vi.stubGlobal("fetch", conversion());
  expect((await GET(await callback())).headers.get("location")).toContain("app-ready");
  expect((await GET(late)).headers.get("location")).toContain("setup-failed");
  // Both passed the role check before either saved: the store itself refuses the second App.
  expect(await saveGitHubApp({ clientId: "second", clientSecret: "second-secret" })).toBe(false);
  expect(await githubAppConfig()).toMatchObject({ clientId: "fixture-id" });
});

test("PG3 O-110: manifest conversion persists encrypted credentials once with cookie and state binding", async () => {
  const request = await callback(), fetcher = conversion();
  vi.stubGlobal("fetch", fetcher);
  expect((await GET(new NextRequest(request.url))).headers.get("location")).toContain("setup-failed");
  expect(fetcher).not.toHaveBeenCalled();
  expect((await GET(request)).headers.get("location")).toContain("app-ready");
  expect(await githubAppConfig()).toMatchObject({ appId: 123, privateKey: "fixture-pem" });
  const stored = await (current.backend as Backend).run(async ctx => JSON.stringify(await ctx.db.query("githubAppRegistrations").take(5)));
  expect(stored).toContain("sealed");
  expect(stored).not.toMatch(/fixture-client-secret|fixture-pem|fixture-webhook/);
  expect((await GET(request)).headers.get("location")).toContain("setup-failed");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(["viewer", "removed"])("PG3 O-110: setup callback rejects a user whose workspace authority became %s", async role => {
  const request = await callback(), fetcher = conversion();
  current.role = role;
  vi.stubGlobal("fetch", fetcher);
  expect((await GET(request)).headers.get("location")).toContain("setup-failed");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await githubAppConfig()).toBeNull();
});

test("PG3 O-110: revocation during manifest conversion cannot persist an App", async () => {
  const request = await callback();
  vi.stubGlobal("fetch", vi.fn(async () => { current.role = "viewer"; return conversion()(); }));
  expect((await GET(request)).headers.get("location")).toContain("setup-failed");
  expect(await githubAppConfig()).toBeNull();
});
