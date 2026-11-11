// @vitest-environment node
/// <reference types="vite/client" />
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { createSession } from "../convex/lib/auth";
import { integrationBridge } from "./integration-bridge";
import { githubRequest, saveGitHubApp } from "./github-workspace";
import { pushGitHubTask, syncGitHubOutbox } from "./github-sync";
import { saveGitHubConnection } from "./githubConnection";
import { convexStore, signedBridge } from "../testing/convex-store";
import { POST } from "../app/api/github/webhook/route";

vi.mock("./integration-bridge", async importOriginal => ({ ...await importOriginal<typeof import("./integration-bridge")>(), integrationBridge: vi.fn(), originUrl: () => "http://127.0.0.1:1" }));
vi.mock("./github-workspace", async importOriginal => ({ ...await importOriginal<typeof import("./github-workspace")>(), githubRequest: vi.fn() }));
const secret = "sync-synthetic-signing-secret";
const REPO = "https://github.com/z4mbo/origin-sync-fixture";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

type FakeIssue = { number: number; html_url: string; node_id: string; title: string; body: string; labels: { name: string }[]; state: "open" | "closed"; state_reason?: string | null; updated_at: string };

async function fixture() {
  const t = convexStore();
  const owner = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { email: "owner@sync.test", name: "Owner", role: "user", status: "active", passwordHash: "x", salt: "x", iterations: 1, createdAt: Date.now(), updatedAt: Date.now() });
    return { id, sessionToken: await createSession(ctx, id) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.sessionToken, name: "Sync" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: owner.sessionToken, teamId, name: "Sync project", repoUrl: REPO });
  const board = await t.query(api.tasks.board, { sessionToken: owner.sessionToken, projectId });
  const active = board.columns.find(column => !column.isDraft && !column.isDone)!._id;
  const backlog = board.columns.find(column => column.isDraft)!._id;
  vi.mocked(integrationBridge).mockImplementation(async (operation, args) => {
    const input = args as never;
    if (operation.startsWith("store.")) return signedBridge(t, operation, args);
    return signedBridge(t, operation, input);
  });
  await saveGitHubApp({ clientId: "fixture", clientSecret: "fixture", webhookSecret: secret });
  await saveGitHubConnection(projectId, "z4mbo/origin-sync-fixture", "z4mbo", "fixture-token", owner.id);

  // An in-memory GitHub for the repository.
  const issues = new Map<number, FakeIssue>();
  const calls: { method: string; endpoint: string; body?: Record<string, unknown> }[] = [];
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const tick = () => new Date(clock += 60000).toISOString();
  vi.mocked(githubRequest).mockImplementation(async (endpoint, token, init) => {
    expect(token).toBe("fixture-token");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, endpoint, body });
    const one = endpoint.match(/^\/repos\/z4mbo\/origin-sync-fixture\/issues\/(\d+)$/);
    if (endpoint === "/repos/z4mbo/origin-sync-fixture/issues" && method === "POST") {
      const number = issues.size + 1;
      const issue: FakeIssue = { number, html_url: `${REPO}/issues/${number}`, node_id: `I_${number}`, title: body.title, body: body.body ?? "", labels: (body.labels ?? []).map((name: string) => ({ name })), state: "open", updated_at: tick() };
      issues.set(number, issue);
      return structuredClone(issue);
    }
    if (endpoint.startsWith("/repos/z4mbo/origin-sync-fixture/issues?")) return [...issues.values()].map(issue => structuredClone(issue));
    if (one) {
      const issue = issues.get(Number(one[1]));
      if (!issue) throw Object.assign(new Error("Not found"), { status: 404 });
      if (method === "PATCH") {
        if (body.title !== undefined) issue.title = body.title;
        if (body.body !== undefined) issue.body = body.body;
        if (body.labels !== undefined) issue.labels = body.labels.map((name: string) => ({ name }));
        if (body.state !== undefined) { issue.state = body.state; issue.state_reason = body.state_reason; }
        issue.updated_at = tick();
      }
      return structuredClone(issue);
    }
    throw new Error(`Unexpected GitHub call ${method} ${endpoint}`);
  });
  const task = (taskId: Id<"tasks">) => t.run(ctx => ctx.db.get(taskId));
  const webhook = (number: number) => {
    const payload = JSON.stringify({ action: "edited", repository: { full_name: "z4mbo/origin-sync-fixture" }, issue: { number }, sender: { login: "someone", type: "User" } });
    return POST(new Request("http://localhost/api/github/webhook", { method: "POST", headers: { "x-github-event": "issues", "x-github-delivery": randomUUID(), "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}` }, body: payload }));
  };
  /** An edit made on github.com (as `gh issue edit` would). */
  const editOnGitHub = (number: number, patch: Partial<Pick<FakeIssue, "title" | "body" | "state">> & { labels?: string[] }) => {
    const issue = issues.get(number)!;
    Object.assign(issue, { ...patch, ...(patch.labels ? { labels: patch.labels.map(name => ({ name })) } : {}), updated_at: tick() });
  };
  const patches = () => calls.filter(call => call.method === "PATCH");
  const posts = () => calls.filter(call => call.method === "POST");
  return { t, owner, teamId, projectId, active, backlog, issues, calls, patches, posts, task, webhook, editOnGitHub };
}

test("leaving Backlog creates the GitHub issue once, with title, body marker and labels", async () => {
  const f = await fixture();
  const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, title: "Draft idea", description: "Some detail", priority: "low", labels: ["Bug"] });
  await syncGitHubOutbox();
  expect(f.posts()).toHaveLength(0);
  await f.t.mutation(api.tasks.moveTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, columnId: f.active });
  await syncGitHubOutbox();
  await syncGitHubOutbox();
  expect(await pushGitHubTask(f.projectId, taskId)).toBe("none");
  expect(f.posts()).toHaveLength(1);
  const issue = f.issues.get(1)!;
  expect(issue).toMatchObject({ title: "Draft idea", state: "open", labels: [{ name: "Bug" }] });
  expect(issue.body).toBe(`Some detail\n\n<!-- origin-task:${taskId} -->`);
  expect(await f.task(taskId)).toMatchObject({ githubIssueNumber: 1, githubIssueState: "open" });
  // The webhook for our own create is an echo: nothing changes on either side.
  expect((await f.webhook(1)).status).toBe(200);
  expect(f.patches()).toHaveLength(0);
  expect(await f.task(taskId)).toMatchObject({ title: "Draft idea", description: "Some detail", labels: ["Bug"] });
});

