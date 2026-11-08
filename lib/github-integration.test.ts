// @vitest-environment node
/// <reference types="vite/client" />
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { convexTest } from "convex-test";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { createSession } from "../convex/lib/auth";
import type { ConvexHttpClient } from "convex/browser";
import { NextRequest } from "next/server";
import { integrationBridge } from "./integration-bridge";
import { githubRequest, saveGitHubApp, saveGitHubJob, saveWorkspaceGitHub } from "./github-workspace";
import type * as GitHubWorkspace from "./github-workspace";
import { createGitHubTask, createProjectRepository, processGitHubWork, reconcileGitHubLifecycle, syncGitHubPage } from "./github-sync";
import { saveGitHubConnection, githubConnectionToken, deleteGitHubConnection, integrationDb } from "./githubConnection";
import { POST } from "../app/api/github/webhook/route";
import { createFakeGitHub } from "../testing/fake-github";

vi.mock("./integration-bridge", () => ({ integrationBridge: vi.fn(), originUrl: () => "http://127.0.0.1:1" }));
vi.mock("./github-workspace", async importOriginal => ({ ...await importOriginal<typeof GitHubWorkspace>(), githubRequest: vi.fn() }));
const backend = vi.hoisted(() => ({ client: null as unknown as ConvexHttpClient }));
vi.mock("next/server", async importOriginal => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("./localRealtime", async importOriginal => ({
  ...await importOriginal<typeof import("./localRealtime")>(),
  getConvexClient: () => backend.client,
  limitLocalAction: vi.fn(),
  requireLocalUser: async (sessionToken: string) => {
    const user = await backend.client.query(api.auth.me, { sessionToken });
    if (!user) throw new Error("Your session has expired. Sign in again.");
    return user;
  },
  requireLocalWorkspace: async (request: Request) => {
    const sessionToken = request.headers.get("authorization")!.slice(7);
    const teamId = new URL(request.url).searchParams.get("teamId") as Id<"teams">;
    const user = await backend.client.query(api.auth.me, { sessionToken });
    const access = await backend.client.query(api.workspaces.access, { sessionToken, teamId });
    return { ...user, teamId, workspaceRole: access.role, slug: access.slug };
  },
}));
const directory = mkdtempSync(path.join(tmpdir(), "origin-pg3-github-"));
process.env.ORIGIN_LOCAL_DATA_DIR = directory;
const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.test.ts"]);
const secret = "pg3-synthetic-signing-secret";
afterAll(() => { integrationDb().close(); rmSync(directory, { recursive: true, force: true }); delete process.env.ORIGIN_LOCAL_DATA_DIR; });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function fixture() {
  const db = integrationDb();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) db.exec(`DELETE FROM "${name}"`);
  vi.mocked(integrationBridge).mockClear();
  const t = convexTest(schema, modules);
  backend.client = { query: t.query, mutation: t.mutation, action: t.action } as unknown as ConvexHttpClient;
  const owner = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { email: "owner@pg3.test", name: "Owner", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: Date.now(), updatedAt: Date.now() });
    return { id, sessionToken: await createSession(ctx, id) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.sessionToken, name: "PG3 GitHub" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: owner.sessionToken, teamId, name: "PG3 GitHub project", repoUrl: "https://github.com/z4mbo/origin-pr-sandbox" });
  const columnId = (await t.query(api.tasks.board, { sessionToken: owner.sessionToken, projectId })).columns.find(column => !column.isDraft)!._id;
  const taskId = await t.mutation(api.tasks.createTask, { sessionToken: owner.sessionToken, projectId, columnId, title: "PG3 fixture issue", priority: "low", assignedToEmail: "owner@pg3.test", dueDate: "2026-12-31" });
  vi.mocked(integrationBridge).mockImplementation(async (operation, args) => {
    const input = args as Record<string, unknown>;
    switch (operation) {
      case "context": return JSON.parse(await t.query(internal.integrations.context, input as never));
      case "repoResult": return t.mutation(internal.integrations.repoResult, input as never);
      case "linkIssue": return t.mutation(internal.integrations.linkIssue, input as never);
      case "webhookTargets": return JSON.parse(await t.query(internal.integrations.webhookTargets, input as never));
      case "targets": return JSON.parse(await t.query(internal.integrations.targets, input as never));
      case "githubDelivery": return t.mutation(internal.taskPRs.delivery, input as never);
      case "lifecycleClaim": return JSON.parse(await t.mutation(internal.githubLifecycle.claim, input as never));
      case "lifecycleStart": return t.mutation(internal.githubLifecycle.start, input as never);
      case "lifecycleFinish": return t.mutation(internal.githubLifecycle.finish, input as never);
      case "lifecycleReconcile": return JSON.parse(await t.mutation(internal.githubLifecycle.reconcile, input as never));
      case "lifecycleIncoming": return t.mutation(internal.githubLifecycle.incoming, input as never);
      case "lifecycleProjects": return JSON.parse(await t.query(internal.githubLifecycle.projects, input as never));
      case "lifecycleError": return t.mutation(internal.githubLifecycle.syncError, input as never);
      case "lifecycleBegin": return t.mutation(internal.githubLifecycle.begin, input as never);
      default: throw new Error(`Unexpected bridge ${operation}`);
    }
  });
  saveGitHubApp({ clientId: "fixture", clientSecret: "fixture", webhookSecret: secret });
  saveGitHubConnection(projectId, "z4mbo/origin-pr-sandbox", "z4mbo", "fixture-repo-token", owner.id);
  let remote = { number: 42, node_id: "fixture-issue-42", title: "PG3 fixture issue", html_url: "https://github.com/z4mbo/origin-pr-sandbox/issues/42", state: "open", updated_at: "2026-10-15T10:00:00Z", body: `<!-- origin-task:${taskId} -->` };
  vi.mocked(githubRequest).mockImplementation(async (endpoint, token, init) => {
    expect(token).toBe("fixture-repo-token");
    if (endpoint === "/repos/z4mbo/origin-pr-sandbox") return { id: 5, full_name: "z4mbo/origin-pr-sandbox" };
    if (endpoint === "/graphql") return { data: { deleteIssue: { clientMutationId: "fixture" }, node: null } };
    expect(endpoint).toMatch(/^\/repos\/z4mbo\/origin-pr-sandbox\/issues/);
    if (init?.method === "PATCH") { remote = { ...remote, ...JSON.parse(init.body as string), updated_at: new Date(Date.parse(remote.updated_at) + 1000).toISOString() }; return remote; }
    if (init?.method === "POST") return remote;
    return endpoint.includes("?") ? [remote] : remote;
  });
  const webhook = (body: string, delivery: string = randomUUID(), signature?: string) => POST(new Request("http://localhost/api/github/webhook", { method: "POST", headers: { "x-github-event": "issues", "x-github-delivery": delivery, "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body }));
  const payload = JSON.stringify({ repository: { id: 5, full_name: "z4mbo/origin-pr-sandbox" }, issue: { node_id: "fixture-issue-42", number: 42, state: "open", updated_at: "2020-01-01T00:00:00Z" } });
  return { t, owner, teamId, projectId, taskId, columnId, webhook, payload, remote: (patch: Partial<typeof remote>) => { remote = { ...remote, ...patch }; }, task: () => t.run(ctx => ctx.db.get(taskId)) };
}

test("same-second reordered fetches cannot overwrite the latest GitHub edit", async () => {
  const f = await fixture();
  await createGitHubTask(f.projectId, f.taskId);
  const identity = { projectId: f.projectId, repoUrl: "https://github.com/z4mbo/origin-pr-sandbox", number: 42 };
  const older = await f.t.mutation(internal.githubLifecycle.begin, identity);
  const newer = await f.t.mutation(internal.githubLifecycle.begin, identity);
  const remote = { ...identity, repoId: 5, nodeId: "fixture-issue-42", taskId: f.taskId, state: "open" as const, description: "Newest body", updatedAt: Date.parse("2026-10-15T12:00:00Z") };
  await f.t.mutation(internal.githubLifecycle.incoming, { ...remote, sequence: newer, title: "Latest title" });
  await f.t.mutation(internal.githubLifecycle.incoming, { ...remote, sequence: older, title: "Stale same-second title" });
  expect(await f.task()).toMatchObject({ title: "Latest title", description: "Newest body" });
});

test("GitHub-created issues are imported with title, body and completion without duplicate Origin records", async () => {
  const f = await fixture();
  f.remote({ number: 70, node_id: "fixture-issue-70", html_url: "https://github.com/z4mbo/origin-pr-sandbox/issues/70", title: "Created on GitHub", body: "Remote description", state: "closed" });
  const payload = JSON.parse(f.payload);
  payload.issue.number = 70; payload.issue.node_id = "fixture-issue-70";
  expect((await f.webhook(JSON.stringify(payload))).status).toBe(200);
  expect((await f.webhook(JSON.stringify(payload))).status).toBe(200);
  const board = await f.t.query(api.tasks.board, { sessionToken: f.owner.sessionToken, projectId: f.projectId });
  expect(board.tasks.filter(task => task.githubIssueNumber === 70)).toEqual([expect.objectContaining({ title: "Created on GitHub", description: "Remote description", done: true })]);
});

test("revoked admin access during a remote read blocks the following outgoing mutation", async () => {
  const f = await fixture();
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => {
    if (args[0] === "/repos/z4mbo/origin-pr-sandbox") await f.t.run(async ctx => {
      const member = await ctx.db.query("teamMembers").withIndex("by_user", q => q.eq("userId", f.owner.id)).first();
      await ctx.db.patch(member!._id, { role: "viewer" });
    });
    return request(...args);
  });
  await expect(processGitHubWork()).rejects.toThrow("authorization changed");
  expect(vi.mocked(githubRequest).mock.calls.some(call => call[2]?.method === "POST")).toBe(false);
  expect(await f.task()).toMatchObject({ githubSyncState: "error" });
});

test("Draft creation, edits, complete/reopen and true deletion use one durable issue identity", async () => {
  const f = await fixture(), scope = { sessionToken: f.owner.sessionToken, projectId: f.projectId };
  const draft = (await f.t.query(api.tasks.board, scope)).columns.find(column => column.isDraft)!;
  await f.t.mutation(api.tasks.moveTask, { ...scope, taskId: f.taskId, columnId: draft._id });
  await reconcileGitHubLifecycle();
  expect(await f.task()).toMatchObject({ githubIssueNumber: 42, githubSyncState: "synced", columnId: draft._id });
  await f.t.mutation(api.tasks.updateTask, { ...scope, taskId: f.taskId, title: "Edited Draft", description: "Updated body" });
  await processGitHubWork();
  expect(await f.task()).toMatchObject({ title: "Edited Draft", description: "Updated body", githubSyncState: "synced" });
  await f.t.mutation(api.tasks.updateTask, { ...scope, taskId: f.taskId, done: true });
  await processGitHubWork();
  expect(await f.task()).toMatchObject({ done: true, githubIssueState: "closed" });
  await f.t.mutation(api.tasks.updateTask, { ...scope, taskId: f.taskId, done: false });
  await processGitHubWork();
  expect(await f.task()).toMatchObject({ done: false, githubIssueState: "open", githubIssueNumber: 42 });
  await f.t.mutation(api.tasks.deleteTask, { ...scope, taskId: f.taskId });
  expect(await f.task()).toBeNull();
  vi.mocked(githubRequest).mockClear();
  await processGitHubWork();
  expect(githubRequest).toHaveBeenCalledWith("/graphql", "fixture-repo-token", expect.objectContaining({ body: expect.stringContaining("deleteIssue") }));
  expect(vi.mocked(githubRequest).mock.calls.some(call => call[2]?.method === "PATCH")).toBe(false);
  expect(await f.t.query(api.githubLifecycle.status, scope)).toEqual([expect.objectContaining({ taskId: f.taskId, deleted: true, state: "synced" })]);
  await reconcileGitHubLifecycle(); // An old remote echo must not resurrect a deleted Origin issue.
  expect((await f.t.query(api.tasks.board, scope)).tasks).toHaveLength(0);
});

test("incoming GitHub title/body updates and signed deletion survive duplicate and reordered events", async () => {
  const f = await fixture();
  await createGitHubTask(f.projectId, f.taskId);
  f.remote({ title: "GitHub edit", body: "Remote body", updated_at: "2026-10-15T12:00:00Z" });
  expect((await f.webhook(f.payload)).status).toBe(200);
  expect(await f.task()).toMatchObject({ title: "GitHub edit", description: "Remote body" });
  const payload = JSON.parse(f.payload);
  payload.action = "deleted"; payload.issue.updated_at = "2026-10-15T13:00:00Z";
  const deletion = JSON.stringify(payload), delivery = randomUUID();
  expect((await f.webhook(deletion, delivery)).status).toBe(200);
  expect(await f.task()).toBeNull();
  expect(await (await f.webhook(deletion, delivery)).json()).toMatchObject({ duplicate: true });
  expect((await f.webhook(f.payload)).status).toBe(200);
  expect((await f.t.query(api.tasks.board, { sessionToken: f.owner.sessionToken, projectId: f.projectId })).tasks).toHaveLength(0);
});

test("repository identity changes and deletion failures stay visible without modifying another repository", async () => {
  const f = await fixture(), scope = { sessionToken: f.owner.sessionToken, projectId: f.projectId };
  await createGitHubTask(f.projectId, f.taskId);
  await f.t.mutation(api.tasks.deleteTask, { ...scope, taskId: f.taskId });
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  vi.mocked(githubRequest).mockImplementation(async (...args) => args[0] === "/graphql" ? { errors: [{ message: "Denied" }] } : request(...args));
  await expect(processGitHubWork()).rejects.toThrow("did not delete");
  expect(await f.t.query(api.githubLifecycle.status, scope)).toEqual([expect.objectContaining({ deleted: true, state: "error", error: expect.stringContaining("not closed") })]);
  await f.t.mutation(api.githubLifecycle.retry, { ...scope, taskId: f.taskId });
  await f.t.run(ctx => ctx.db.patch(f.projectId, { githubRepoId: 99 }));
  vi.mocked(githubRequest).mockClear();
  await expect(processGitHubWork()).rejects.toThrow("identity changed");
  expect(vi.mocked(githubRequest).mock.calls.some(call => call[2]?.method === "POST" || call[2]?.method === "PATCH")).toBe(false);
});

test("in-flight edits and deletion retain the first creation receipt across lease recovery", async () => {
  const f = await fixture(), scope = { sessionToken: f.owner.sessionToken, projectId: f.projectId };
  const first = JSON.parse(await f.t.mutation(internal.githubLifecycle.claim, {}));
  await f.t.mutation(internal.githubLifecycle.start, { id: first._id, lease: first.lease, repoId: 5, create: true });
  await f.t.mutation(api.tasks.updateTask, { ...scope, taskId: f.taskId, title: "Concurrent edit" });
  await f.t.mutation(api.tasks.deleteTask, { ...scope, taskId: f.taskId });
  await f.t.mutation(internal.githubLifecycle.finish, { id: first._id, lease: first.lease, revision: first.revision, number: 42, nodeId: "fixture-issue-42", updatedAt: 1000 });
  const next = JSON.parse(await f.t.mutation(internal.githubLifecycle.claim, {}));
  expect(next).toMatchObject({ deleted: true, number: 42, title: "Concurrent edit" });
  await f.t.mutation(internal.githubLifecycle.finish, { id: first._id, lease: first.lease, revision: first.revision, error: "stale result" });
  expect((await f.t.query(api.githubLifecycle.status, scope))[0]).toMatchObject({ state: "syncing" });
});

test("PG3 O-118: ambiguous create reconciles the marker; retries and durable issue link do not duplicate", async () => {
  const f = await fixture();
  const request = vi.mocked(githubRequest).getMockImplementation()!;
  let posts = 0;
  vi.mocked(githubRequest).mockImplementation(async (...args) => {
    if (args[2]?.method === "POST" && ++posts === 1) throw new TypeError("response lost after remote creation");
    return request(...args);
  });
  await expect(createGitHubTask(f.projectId, f.taskId)).rejects.toThrow("response lost");
  await f.t.mutation(api.githubLifecycle.retry, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId: f.taskId });
  expect(await createGitHubTask(f.projectId, f.taskId)).toMatchObject({ ok: true, issueNumber: 42 });
  expect(await createGitHubTask(f.projectId, f.taskId)).toMatchObject({ ok: true, issueNumber: 42 });
  expect(posts).toBe(1);
  expect(await f.task()).toMatchObject({ githubIssueNumber: 42, githubIssueUrl: `${"https://github.com/z4mbo/origin-pr-sandbox"}/issues/42`, columnId: f.columnId });
});

test("PG3 O-119/O-120: signed webhook, dedupe, invalid delivery/HMAC, polling and close/reopen preserve columns", async () => {
  const f = await fixture();
  await createGitHubTask(f.projectId, f.taskId);
  await f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId: f.taskId, done: true });
  const id = randomUUID();
  const accepted = await f.webhook(f.payload, id);
  const results = await Promise.allSettled(vi.mocked(integrationBridge).mock.results.map(result => result.value));
  expect(accepted.status, results.map(result => result.status === "rejected" ? String(result.reason) : "ok").join("; ")).toBe(200);
  expect(await f.task()).toMatchObject({ done: true, columnId: f.columnId, githubIssueState: "open" });
  vi.mocked(githubRequest).mockClear();
  expect(await (await f.webhook(f.payload, id)).json()).toMatchObject({ duplicate: true });
  expect(githubRequest).not.toHaveBeenCalled();
  expect((await f.webhook(f.payload, randomUUID(), "sha256=" + "0".repeat(64))).status).toBe(401);
  expect((await f.webhook(f.payload, "bad delivery")).status).toBe(400);
  expect((await f.webhook("{" )).status).toBe(400);
  f.remote({ state: "closed", updated_at: "2026-10-15T11:00:00Z" });
  expect((await f.webhook(f.payload)).status).toBe(200);
  expect(await f.task()).toMatchObject({ done: true, columnId: f.columnId, githubIssueState: "closed" });
  f.remote({ state: "open", updated_at: "2026-10-15T12:00:00Z" });
  await syncGitHubPage();
  expect(await f.task()).toMatchObject({ done: false, columnId: f.columnId, githubIssueState: "open" });
  expect(await f.t.query(api.projects.get, { sessionToken: f.owner.sessionToken, projectId: f.projectId })).toMatchObject({ openIssueCount: 1 });
  f.remote({ state: "closed", updated_at: "2026-10-15T09:00:00Z" });
  expect((await f.webhook(f.payload)).status).toBe(200);
  expect(await f.task()).toMatchObject({ done: false, githubIssueState: "open" });
});

