/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import { signIssueWebhook, type IssueWebhookPayload } from "../lib/issue-webhook";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const SEALING_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 3)));
const GLOBAL_SECRET = "g".repeat(40);

// Fake timers keep queued deliveries pending (convex-test would otherwise run them at once) so tests can read them.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ORIGIN_SEALING_KEY", SEALING_KEY);
  vi.stubEnv("ORIGIN_PUBLIC_URL", "https://origin.test");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const useGlobalWebhook = () => { vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_URL", "https://hooks.test/global"); vi.stubEnv("ORIGIN_ISSUE_WEBHOOK_SECRET", GLOBAL_SECRET); };

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const make = async (name: string) => {
      const userId = await ctx.db.insert("users", { name, email: `${name.toLowerCase()}@hooks.test`, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      return { userId, email: `${name.toLowerCase()}@hooks.test`, session: await createSession(ctx, userId) };
    };
    return { owner: await make("Owner"), member: await make("Member") };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.session, name: "Hooks" });
  await t.run(ctx => ctx.db.insert("teamMembers", { teamId, userId: people.member.userId, email: people.member.email, name: "Member", role: "member", status: "active", createdAt: 1, updatedAt: 1 }));
  const projectId = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "Web", githubRepo: "later" });
  await t.run(ctx => ctx.db.patch(projectId, { repoUrl: "https://github.com/acme/web" }));
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.session, projectId, email: people.member.email, role: "member" });
  const columns = (await t.query(api.tasks.board, { sessionToken: people.owner.session, projectId })).columns;
  const column = (title: string) => columns.find(c => c.title === title)!._id;
  const sessionToken = people.owner.session;
  const deliveries = async () => (await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect()))
    .filter(job => job.name.includes("issueWebhooks") && job.state.kind === "pending")
    .map(job => job.args[0] as { teamId: Id<"teams">; event: "issue.created" | "issue.updated"; deliveryId: string; body: string; attempt?: number });
  const payloads = async () => (await deliveries()).map(job => JSON.parse(job.body) as IssueWebhookPayload);
  return { t, ...people, teamId, projectId, column, sessionToken, deliveries, payloads };
}

describe("issue webhooks are queued by issue writes", () => {
  test("nothing is queued when neither the workspace nor the deployment has a webhook", async () => {
    const f = await fixture();
    const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Quiet", priority: "medium" });
    await f.t.mutation(api.tasks.moveTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, columnId: f.column("Todo") });
    expect(await f.deliveries()).toEqual([]);
  });

  test("issue.created carries the documented payload, with Needs spec on a bare Draft note", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Import CSV", priority: "medium", assignedToEmail: f.member.email });
    const [job] = await f.deliveries();
    expect(job).toMatchObject({ teamId: f.teamId, event: "issue.created" });
    const payload = JSON.parse(job!.body) as IssueWebhookPayload;
    expect(job!.deliveryId).toBe(payload.id);
    expect(job!.body).toBe(JSON.stringify(payload));
    const team = await f.t.run(ctx => ctx.db.get(f.teamId));
    expect(payload).toEqual({
      id: expect.stringMatching(/^evt_/), type: "issue.created", occurredAt: expect.any(String),
      workspace: { id: f.teamId, name: "Hooks", slug: team!.slug },
      project: { id: f.projectId, name: "Web", repo: "acme/web" },
      issue: {
        id: taskId, key: expect.stringMatching(/^ORI-[0-9A-Z]{4}$/), title: "Import CSV", description: "", labels: ["Needs spec"],
        url: `https://origin.test/${team!.slug}/issue/${payload.issue.key}`, status: "Draft", completed: false,
        assignee: { email: f.member.email, name: "Member" }, acceptanceCriteria: [],
      },
      changes: null,
    });
  });

  test("issue.updated fires on status and completion changes, not on title edits", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Typo", priority: "medium" });
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, title: "Typo fixed", priority: "high", description: "More" });
    expect(await f.deliveries()).toHaveLength(1);
    await f.t.mutation(api.tasks.moveTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, columnId: f.column("Todo") });
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, done: true });
    await f.t.mutation(api.tasks.updateTask, { sessionToken: f.sessionToken, projectId: f.projectId, taskId, done: true });
    const updates = (await f.payloads()).slice(1);
    expect(updates.map(p => [p.type, p.changes, p.issue.status, p.issue.completed])).toEqual([
      ["issue.updated", { status: { from: "Draft", to: "Todo" } }, "Todo", false],
      ["issue.updated", { completed: { from: false, to: true } }, "Todo", true],
    ]);
    expect(updates[0]!.issue.title).toBe("Typo fixed");
  });

  test("MCP creates and moves send the same events", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const token = (await f.t.mutation(api.mcp.createToken, { sessionToken: f.sessionToken, teamId: f.teamId, name: "bot", write: true })).token;
    const created = JSON.parse(await f.t.mutation(api.mcp.createIssue, { token, project: "Web", title: "From the bot", description: "Spec", acceptanceCriteria: ["Works"] }));
    await f.t.mutation(api.mcp.moveIssue, { token, issueId: created.id, column: "In progress" });
    await f.t.mutation(api.mcp.moveIssue, { token, issueId: created.id, completed: true });
    const [first, ...rest] = await f.payloads();
    expect(first!.issue).toMatchObject({ description: "Spec", labels: [], acceptanceCriteria: [{ text: "Works", checked: false }], assignee: { email: "owner@hooks.test" } });
    expect(rest.map(p => p.changes)).toEqual([{ status: { from: "Draft", to: "In progress" } }, { completed: { from: false, to: true } }]);
  });

  test("a merged pull request that completes the issue sends one update with both changes", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.sessionToken, projectId: f.projectId, columnId: f.column("In progress"), title: "Ship", priority: "medium" });
    await f.t.run(ctx => ctx.db.patch(f.projectId, { githubWorkspaceAccess: true, status: "active" }));
    const snapshot = { number: 7, url: "https://github.com/acme/web/pull/7", branch: "ship", headSha: "a".repeat(40), baseSha: "b".repeat(40), state: "merged" as const, checks: "success", review: "approved", mergeable: true, githubUpdatedAt: 10 };
    await f.t.mutation(internal.taskPRs.linkReferences, { repoUrl: "https://github.com/acme/web", projectIds: [f.projectId], title: `Closes ${(JSON.parse((await f.deliveries())[0]!.body) as IssueWebhookPayload).issue.key}`, snapshot });
    const updates = (await f.payloads()).filter(p => p.type === "issue.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.changes).toEqual({ status: { from: "In progress", to: "Done" }, completed: { from: false, to: true } });
    expect(updates[0]!.issue.id).toBe(taskId);
  });
});

