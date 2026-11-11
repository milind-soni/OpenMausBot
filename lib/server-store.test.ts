// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { limitAction, limitReached, store, TooManyRequests, withLease } from "./server-store";
import { consumeGithubState, createGithubState, githubAppConfig, lockGitHubJob, peekGithubState, readGitHubJob, saveGitHubApp, saveGitHubJob, saveWorkspaceGitHub, workspaceGitHubInfo, workspaceGitHubToken } from "./github-workspace";
import { githubConnectionInfo, githubConnectionToken, saveGitHubConnection } from "./githubConnection";
import { convexStore, seedWorkspace, signedBridge, type Backend } from "../testing/convex-store";

// The Convex store that replaced ORIGIN_LOCAL_DATA_DIR, driven through the frontend's own modules and the signed bridge.
const backend = vi.hoisted(() => ({ current: null as Backend | null, calls: [] as string[] }));
vi.mock("./integration-bridge", async importOriginal => ({
  ...await importOriginal<typeof import("./integration-bridge")>(),
  integrationBridge: (operation: string, args: unknown) => { backend.calls.push(operation); return signedBridge(backend.current!, operation, args); },
}));
let seeded: { userId: string; teamId: string };
beforeEach(async () => { backend.current = convexStore(); backend.calls.length = 0; seeded = await seedWorkspace(backend.current); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const dump = () => backend.current!.run(async ctx => JSON.stringify(await Promise.all([
  ctx.db.query("githubAppRegistrations").take(10), ctx.db.query("githubProjectConnections").take(10), ctx.db.query("githubWorkspaceConnections").take(10), ctx.db.query("githubOAuthStates").take(10),
])));

test("GitHub secrets are sealed with ORIGIN_SEALING_KEY at rest and readable only through the bridge", async () => {
  expect(await saveGitHubApp({ clientId: "app-client", clientSecret: "fixture-app-secret", webhookSecret: "fixture-webhook-secret", privateKey: "fixture-pem-body" })).toBe(true);
  expect(await saveGitHubApp({ clientId: "second", clientSecret: "second" })).toBe(false);
  expect(await githubAppConfig()).toMatchObject({ clientId: "app-client", webhookSecret: "fixture-webhook-secret", privateKey: "fixture-pem-body" });
  const projectId = await backend.current!.run(ctx => ctx.db.insert("projects", { name: "P", status: "active", accent: "blue", ownerEmail: "owner@fixture.test", teamId: seeded.teamId as never, createdAt: 0, updatedAt: 0 }));
  await saveGitHubConnection(projectId, "acme/repo", "octo", "fixture-project-token", seeded.userId);
  expect(await githubConnectionToken(projectId, "acme/repo")).toBe("fixture-project-token");
  expect(await githubConnectionToken(projectId, "acme/other")).toBeUndefined();
  expect(await githubConnectionInfo(projectId, "acme/repo")).toMatchObject({ login: "octo", connectedBy: seeded.userId });
  await saveWorkspaceGitHub(seeded.teamId, "octo", 7, seeded.userId, { access_token: "fixture-workspace-token", refresh_token: "fixture-refresh-token" });
  const { state, browser } = await createGithubState({ teamId: seeded.teamId, sessionToken: "fixture-session-token", userId: seeded.userId, slug: "s", mode: "connect" });
  const stored = await dump();
  for (const secret of ["fixture-app-secret", "fixture-webhook-secret", "fixture-pem-body", "fixture-project-token", "fixture-workspace-token", "fixture-refresh-token", "fixture-session-token", state, browser]) expect(stored).not.toContain(secret);
});

test("without ORIGIN_SEALING_KEY nothing secret is stored", async () => {
  vi.stubEnv("ORIGIN_SEALING_KEY", "");
  await expect(saveGitHubApp({ clientId: "c", clientSecret: "fixture-unsealed" })).rejects.toThrow();
  expect(await dump()).not.toContain("fixture-unsealed");
});

test("GitHub OAuth states are single use and bound to the browser nonce", async () => {
  const { state, browser } = await createGithubState({ teamId: seeded.teamId, sessionToken: "s", userId: seeded.userId, slug: "s", mode: "setup" });
  await expect(peekGithubState(state, "other-browser")).rejects.toThrow("expired");
  expect(await peekGithubState(state, browser)).toMatchObject({ mode: "setup" });
  await expect(consumeGithubState(state, browser, "connect")).rejects.toThrow("Invalid");
  await expect(consumeGithubState(state, browser, "setup")).rejects.toThrow("expired");
});

test("job leases and named leases are exclusive across instances and expire on their own", async () => {
  expect(await lockGitHubJob("repo:x")).toBe(true);
  expect(await lockGitHubJob("repo:x")).toBe(false);
  await saveGitHubJob("repo:x", "done", { repo: 1 });
  expect(await readGitHubJob("repo:x")).toMatchObject({ state: "done", payload: JSON.stringify({ repo: 1 }) });
  expect(await lockGitHubJob("repo:x")).toBe(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 91000);
  expect(await lockGitHubJob("repo:x")).toBe(true);
  vi.useRealTimers();

  let inside = 0;
  const first = await withLease("fixture-lease", 30000, async () => {
    inside++;
    expect(await withLease("fixture-lease", 30000, async () => { inside++; })).toEqual({ busy: true });
    return "done";
  });
  expect(first).toEqual({ busy: false, value: "done" });
  expect(inside).toBe(1);
  expect((await withLease("fixture-lease", 30000, async () => "again"))).toEqual({ busy: false, value: "again" });
});

test("rate limits are one shared window per key", async () => {
  await limitAction("fixture-key", 2, 60000);
  await limitAction("fixture-key", 2, 60000);
  await expect(limitAction("fixture-key", 2, 60000)).rejects.toBeInstanceOf(TooManyRequests);
  expect(await limitReached("fixture-key", 2)).toBe(true);
  expect(await limitReached("other-key", 2)).toBe(false);
});

test("a workspace token refresh is compare-and-set: one instance refreshes, a reconnect is never overwritten", async () => {
  await store("store.githubAppSave", { config: JSON.stringify({ clientId: "app", clientSecret: "app-secret" }) });
  await saveWorkspaceGitHub(seeded.teamId, "octo", 7, seeded.userId, { access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() - 1000 });
  let refreshes = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { refreshes++; return Response.json({ access_token: `new-${refreshes}`, refresh_token: `refresh-${refreshes + 1}`, expires_in: 3600 }); }));
  const tokens = await Promise.all([workspaceGitHubToken(seeded.teamId, seeded.userId), workspaceGitHubToken(seeded.teamId, seeded.userId)]);
  expect(tokens).toEqual(["new-1", "new-1"]);
  expect(refreshes).toBe(1);
  expect(await workspaceGitHubInfo(seeded.teamId)).toMatchObject({ login: "octo", accountId: 7 });
  // A save that expected an older version (a refresh racing a reconnect) is refused.
  expect(await store("store.githubWorkspaceSave", { teamId: seeded.teamId, login: "octo", accountId: 7, connectedBy: seeded.userId, token: { access_token: "stale" }, expectedVersion: 1 })).toBe(false);
  expect(await workspaceGitHubToken(seeded.teamId, seeded.userId)).toBe("new-1");
  expect(await workspaceGitHubToken(seeded.teamId, "someone-else")).toBeUndefined();
});

test("the bridge refuses unsigned calls and unknown operations", async () => {
  const unsigned = await backend.current!.fetch("/integrations", { method: "POST", body: JSON.stringify({ at: Date.now(), operation: "store.githubApp", args: {} }) });
  expect(unsigned.status).toBe(401);
  await expect(store("store.nope")).rejects.toThrow("400");
});