test("PG3 O-112/O-113: encrypted repo connection is owner-bound; revoked admin cannot create an issue", async () => {
  const f = await fixture();
  expect(githubConnectionToken(f.projectId, "z4mbo/origin-pr-sandbox")).toBe("fixture-repo-token");
  expect(githubConnectionToken(f.projectId, "z4mbo/other")).toBeUndefined();
  expect(JSON.stringify(integrationDb().prepare("SELECT * FROM github_connections").all())).not.toContain("fixture-repo-token");
  await f.t.run(async ctx => {
    const membership = await ctx.db.query("teamMembers").withIndex("by_user", q => q.eq("userId", f.owner.id)).first();
    await ctx.db.patch(membership!._id, { role: "viewer" });
  });
  vi.mocked(githubRequest).mockClear();
  await expect(createGitHubTask(f.projectId, f.taskId)).rejects.toThrow(/authorized GitHub connection/);
  expect(githubRequest).not.toHaveBeenCalled();
  deleteGitHubConnection(f.projectId);
  expect(githubConnectionToken(f.projectId, "z4mbo/origin-pr-sandbox")).toBeUndefined();
});

test("PG3 O-114/O-115: automatic private repo intent reconciles a lost response without another POST", async () => {
  const f = await fixture();
  await f.t.mutation(api.integrations.configure, { sessionToken: f.owner.sessionToken, teamId: f.teamId, login: "z4mbo", autoCreate: false });
  expect(await f.t.query(api.integrations.status, { sessionToken: f.owner.sessionToken, teamId: f.teamId })).toMatchObject({ autoCreate: false });
  await f.t.mutation(api.integrations.configure, { sessionToken: f.owner.sessionToken, teamId: f.teamId, login: "z4mbo", autoCreate: true });
  saveWorkspaceGitHub(f.teamId, "z4mbo", 1, f.owner.id, { access_token: "fixture-workspace-token" });
  const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.owner.sessionToken, teamId: f.teamId, name: "Auto private PG3 project" });
  expect(await f.t.query(api.projects.get, { sessionToken: f.owner.sessionToken, projectId })).toMatchObject({ githubRepoState: "pending" });
  const repo = { id: 123, html_url: "https://github.com/z4mbo/fixture", description: `Origin project: ${projectId}`, owner: { login: "z4mbo" }, private: true };
  let posts = 0;
  vi.mocked(githubRequest).mockImplementation(async (endpoint, token, init) => {
    expect(token).toBe("fixture-workspace-token");
    if (init?.method === "POST") {
      expect(endpoint).toBe("/user/repos");
      expect(JSON.parse(init.body as string)).toMatchObject({ private: true, has_issues: true, auto_init: true, description: expect.stringContaining(`Origin project: ${projectId}`) });
      posts++; throw new TypeError("response lost after creation");
    }
    return repo;
  });
  expect(await createProjectRepository(projectId)).toMatchObject({ state: "error" });
  expect(await createProjectRepository(projectId)).toMatchObject({ state: "ready", repoUrl: repo.html_url });
  expect(posts).toBe(1);
  expect(await f.t.query(api.projects.get, { sessionToken: f.owner.sessionToken, projectId })).toMatchObject({ githubRepoState: "ready", githubRepoId: repo.id });
  saveGitHubJob(`repo:${projectId}`, "done");
});