test("complete closes, reopen reopens, and back to Backlog closes the GitHub issue", async () => {
  const f = await fixture();
  const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, columnId: f.active, title: "Ship it", priority: "low" });
  await syncGitHubOutbox();
  await f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, done: true });
  await syncGitHubOutbox();
  expect(f.issues.get(1)).toMatchObject({ state: "closed", state_reason: "completed" });
  expect(await f.task(taskId)).toMatchObject({ done: true, githubIssueState: "closed" });
  await f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, done: false });
  await syncGitHubOutbox();
  expect(f.issues.get(1)).toMatchObject({ state: "open", state_reason: "reopened" });
  expect(await f.task(taskId)).toMatchObject({ done: false, githubIssueState: "open" });
  expect((await f.task(taskId))!.githubIssueReopenRequested).toBeUndefined();
  await f.t.mutation(api.tasks.moveTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, columnId: f.backlog });
  await syncGitHubOutbox();
  expect(f.issues.get(1)).toMatchObject({ state: "closed", state_reason: "not_planned" });
  expect(await f.task(taskId)).toMatchObject({ done: false });
  await f.t.mutation(api.tasks.moveTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, columnId: f.active });
  await syncGitHubOutbox();
  expect(f.issues.get(1)).toMatchObject({ state: "open" });
  expect(f.posts()).toHaveLength(1);
});

test("deleting an Origin issue closes its GitHub issue as not planned", async () => {
  const f = await fixture();
  const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, columnId: f.active, title: "Doomed", priority: "low" });
  await syncGitHubOutbox();
  await f.t.mutation(api.tasks.deleteTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId });
  await syncGitHubOutbox();
  expect(f.issues.get(1)).toMatchObject({ state: "closed", state_reason: "not_planned" });
  expect(await f.t.run(ctx => ctx.db.query("githubIssueMirrors").collect())).toHaveLength(0);
});

