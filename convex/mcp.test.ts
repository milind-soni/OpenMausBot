/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const rows = [];
    for (const name of ["Owner", "Member", "Viewer"]) {
      const email = `${name.toLowerCase()}@mcp.test`;
      const id = await ctx.db.insert("users", { name, username: name.toLowerCase(), email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      rows.push({ id, email, session: await createSession(ctx, id) });
    }
    return { owner: rows[0]!, member: rows[1]!, viewer: rows[2]! };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.session, name: "MCP" });
  await t.run(async ctx => {
    for (const [person, role] of [[people.member, "member"], [people.viewer, "viewer"]] as const) await ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: 1, updatedAt: 1 });
  });
  const shared = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "Shared" });
  const secret = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "Secret" });
  for (const person of [people.member, people.viewer]) await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.session, projectId: shared, email: person.email, role: "member" });
  const token = async (person: { session: string }, write = true) => (await t.mutation(api.mcp.createToken, { sessionToken: person.session, teamId, name: "test", write })).token;
  const ownerToken = await token(people.owner);
  const secretIssue = JSON.parse(await t.mutation(api.mcp.createIssue, { token: ownerToken, project: "Secret", title: "Hidden", dueDate: "2030-01-01" })).id as string;
  return { t, ...people, teamId, shared, secret, token, ownerToken, secretIssue };
}