test("PG3 O-121: snapshot import preserves issue/PR fields and legacy create uses the durable queue", async () => {
  const f = await fixture();
  const repoUrl = "https://github.com/z4mbo/origin-pr-sandbox";
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const endpoint = String(url);
    expect(endpoint).toMatch(/^https:\/\/api.github.com\/repos\/z4mbo\/origin-pr-sandbox\//);
    return Response.json(endpoint.includes("/issues?") ? [{ number: 51, title: "Imported issue", body: "Imported description", state: "open", html_url: `${repoUrl}/issues/51`, updated_at: "2026-10-15T12:00:00Z", user: { login: "fixture-author" } }, { number: 52, title: "PR omitted from issues", pull_request: {} }] : [{ number: 52, title: "Imported PR", state: "closed", merged_at: "2026-10-15T12:00:00Z", html_url: `${repoUrl}/pull/52`, created_at: "2026-10-15T11:00:00Z", updated_at: "2026-10-15T12:00:00Z", user: { login: "fixture-author" }, head: { ref: "origin/fixture" } }]);
  });
  vi.stubGlobal("fetch", fetcher);
  const args = { projectId: f.projectId, sessionToken: f.owner.sessionToken };
  expect(await f.t.action(api.github.syncRepo, args)).toMatchObject({ ok: true, issueCount: 1, pullRequestCount: 1 });
  expect(await f.t.query(api.github.listPullRequests, args)).toEqual([expect.objectContaining({ number: 52, state: "merged", branch: "origin/fixture", author: "fixture-author", url: `${repoUrl}/pull/52` })]);
  const board = await f.t.query(api.tasks.board, args);
  expect(board.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Imported issue", description: "Imported description", githubIssueNumber: 51, githubIssueUrl: `${repoUrl}/issues/51`, done: false })]));
  expect(board.tasks.some(row => row.title === "PR omitted from issues")).toBe(false);
  expect(await f.t.action(api.github.createIssueForTask, { ...args, taskId: f.taskId })).toMatchObject({ ok: false, manualUrl: "", message: expect.stringContaining("queued") });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValue(new Response(null, { status: 404 }));
  expect(await f.t.action(api.github.syncRepo, args)).toMatchObject({ ok: false, error: expect.stringContaining("Repo not found") });
});