describe("workspace webhook settings and delivery", () => {
  test("only admins set it; the secret is required, long and never returned", async () => {
    const f = await fixture();
    const save = (session: string, url: string, secret?: string) => f.t.mutation(api.issueWebhooks.save, { sessionToken: session, teamId: f.teamId, url, ...(secret === undefined ? {} : { secret }) });
    await expect(save(f.member.session, "https://hooks.test/team", "s".repeat(32))).rejects.toThrow();
    await expect(save(f.sessionToken, "https://hooks.test/team")).rejects.toThrow("Enter a signing secret");
    await expect(save(f.sessionToken, "https://hooks.test/team", "short")).rejects.toThrow("at least 32");
    await expect(save(f.sessionToken, "ftp://hooks.test", "s".repeat(32))).rejects.toThrow("http");
    await save(f.sessionToken, "https://hooks.test/team", "s".repeat(32));
    await save(f.sessionToken, "https://hooks.test/team2");
    expect(await f.t.query(api.issueWebhooks.get, { sessionToken: f.sessionToken, teamId: f.teamId })).toEqual({ url: "https://hooks.test/team2", canManage: true, globalDefault: false, sealing: true });
    expect(await f.t.query(api.issueWebhooks.get, { sessionToken: f.member.session, teamId: f.teamId })).toMatchObject({ url: null, canManage: false });
    const row = await f.t.run(ctx => ctx.db.query("issueWebhooks").first());
    expect(row!.sealedSecret).not.toContain("ssss");
    await f.t.mutation(api.issueWebhooks.remove, { sessionToken: f.sessionToken, teamId: f.teamId });
    expect((await f.t.query(api.issueWebhooks.get, { sessionToken: f.sessionToken, teamId: f.teamId })).url).toBeNull();
  });

  test("the workspace webhook wins over the deployment's and is signed with its own secret", async () => {
    useGlobalWebhook();
    const f = await fixture();
    const secret = "w".repeat(36);
    await f.t.mutation(api.issueWebhooks.save, { sessionToken: f.sessionToken, teamId: f.teamId, url: "https://hooks.test/team", secret });
    await f.t.mutation(api.tasks.createTask, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Signed", priority: "medium" });
    const [job] = await f.deliveries();
    const sent: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => { sent.push(new Request(input, init)); return new Response("ok"); });
    await f.t.action(internal.issueWebhooks.deliver, job!);
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.url).toBe("https://hooks.test/team");
    expect(request.method).toBe("POST");
    const body = await request.text();
    expect(body).toBe(job!.body);
    expect(Object.fromEntries(["content-type", "x-origin-event", "x-origin-delivery", "x-origin-signature"].map(name => [name, request.headers.get(name)]))).toEqual({
      "content-type": "application/json", "x-origin-event": "issue.created", "x-origin-delivery": job!.deliveryId, "x-origin-signature": await signIssueWebhook(body, secret),
    });
  });

  test("a failed delivery is retried a little later and never throws", async () => {
    useGlobalWebhook();
    const f = await fixture();
    await f.t.mutation(api.tasks.createTask, { sessionToken: f.sessionToken, projectId: f.projectId, title: "Flaky", priority: "medium" });
    const [job] = await f.deliveries();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await f.t.action(internal.issueWebhooks.deliver, job!);
    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await f.t.action(internal.issueWebhooks.deliver, { ...job!, attempt: 3 });
    const retries = (await f.deliveries()).filter(next => next.attempt);
    expect(retries).toEqual([{ ...job!, attempt: 2 }]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(GLOBAL_SECRET);
  });
});
