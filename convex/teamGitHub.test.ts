/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import { createFakeGitHub, mergedPull, type FakeGitHub } from "../testing/fake-github";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const SEALING_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 1)));

let fake: FakeGitHub;
beforeEach(async () => {
  fake = await createFakeGitHub();
  vi.stubEnv("ORIGIN_SEALING_KEY", SEALING_KEY);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com" && url.origin !== "https://github.com") throw new Error(`Unexpected fetch ${url.origin}`);
    return fake.handle(request);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function fixture() {
  const t = convexTest(schema, modules);
  const person = (email: string) => t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: email.split("@")[0], email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return { userId, token: await createSession(ctx, userId) };
  });
  const owner = await person("owner@test.dev");
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.token, name: "Acme" });
  const join = async (email: string, role: "admin" | "member" | "viewer") => {
    const user = await person(email);
    await t.run((ctx) => ctx.db.insert("teamMembers", { teamId, userId: user.userId, email, name: email, role, status: "active", createdAt: 1, updatedAt: 1 }));
    return user;
  };
  const member = await join("member@test.dev", "member");
  const viewer = await join("viewer@test.dev", "viewer");
  const grant = (projectId: Id<"projects">, user: { userId: Id<"users"> }, email: string, role: "member" | "viewer") =>
    t.run((ctx) => ctx.db.insert("members", { projectId, userId: user.userId, email, name: email, role, status: "active", createdAt: 1, updatedAt: 1 }));
  const ownerGitHub = fake.user("octo", 7);
  fake.install("octo", 7);
  const app = { appId: fake.appId, privateKey: fake.privateKeyPem, clientId: "Iv1.client", clientSecret: "client-secret", slug: fake.slug, webhookSecret: "hook" };
  const share = (sessionToken = owner.token) => t.action(api.teamGitHub.share, { sessionToken, teamId, app, token: { access_token: ownerGitHub } });
  return { t, teamId, owner, member, viewer, grant, share, ownerGitHub };
}