test("HTTP OAuth connects new workspaces to shared GitHub with isolated reconnect and disconnect", async () => {
  const f = await fixture();
  const fake = await createFakeGitHub(), userToken = fake.user("z4mbo", 1);
  const oauth = await import("../app/api/github/oauth/[step]/route");
  const workspace = await import("../app/api/github/workspace/route");
  const actual = await vi.importActual<typeof GitHubWorkspace>("./github-workspace");
  vi.mocked(githubRequest).mockImplementation(actual.githubRequest);
  vi.stubEnv("ORIGIN_SEALING_KEY", Buffer.alloc(32, 17).toString("base64"));
  saveGitHubApp({ clientId: "fixture-id", clientSecret: "fixture-secret", slug: fake.slug, appId: fake.appId, privateKey: fake.privateKeyPem });
  const context = (step: string) => ({ params: Promise.resolve({ step }) });
  const start = async (teamId = f.teamId) => {
    const project = teamId === f.teamId ? `&projectId=${f.projectId}` : "";
    const response = await oauth.POST(new NextRequest(`http://127.0.0.1:1/api/github/oauth/start?teamId=${teamId}${project}`, { method: "POST", headers: { authorization: `Bearer ${f.owner.sessionToken}` } }), context("start"));
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { state: url.searchParams.get("state")!, cookie, challenge: url.searchParams.get("code_challenge") };
  };
  const callback = (state: string, cookie: string) => oauth.GET(new NextRequest(`http://127.0.0.1:1/api/github/oauth/callback?state=${state}&code=fixture-code`, { headers: { cookie } }), context("callback"));
  const exchanges: Record<string, string>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init);
    if (request.url === "https://github.com/login/oauth/access_token") {
      exchanges.push(await request.json());
      return Response.json({ access_token: userToken, expires_in: 7200 });
    }
    return fake.handle(request);
  }));
  const first = await start();
  expect((await callback("wrong-state", first.cookie)).headers.get("location")).toContain("connection-failed");
  expect((await callback(first.state, "origin.github=wrong-browser")).headers.get("location")).toContain("connection-failed");
  expect(exchanges).toHaveLength(0);
  const installation = await callback(first.state, first.cookie);
  expect(installation.headers.get("location")).toContain("/installations/new?state=");
  const state = new URL(installation.headers.get("location")!).searchParams.get("state")!;
  const cookie = installation.headers.get("set-cookie")!.split(";")[0];
  fake.install("z4mbo", 1);
  const installReturn = await oauth.GET(new NextRequest(`http://127.0.0.1:1/api/github/oauth/install?state=${state}`, { headers: { cookie } }), context("install"));
  expect(installReturn.headers.get("location")).toContain("code_challenge_method=S256");
  expect((await callback(state, cookie)).headers.get("location")).toContain("github=connected");
  const { createHash } = await import("node:crypto");
  expect(createHash("sha256").update(exchanges[0].code_verifier).digest("base64url")).toBe(first.challenge);
  const status = (teamId: Id<"teams">) => f.t.query(api.teamGitHub.status, { sessionToken: f.owner.sessionToken, teamId });
  expect((await status(f.teamId)).shared).toMatchObject({ accountLogin: "z4mbo" });
  expect((await callback(state, cookie)).headers.get("location")).toContain("connection-failed");

  const second = await f.t.mutation(api.workspaces.create, { sessionToken: f.owner.sessionToken, name: "Second workspace" });
  expect((await status(second.teamId)).shared).toBeNull();
  const secondConnect = await start(second.teamId);
  expect((await callback(secondConnect.state, secondConnect.cookie)).headers.get("location")).toContain("github=connected");
  const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.owner.sessionToken, teamId: second.teamId, name: "Second workspace app", githubRepo: "later" });
  expect(await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.owner.sessionToken, projectId })).toEqual({ state: "ready", repoUrl: "https://github.com/z4mbo/Second-workspace-app" });
  const reconnect = await start(second.teamId);
  expect((await callback(reconnect.state, reconnect.cookie)).headers.get("location")).toContain("github=connected");
  const disconnected = await workspace.DELETE(new Request(`http://127.0.0.1:1/api/github/workspace?teamId=${second.teamId}`, { method: "DELETE", headers: { authorization: `Bearer ${f.owner.sessionToken}` } }));
  expect(disconnected.status).toBe(200);
  expect((await status(second.teamId)).shared).toBeNull();
  expect((await status(f.teamId)).shared).toMatchObject({ accountLogin: "z4mbo" });
  expect(await f.t.query(api.projects.get, { sessionToken: f.owner.sessionToken, projectId })).toMatchObject({ repoUrl: "https://github.com/z4mbo/Second-workspace-app" });

  const stale = await start();
  vi.stubGlobal("fetch", vi.fn(async () => {
    await f.t.run(async ctx => {
      const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", f.teamId).eq("email", "owner@pg3.test")).unique();
      await ctx.db.patch(member!._id, { role: "viewer" });
    });
    return Response.json({ access_token: "must-not-store-revoked-token" });
  }));
  expect((await callback(stale.state, stale.cookie)).headers.get("location")).toContain("connection-failed");
  expect((await status(f.teamId)).shared).toBeNull();
});