test("Origin edits to title, description and labels PATCH only the changed fields", async () => {
  const f = await fixture();
  const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, columnId: f.active, title: "Old", priority: "low" });
  await syncGitHubOutbox();
  await f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, title: "New title" });
  await syncGitHubOutbox();
  expect(f.patches().at(-1)!.body).toEqual({ title: "New title" });
  await f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, taskId, description: "Now with words" });
  await syncGitHubOutbox();
  expect(f.patches().at(-1)!.body).toEqual({ body: `Now with words\n\n<!-- origin-task:${taskId} -->` });
  await f.t.mutation(api.issueRelations.labels, { sessionToken: f.owner.sessionToken, taskId, labels: ["Feature", "Bug"] });
  await syncGitHubOutbox();
  expect(f.patches().at(-1)!.body).toEqual({ labels: ["Feature", "Bug"] });
  expect(f.issues.get(1)).toMatchObject({ title: "New title", labels: [{ name: "Feature" }, { name: "Bug" }] });
  const count = f.patches().length;
  // The echoes of our own PATCHes change nothing.
  await f.webhook(1);
  await f.webhook(1);
  expect(f.patches()).toHaveLength(count);
  expect(await f.task(taskId)).toMatchObject({ title: "New title", description: "Now with words", labels: ["Feature", "Bug"] });
});

test("GitHub edits to title, body, labels and state land in Origin without echoing back", async () => {
  const f = await fixture();
  const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, columnId: f.active, title: "From Origin", description: "Origin text", priority: "low" });
  await syncGitHubOutbox();
  f.editOnGitHub(1, { title: "Edited on GitHub", body: `GitHub text\n\n<!-- origin-task:${taskId} -->`, labels: ["Improvement"] });
  expect((await f.webhook(1)).status).toBe(200);
  expect(await f.task(taskId)).toMatchObject({ title: "Edited on GitHub", description: "GitHub text", labels: ["Improvement"] });
  expect(f.patches()).toHaveLength(0);
  // The Origin write queued the issue; draining the outbox finds nothing to push.
  await syncGitHubOutbox();
  expect(f.patches()).toHaveLength(0);
  f.editOnGitHub(1, { state: "closed" });
  await f.webhook(1);
  expect(await f.task(taskId)).toMatchObject({ done: true, githubIssueState: "closed" });
  await syncGitHubOutbox();
  expect(f.patches()).toHaveLength(0);
});

test("migration: dry run only counts; the real run queues each missing issue once and the worker creates them", async () => {
  const f = await fixture();
  // Issues that existed before the sync: created with no repository, then the repository was linked.
  await f.t.run(ctx => ctx.db.patch(f.projectId, { repoUrl: undefined }));
  const open = await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, columnId: f.active, title: "Existing open", priority: "low" });
  await f.t.mutation(api.tasks.createTask, { sessionToken: f.owner.sessionToken, projectId: f.projectId, title: "Existing draft", priority: "low" });
  await f.t.run(ctx => ctx.db.patch(f.projectId, { repoUrl: REPO, githubWorkspaceAccess: true }));
  expect(await f.t.run(ctx => ctx.db.query("githubIssueMirrors").collect())).toHaveLength(0);

  const dry = await f.t.action(internal.githubIssueSync.backfillMissingIssues, { batchSize: 1 });
  expect(dry).toMatchObject({ dryRun: true, eligible: 1, queued: 0, complete: true });
  expect(dry.sample.map(row => row.taskId)).toEqual([open]);
  expect(await f.t.run(ctx => ctx.db.query("githubIssueMirrors").collect())).toHaveLength(0);

  expect(await f.t.action(internal.githubIssueSync.backfillMissingIssues, { dryRun: false })).toMatchObject({ eligible: 1, queued: 1 });
  expect(await f.t.action(internal.githubIssueSync.backfillMissingIssues, { dryRun: false })).toMatchObject({ eligible: 1, queued: 0 });
  await syncGitHubOutbox();
  expect(f.posts()).toHaveLength(1);
  expect(await f.task(open)).toMatchObject({ githubIssueNumber: 1 });
  expect(await f.t.action(internal.githubIssueSync.backfillMissingIssues, {})).toMatchObject({ eligible: 0 });
});