describe("workspace GitHub held by the backend", () => {
  test("an admin shares once; every member sees who shared it and the secrets stay sealed", async () => {
    const f = await fixture();
    expect((await f.t.query(api.teamGitHub.status, { sessionToken: f.member.token, teamId: f.teamId })).shared).toBeNull();
    await expect(f.share(f.member.token)).rejects.toThrow("owner or admin");
    vi.stubEnv("ORIGIN_SEALING_KEY", "");
    await expect(f.share()).rejects.toThrow("ORIGIN_SEALING_KEY");
    vi.stubEnv("ORIGIN_SEALING_KEY", SEALING_KEY);
    expect(await f.share()).toEqual({ accountLogin: "octo" });
    const status = await f.t.query(api.teamGitHub.status, { sessionToken: f.member.token, teamId: f.teamId });
    expect(status.shared).toMatchObject({ accountLogin: "octo", accountType: "User", sharedByName: "owner" });
    expect(status.canManage).toBe(false);
    const row = await f.t.run((ctx) => ctx.db.query("teamGitHub").first());
    expect(row?.sealed).not.toContain(f.ownerGitHub);
    expect(row?.sealed).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  test("revocation during GitHub authorization cannot persist a workspace connection", async () => {
    const f = await fixture();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await fake.handle(request);
      if (new URL(request.url).pathname === "/users/octo/installation") {
        await f.t.run(async ctx => {
          const member = await ctx.db.query("teamMembers").withIndex("by_team_email", q => q.eq("teamId", f.teamId).eq("email", "owner@test.dev")).unique();
          await ctx.db.patch(member!._id, { role: "member" });
        });
      }
      return response;
    });
    await expect(f.share()).rejects.toThrow("administrator access changed");
    expect((await f.t.query(api.teamGitHub.status, { sessionToken: f.owner.token, teamId: f.teamId })).shared).toBeNull();
  });

  test("a member creates the project's repository with the visibility chosen at creation", async () => {
    const f = await fixture();
    await f.share();
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Launch Site", githubRepo: "later", githubRepoVisibility: "public" });
    const result = await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.member.token, projectId });
    expect(result).toEqual({ state: "ready", repoUrl: "https://github.com/octo/Launch-Site" });
    expect(fake.repos.get("octo/launch-site")?.private).toBe(false);
    const project = await f.t.run((ctx) => ctx.db.get(projectId));
    expect(project).toMatchObject({ repoUrl: "https://github.com/octo/Launch-Site", githubWorkspaceAccess: true, githubRepoState: "ready" });
    expect(await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.member.token, projectId })).toEqual({ state: "ready", repoUrl: "https://github.com/octo/Launch-Site" });
  });

  test("a repository name another project already uses is refused instead of adopted", async () => {
    const f = await fixture();
    await f.share();
    fake.addRepository("octo", "Taken", { description: "someone else's" });
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.owner.token, teamId: f.teamId, name: "Taken", githubRepo: "later" });
    const result = await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.owner.token, projectId });
    expect(result).toEqual({ state: "error", error: "octo/Taken already exists on GitHub. Choose another repository name." });
  });

  test("tokens are scoped to the project's repository and to the caller's role", async () => {
    const f = await fixture();
    await f.share();
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.owner.token, teamId: f.teamId, name: "App", githubRepo: "later" });
    await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.owner.token, projectId });
    await f.grant(projectId, f.member, "member@test.dev", "member");
    await f.grant(projectId, f.viewer, "viewer@test.dev", "viewer");
    const bridge = (sessionToken: string, operation: string, args: Record<string, unknown>) => f.t.action(api.teamGitHub.bridge, { sessionToken, operation, args });
    const write = await bridge(f.member.token, "githubToken", { projectId, access: "push" }) as { token: string; repoUrl: string };
    expect(write.repoUrl).toBe("https://github.com/octo/App");
    expect(fake.tokenScope(write.token)).toEqual({ repositories: ["app"], permissions: { contents: "write" } });
    const read = await bridge(f.viewer.token, "githubToken", { projectId, access: "read" }) as { token: string };
    expect(fake.tokenScope(read.token)?.permissions.contents).toBe("read");
    await expect(bridge(f.viewer.token, "githubToken", { projectId, access: "write" })).rejects.toThrow("You have view-only access");
    await expect(bridge(f.viewer.token, "githubToken", { projectId, access: "read", extra: { actions: "write" } })).rejects.toThrow("You have view-only access");
    await expect(bridge(f.member.token, "githubToken", { projectId, access: "write", extra: { administration: "write" } })).rejects.toThrow("Actions");
    await expect(bridge(f.member.token, "repoResult", { projectId, state: "ready", repoUrl: "https://github.com/octo/other" })).rejects.toThrow("not available");
  });

  test("a repository a member linked needs an admin's approval before it gets a token", async () => {
    const f = await fixture();
    await f.share();
    fake.addRepository("octo", "secret-plans");
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Sneaky", repoUrl: "https://github.com/octo/secret-plans" });
    await expect(f.t.action(api.teamGitHub.bridge, { sessionToken: f.member.token, operation: "githubToken", args: { projectId, access: "read" } })).rejects.toThrow("approves this repository");
  });

  test("issue links are read back from GitHub, never taken from the member's server", async () => {
    const f = await fixture();
    await f.share();
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Board", githubRepo: "later" });
    await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.member.token, projectId });
    const board = await f.t.query(api.tasks.board, { sessionToken: f.member.token, projectId }) as { columns: { _id: Id<"columns">; title: string; isDraft?: boolean }[] };
    const todo = board.columns.find((column) => !column.isDraft)!;
    const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.member.token, projectId, columnId: todo._id, title: "Ship it", priority: "medium", assignedToEmail: "member@test.dev", dueDate: "2030-01-01" });
    const repo = fake.repos.get("octo/board")!;
    repo.issues.push({ number: 1, title: "Other", body: "unrelated", state: "open", updated_at: new Date().toISOString(), author: "x" });
    const link = (number: number) => f.t.action(api.teamGitHub.bridge, { sessionToken: f.member.token, operation: "linkIssue", args: { projectId, taskId, number, state: "closed", updatedAt: Date.now() } });
    await expect(link(1)).rejects.toThrow("does not belong");
    repo.issues.push({ number: 2, title: "Ship it", body: `<!-- origin-task:${taskId} -->`, state: "open", updated_at: new Date().toISOString(), author: "x" });
    await link(2);
    const task = await f.t.run((ctx) => ctx.db.get(taskId));
    expect(task).toMatchObject({ githubIssueNumber: 2, githubIssueState: "open" });
  });

  test("a merge receipt needs a project admin and GitHub's own record of the merge", async () => {
    const f = await fixture();
    await f.share();
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.owner.token, teamId: f.teamId, name: "Merge", githubRepo: "later" });
    await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.owner.token, projectId });
    await f.grant(projectId, f.member, "member@test.dev", "member");
    const repo = fake.repos.get("octo/merge")!;
    const pull = mergedPull(repo, 1);
    const args = { projectId, taskId: "x", repoUrl: "https://github.com/octo/Merge", issueNumber: 1, pullRequest: { number: pull.number, headSha: pull.head.sha, mergeSha: "0".repeat(40), mergedAt: Date.now() } };
    await expect(f.t.action(api.teamGitHub.bridge, { sessionToken: f.member.token, operation: "completeMergedIssue", args })).rejects.toThrow("project admin");
  });

  test("the connection stops when the admin who shared it leaves, and an admin can remove it", async () => {
    const f = await fixture();
    await f.share();
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("teamMembers").withIndex("by_team_email", (q) => q.eq("teamId", f.teamId).eq("email", "owner@test.dev")).unique();
      await ctx.db.patch(row!._id, { role: "member" });
    });
    const status = await f.t.query(api.teamGitHub.status, { sessionToken: f.member.token, teamId: f.teamId });
    expect(status).toMatchObject({ shared: null, stale: true });
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("teamMembers").withIndex("by_team_email", (q) => q.eq("teamId", f.teamId).eq("email", "owner@test.dev")).unique();
      await ctx.db.patch(row!._id, { role: "owner" });
    });
    await expect(f.t.mutation(api.teamGitHub.unshare, { sessionToken: f.member.token, teamId: f.teamId })).rejects.toThrow("Only admins");
    await f.t.mutation(api.teamGitHub.unshare, { sessionToken: f.owner.token, teamId: f.teamId });
    expect((await f.t.query(api.teamGitHub.status, { sessionToken: f.owner.token, teamId: f.teamId })).shared).toBeNull();
  });

  test("an organization installation creates the repository in the organization", async () => {
    const f = await fixture();
    await f.share();
    const orgInstallation = fake.install("acme-co", 99, "Organization");
    const accounts = await f.t.action(api.teamGitHub.accounts, { sessionToken: f.owner.token, teamId: f.teamId });
    expect(accounts.map((row) => row.login)).toEqual(["octo", "acme-co"]);
    await f.t.action(api.teamGitHub.chooseAccount, { sessionToken: f.owner.token, teamId: f.teamId, installationId: orgInstallation });
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Org App", githubRepo: "later" });
    expect(await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.member.token, projectId })).toEqual({ state: "ready", repoUrl: "https://github.com/acme-co/Org-App" });
    expect(fake.repos.get("acme-co/org-app")?.private).toBe(true);
  });
  test("a member proves their own GitHub account and is invited to push to the workspace's repositories", async () => {
    const f = await fixture();
    await f.share();
    const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Shared App", githubRepo: "later" });
    await f.t.action(api.teamGitHub.createRepository, { sessionToken: f.member.token, projectId });
    const started = await f.t.action(api.githubLinks.startLink, { sessionToken: f.member.token, teamId: f.teamId });
    expect(started.verificationUri).toBe("https://github.com/login/device");
    expect(await f.t.action(api.githubLinks.finishLink, { sessionToken: f.member.token, teamId: f.teamId })).toEqual({ state: "pending" });
    fake.approveDevice(started.userCode, "mia-dev", 31);
    expect(await f.t.action(api.githubLinks.finishLink, { sessionToken: f.member.token, teamId: f.teamId })).toEqual({ state: "linked", login: "mia-dev", invited: 1 });
    expect(fake.repos.get("octo/shared-app")?.collaborators.get("mia-dev")).toBe("push");
    expect((await f.t.query(api.teamGitHub.status, { sessionToken: f.member.token, teamId: f.teamId })).linkedLogin).toBe("mia-dev");
    await expect(f.t.action(api.githubLinks.finishLink, { sessionToken: f.member.token, teamId: f.teamId })).rejects.toThrow("expired");
    expect(await f.t.action(api.githubLinks.unlink, { sessionToken: f.member.token, teamId: f.teamId })).toBe(1);
    expect(fake.repos.get("octo/shared-app")?.collaborators.has("mia-dev")).toBe(false);
    expect((await f.t.query(api.teamGitHub.status, { sessionToken: f.member.token, teamId: f.teamId })).linkedLogin).toBeNull();
  });
});