test("PG3 R2 O-112 HTTP token connection validates account/repo, admin, encryption and disconnect", async () => {
  const f = await fixture();
  deleteGitHubConnection(f.projectId);
  const route = await import("../app/api/github/connection/route");
  const request = (method: string, token = "fixture-private-token-123456", sessionToken = f.owner.sessionToken) => new Request(`http://127.0.0.1:1/api/github/connection?projectId=${f.projectId}`, { method, headers: { authorization: `Bearer ${sessionToken}` }, ...(method === "POST" ? { body: JSON.stringify({ token }) } : {}) });
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/user") ? Response.json({ login: "z4mbo" }) : Response.json({ full_name: "z4mbo/origin-pr-sandbox" }));
  vi.stubGlobal("fetch", fetcher);
  expect((await route.POST(request("POST", "short"))).status).toBe(400);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await route.POST(request("POST"))).status).toBe(400);
  fetcher.mockResolvedValueOnce(Response.json({ login: "z4mbo" })).mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect((await route.POST(request("POST"))).status).toBe(400);
  expect((await route.POST(request("POST", undefined, "wrong-session"))).status).toBe(400);
  const connected = await route.POST(request("POST"));
  expect(connected.status).toBe(200);
  expect(JSON.stringify(await connected.json())).not.toContain("fixture-private-token");
  expect(await (await route.GET(request("GET"))).json()).toMatchObject({ connection: { login: "z4mbo", source: "project" } });
  expect(githubConnectionToken(f.projectId, "z4mbo/origin-pr-sandbox")).toBe("fixture-private-token-123456");
  expect((await route.DELETE(request("DELETE"))).status).toBe(200);
  expect(await (await route.GET(request("GET"))).json()).toEqual({ connection: null });
});