describe("MCP tools", () => {
  test("tokens act with the user's project access", async () => {
    const f = await fixture();
    const member = await f.token(f.member);
    expect(member.startsWith("origin_pat_")).toBe(true);
    const workspace = JSON.parse(await f.t.query(api.mcp.workspace, { token: member }));
    expect(workspace.projects.map((p: { name: string }) => p.name)).toEqual(["Shared"]);
    expect(workspace.access).toBe("read_write");
    await expect(f.t.query(api.mcp.issue, { token: member, issueId: f.secretIssue })).rejects.toThrow("Issue not found");
    await expect(f.t.mutation(api.mcp.createIssue, { token: member, project: f.secret, title: "x", dueDate: "2030-01-01" })).rejects.toThrow("Project not found");
    await expect(f.t.mutation(api.mcp.addComment, { token: member, issueId: f.secretIssue, body: "hi" })).rejects.toThrow("Issue not found");
  });

  test("viewers and read-only tokens cannot write", async () => {
    const f = await fixture();
    await expect(f.token(f.viewer)).rejects.toThrow("view-only");
    const viewer = await f.token(f.viewer, false);
    expect(JSON.parse(await f.t.query(api.mcp.workspace, { token: viewer })).access).toBe("read");
    await expect(f.t.mutation(api.mcp.createIssue, { token: viewer, project: "Shared", title: "x", dueDate: "2030-01-01" })).rejects.toThrow();
    const readOnly = await f.token(f.member, false);
    await expect(f.t.mutation(api.mcp.createIssue, { token: readOnly, project: "Shared", title: "x", dueDate: "2030-01-01" })).rejects.toThrow();
  });

  test("list_issues filters before paging, in board order", async () => {
    const f = await fixture();
    const create = (title: string, column: string, assignee: string) => f.t.mutation(api.mcp.createIssue, { token: f.ownerToken, project: "Shared", title, column, assignee, dueDate: "2030-01-01" });
    await create("todo owner", "Todo", "me");
    for (let i = 0; i < 5; i++) await create(`progress member ${i}`, "In progress", f.member.email);
    await create("draft member", "Draft", "@member");
    const first = JSON.parse(await f.t.query(api.mcp.issues, { token: f.ownerToken, assignee: "member", limit: 4 }));
    expect(first.issues.map((i: { title: string }) => i.title)).toEqual(["draft member", "progress member 0", "progress member 1", "progress member 2"]);
    const second = JSON.parse(await f.t.query(api.mcp.issues, { token: f.ownerToken, assignee: "member", limit: 4, cursor: first.nextCursor }));
    expect(second.issues.map((i: { title: string }) => i.title)).toEqual(["progress member 3", "progress member 4"]);
    expect(second.nextCursor).toBeNull();
    const text = JSON.parse(await f.t.query(api.mcp.issues, { token: f.ownerToken, text: "TODO OWNER", column: "todo" }));
    expect(text.issues).toHaveLength(1);
    await expect(f.t.query(api.mcp.issues, { token: f.ownerToken, column: "Nope" })).rejects.toThrow("Column not found");
  });

  test("move_issue orders like the board and completes/reopens", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (const title of ["a", "b", "c"]) ids.push(JSON.parse(await f.t.mutation(api.mcp.createIssue, { token: f.ownerToken, project: "Shared", title, column: "Todo", dueDate: "2030-01-01" })).id);
    await f.t.mutation(api.mcp.moveIssue, { token: f.ownerToken, issueId: ids[2]!, before: ids[0]! });
    await f.t.mutation(api.mcp.moveIssue, { token: f.ownerToken, issueId: ids[1]!, position: "top" });
    const order = async () => JSON.parse(await f.t.query(api.mcp.issues, { token: f.ownerToken, column: "Todo" })).issues.map((i: { title: string }) => i.title);
    expect(await order()).toEqual(["b", "c", "a"]);
    const board = await f.t.query(api.tasks.board, { sessionToken: f.owner.session, projectId: f.shared });
    expect(board.tasks.filter(t => !t.done).map(t => t.title)).toEqual(["b", "c", "a"]);
    expect(JSON.parse(await f.t.mutation(api.mcp.moveIssue, { token: f.ownerToken, issueId: ids[0]!, completed: true })).status).toBe("completed");
    const reopened = JSON.parse(await f.t.mutation(api.mcp.moveIssue, { token: f.ownerToken, issueId: ids[0]!, column: "In progress" }));
    expect([reopened.status, reopened.column]).toEqual(["open", "In progress"]);
  });

  test("issues carry their link; assignee and due date are optional and \"none\" clears them", async () => {
    const f = await fixture();
    const created = JSON.parse(await f.t.mutation(api.mcp.createIssue, { token: f.ownerToken, project: "Shared", title: "Loose", assignee: "none" }));
    expect([created.assignee, created.dueDate, created.url]).toEqual([null, null, `/mcp?project=${f.shared}&issue=${created.id}`]);
    const set = JSON.parse(await f.t.mutation(api.mcp.updateIssue, { token: f.ownerToken, issueId: created.id, assignee: "@member", dueDate: "2030-02-01" }));
    expect([set.assignee?.email, set.dueDate]).toEqual([f.member.email, "2030-02-01"]);
    const cleared = JSON.parse(await f.t.mutation(api.mcp.updateIssue, { token: f.ownerToken, issueId: created.id, assignee: "none", dueDate: "none" }));
    expect([cleared.assignee, cleared.dueDate]).toEqual([null, null]);
    const listed = JSON.parse(await f.t.query(api.mcp.issues, { token: f.ownerToken, text: "Loose" })).issues[0];
    expect(listed.url).toBe(created.url);
    expect(JSON.parse(await f.t.query(api.mcp.issue, { token: f.ownerToken, issueId: created.id })).url).toBe(created.url);
  });

  test("comments resolve @mentions and notify like the UI", async () => {
    const f = await fixture();
    const issueId = JSON.parse(await f.t.mutation(api.mcp.createIssue, { token: f.ownerToken, project: "Shared", title: "Review", dueDate: "2030-01-01" })).id;
    const result = JSON.parse(await f.t.mutation(api.mcp.addComment, { token: f.ownerToken, issueId, body: "Ready for @member, not @nobody" }));
    expect(result.mentioned).toEqual(["@member"]);
    const member = await f.token(f.member, false);
    const inbox = JSON.parse(await f.t.query(api.mcp.inbox, { token: member }));
    expect(inbox.unread).toEqual([expect.objectContaining({ kind: "mention", issueId, issue: "Review", from: "Owner" })]);
    const issue = JSON.parse(await f.t.query(api.mcp.issue, { token: member, issueId }));
    expect(issue.comments.map((c: { body: string }) => c.body)).toEqual(["Ready for @member, not @nobody"]);
  });

  test("revoked and self-revoked tokens stop working", async () => {
    const f = await fixture();
    const member = await f.token(f.member);
    await f.t.mutation(api.mcp.revokeOwnToken, { token: member });
    await expect(f.t.query(api.mcp.workspace, { token: member })).rejects.toThrow();
    const grants = await f.t.query(api.connectors.listGrants, { sessionToken: f.member.session, teamId: f.teamId });
    expect(grants.every(g => g.revoked)).toBe(true);
  });

  test("personal access tokens and OAuth grants cannot use the legacy connectors.read/write", async () => {
    const f = await fixture();
    const oauth = (await f.t.mutation(api.mcp.createOAuthGrant, { sessionToken: f.owner.session, teamId: f.teamId, name: "Agent", write: true })).token;
    expect(oauth.startsWith("origin_oauth_")).toBe(true);
    expect(JSON.parse(await f.t.query(api.mcp.workspace, { token: oauth })).access).toBe("read_write");
    const issueId = JSON.parse(await f.t.mutation(api.mcp.createIssue, { token: f.ownerToken, project: "Shared", title: "Keep me", dueDate: "2030-01-01" })).id;
    for (const token of [f.ownerToken, oauth]) {
      await expect(f.t.query(api.connectors.read, { token, kind: "projects" })).rejects.toThrow("only works with the Origin MCP server");
      await expect(f.t.mutation(api.connectors.write, { token, requestId: "request-0001", change: { kind: "delete_issue", projectId: f.shared, taskId: issueId } })).rejects.toThrow("only works with the Origin MCP server");
      await expect(f.t.mutation(api.connectors.write, { token, requestId: "request-0002", change: { kind: "create_project", name: "Sneaky" } })).rejects.toThrow("only works with the Origin MCP server");
    }
    expect(JSON.parse(await f.t.query(api.mcp.issue, { token: f.ownerToken, issueId })).title).toBe("Keep me");
    // Grants from production's connectors.createGrant keep their behaviour.
    const legacy = (await f.t.mutation(api.connectors.createGrant, { sessionToken: f.owner.session, teamId: f.teamId, name: "Legacy", write: true })).token;
    expect(JSON.parse(await f.t.query(api.connectors.read, { token: legacy, kind: "projects" })).projects.length).toBe(2);
    await f.t.mutation(api.connectors.write, { token: legacy, requestId: "request-0003", change: { kind: "delete_issue", projectId: f.shared, taskId: issueId } });
    await expect(f.t.query(api.mcp.issue, { token: f.ownerToken, issueId })).rejects.toThrow("Issue not found");
  });

  test("create_issue errors reach the agent as ConvexError text", async () => {
    const f = await fixture();
    const error = await f.t.mutation(api.mcp.createIssue, { token: f.ownerToken, project: "Shared", title: "x", column: "Nope" }).catch(e => e);
    expect(error.data).toContain("Column not found: Nope");
  });

  test("labels: set on create, replaced or cleared on update, reusing the project's spelling; listed per project", async () => {
    const f = await fixture();
    const member = await f.token(f.member);
    const created = JSON.parse(await f.t.mutation(api.mcp.createIssue, { token: member, project: "Shared", title: "Labelled", labels: ["Bug", " backend ", "bug"] }));
    // A bare note in Draft also gets Needs spec; an explicit label set replaces it.
    expect(created.labels).toEqual(["Bug", "backend", "Needs spec"]);
    const updated = JSON.parse(await f.t.mutation(api.mcp.updateIssue, { token: member, issueId: created.id, labels: ["BUG", "Frontend"] }));
    expect(updated.labels).toEqual(["Bug", "Frontend"]);
    const projects = JSON.parse(await f.t.query(api.mcp.projects, { token: member })).projects;
    expect(projects[0].labels).toEqual(expect.arrayContaining(["Bug", "Frontend"]));
    const cleared = JSON.parse(await f.t.mutation(api.mcp.updateIssue, { token: member, issueId: created.id, labels: [] }));
    expect(cleared.labels).toBeUndefined();
    await expect(f.t.mutation(api.mcp.updateIssue, { token: member, issueId: created.id, labels: Array.from({ length: 21 }, (_, n) => `l${n}`) })).rejects.toThrow("up to 20 labels");
    const readOnly = await f.token(f.member, false);
    await expect(f.t.mutation(api.mcp.updateIssue, { token: readOnly, issueId: created.id, labels: ["x"] })).rejects.toThrow();
  });

  test("get_issue finds an issue by key only among issues the token can see, with its branch and linked pull requests", async () => {
    const f = await fixture();
    const member = await f.token(f.member);
    const created = JSON.parse(await f.t.mutation(api.mcp.createIssue, { token: member, project: "Shared", title: "Keyed" }));
    await f.t.run(async ctx => {
      await ctx.db.patch(f.shared, { repoUrl: "https://github.com/acme/widgets" });
      await ctx.db.insert("taskPullRequests", { projectId: f.shared, taskId: created.id, requesterUserId: f.member.id, number: 4, url: "https://github.com/acme/widgets/pull/4", branch: "b", state: "open", checks: "success", review: "approved", title: "Keyed work", linkSource: "reference", closes: false, updatedAt: 1 });
    });
    // The Secret issue has the same key in this test runtime, but the member cannot see it.
    const issue = JSON.parse(await f.t.query(api.mcp.issue, { token: member, issueId: created.key.toLowerCase() }));
    expect(issue).toMatchObject({ id: created.id, branch: expect.stringContaining(created.key), pullRequests: [{ number: 4, state: "open", title: "Keyed work", completesOnMerge: false }] });
    await expect(f.t.query(api.mcp.issue, { token: f.ownerToken, issueId: created.key })).rejects.toThrow("more than one issue");
  });
});