test("PG3 R2 O-112 token connection cannot store credentials after membership revocation during verification", async () => {
  const f = await fixture();
  deleteGitHubConnection(f.projectId);
  const route = await import("../app/api/github/connection/route");
  vi.stubGlobal("fetch", vi.fn(async () => {
    await f.t.run(async ctx => {
      const member = await ctx.db.query("teamMembers").withIndex("by_user", q => q.eq("userId", f.owner.id)).first();
      await ctx.db.patch(member!._id, { status: "invited" });
    });
    return Response.json({ login: "z4mbo" });
  }));
  const response = await route.POST(new Request(`http://127.0.0.1:1/api/github/connection?projectId=${f.projectId}`, { method: "POST", headers: { authorization: `Bearer ${f.owner.sessionToken}` }, body: JSON.stringify({ token: "must-not-store-revoked-token" }) }));
  expect(response.status).toBe(400);
  expect(githubConnectionToken(f.projectId, "z4mbo/origin-pr-sandbox")).toBeUndefined();
});

test("PG3 R2 O-113 repository approval checks current admin/repo; failed provisioning can retry with error cleared", async () => {
  const f = await fixture();
  await expect(f.t.mutation(api.integrations.approveRepository, { sessionToken: f.owner.sessionToken, projectId: f.projectId, repoUrl: "https://github.com/z4mbo/other" })).rejects.toThrow("Repository changed");
  const membership = await f.t.run(async ctx => (await ctx.db.query("teamMembers").withIndex("by_user", q => q.eq("userId", f.owner.id)).first())!);
  await f.t.run(ctx => ctx.db.patch(membership._id, { role: "member" }));
  await expect(f.t.mutation(api.integrations.approveRepository, { sessionToken: f.owner.sessionToken, projectId: f.projectId })).rejects.toThrow();
  await f.t.run(ctx => ctx.db.patch(membership._id, { role: "owner" }));
  await f.t.mutation(api.integrations.approveRepository, { sessionToken: f.owner.sessionToken, projectId: f.projectId, repoUrl: "https://github.com/z4mbo/origin-pr-sandbox" });
  expect(await f.t.query(api.projects.get, { sessionToken: f.owner.sessionToken, projectId: f.projectId })).toMatchObject({ githubWorkspaceAccess: true });
  const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.owner.sessionToken, teamId: f.teamId, name: "Failed repo retry" });
  await f.t.mutation(internal.integrations.repoResult, { projectId, state: "error", error: "Injected vendor failure" });
  await f.t.mutation(api.integrations.retryRepo, { sessionToken: f.owner.sessionToken, projectId });
  const project = await f.t.query(api.projects.get, { sessionToken: f.owner.sessionToken, projectId });
  expect(project).toMatchObject({ githubRepoState: "pending" });
  expect(project.githubRepoError).toBeUndefined();
});

test("PG3 R2 O-116 HTTP repository fixture returns 30 commits/issues and 20 PRs with states and unavailable result", async () => {
  const f = await fixture();
  const { GET } = await import("../app/api/github/repo/route");
  const repo = "https://github.com/z4mbo/origin-pr-sandbox";
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("/commits?")) return Response.json(Array.from({ length: 30 }, (_, i) => ({ sha: i.toString(16).padStart(40, "0"), html_url: `${repo}/commit/${i}`, commit: { message: `Commit ${i}\nDetails`, author: { name: "Fixture", date: "2026-10-15T12:00:00Z" } } })));
    const pulls = path.includes("/pulls?");
    return Response.json(Array.from({ length: pulls ? 20 : 30 }, (_, i) => ({ number: i + 1, title: `${pulls ? "PR" : "Issue"} ${i}`, state: i % 2 ? "closed" : "open", ...(pulls && i === 1 ? { merged_at: "2026-10-15T12:00:00Z" } : {}), html_url: `${repo}/${pulls ? "pull" : "issues"}/${i + 1}`, updated_at: "2026-10-15T12:00:00Z", user: { login: "Fixture" }, head: { ref: `branch-${i}` } })));
  });
  vi.stubGlobal("fetch", fetcher);
  const request = () => new Request(`http://127.0.0.1:1/api/github/repo?projectId=${f.projectId}`, { headers: { authorization: `Bearer ${f.owner.sessionToken}` } });
  const response = await GET(request());
  expect(response.status).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.commits).toHaveLength(30); expect(snapshot.issues).toHaveLength(30); expect(snapshot.pullRequests).toHaveLength(20);
  expect(snapshot.pullRequests[1]).toMatchObject({ state: "merged", url: `${repo}/pull/2` });
  expect(snapshot.commits[0].message).toBe("Commit 0");
  fetcher.mockResolvedValue(new Response(null, { status: 403 }));
  expect(await (await GET(request())).json()).toMatchObject({ error: expect.stringContaining("GitHub denied access") });
});
