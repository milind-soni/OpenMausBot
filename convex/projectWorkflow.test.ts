/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { createSession } from "./lib/auth";
import { containsMention } from "../lib/issue-mentions";
import { repositoryUrl } from "./lib/repository";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const page = { numItems: 50, cursor: null };

async function fixture() {
  const t = convexTest(schema, modules);
  const data = await t.run(async ctx => {
    const now = Date.now();
    const users = [];
    for (const name of ["Owner", "Member", "Viewer"]) {
      const id = await ctx.db.insert("users", { name, username: name.toLowerCase(), email: `${name.toLowerCase()}@example.test`, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: now, updatedAt: now });
      users.push({ id, token: await createSession(ctx, id), email: `${name.toLowerCase()}@example.test` });
    }
    return { owner: users[0], member: users[1], viewer: users[2] };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: data.owner.token, name: "Test workspace" });
  await t.run(async ctx => {
    for (const [person, role] of [[data.member, "member"], [data.viewer, "viewer"]] as const) await ctx.db.insert("teamMembers", { teamId, userId: person.id, email: person.email, name: role, role, status: "active", createdAt: Date.now(), updatedAt: Date.now() });
  });
  const shared = await t.mutation(api.projects.create, { sessionToken: data.owner.token, teamId, name: "Shared", repoUrl: "https://github.com/example/shared" });
  const privateProject = await t.mutation(api.projects.create, { sessionToken: data.owner.token, teamId, name: "Private", repoUrl: "https://github.com/example/private" });
  for (const person of [data.member, data.viewer]) await t.mutation(api.members.addWorkspaceMember, { sessionToken: data.owner.token, projectId: shared, email: person.email, role: "member" });
  const column = (await t.query(api.tasks.board, { sessionToken: data.owner.token, projectId: shared })).columns.find(c => c.title === "Todo")!._id;
  const privateColumn = (await t.query(api.tasks.board, { sessionToken: data.owner.token, projectId: privateProject })).columns.find(c => c.title === "Todo")!._id;
  const issue = await t.mutation(api.tasks.createTask, { sessionToken: data.owner.token, projectId: shared, columnId: column, title: "Shared issue", priority: "high", assignedToEmail: data.member.email, dueDate: "2026-10-01" });
  const privateIssue = await t.mutation(api.tasks.createTask, { sessionToken: data.owner.token, projectId: privateProject, columnId: privateColumn, title: "Private issue", priority: "high", assignedToEmail: data.owner.email, dueDate: "2026-10-01" });
  return { t, ...data, teamId, shared, privateProject, column, issue, privateIssue };
}

describe("Project access", () => {
  test("legacy workspace discovery cannot enumerate private projects", async () => {
    const f = await fixture();
    for (const person of [f.member, f.viewer]) {
      const teams = await f.t.query(api.teams.listWithProjects, { sessionToken: person.token });
      expect(teams).toHaveLength(1);
      expect(teams[0].projects.map(project => project._id)).toEqual([f.shared]);
      expect(JSON.stringify(teams)).not.toContain("https://github.com/example/private");
    }
    const owner = await f.t.query(api.teams.listWithProjects, { sessionToken: f.owner.token });
    expect(owner[0].projects.map(project => project._id).sort()).toEqual([f.shared, f.privateProject].sort());
    await f.t.mutation(api.teams.leave, { sessionToken: f.member.token, teamId: f.teamId });
    expect(await f.t.query(api.teams.listWithProjects, { sessionToken: f.member.token })).toEqual([]);
  });
  test("members can leave without deleting work; invitations do not restore old grants", async () => {
    const f = await fixture();
    const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.member.token, teamId: f.teamId, name: "Agent", write: true });
    await f.t.mutation(api.teams.leave, { sessionToken: f.member.token, teamId: f.teamId });
    expect(await f.t.query(api.workspaces.list, { sessionToken: f.member.token })).toHaveLength(0);
    await expect(f.t.query(api.connectors.verify, { token: grant.token })).rejects.toThrow();
    expect((await f.t.query(api.tasks.board, { sessionToken: f.owner.token, projectId: f.shared })).tasks).toHaveLength(1);
    const invite = await f.t.mutation(api.workspaces.createInvite, { sessionToken: f.owner.token, teamId: f.teamId, role: "member" });
    await f.t.mutation(api.workspaces.acceptInvite, { sessionToken: f.member.token, token: invite.token });
    expect(await f.t.query(api.projects.listForUser, { sessionToken: f.member.token, teamId: f.teamId })).toHaveLength(0);
    await expect(f.t.query(api.connectors.verify, { token: grant.token })).rejects.toThrow();
    await expect(f.t.mutation(api.teams.leave, { sessionToken: f.owner.token, teamId: f.teamId })).rejects.toThrow("owner");
  });

  test("admins manage member roles and removal, while members cannot", async () => {
    const f = await fixture();
    const members = await f.t.query(api.workspaces.members, { sessionToken: f.owner.token, teamId: f.teamId });
    const memberId = members.find(m => m.email === f.member.email)!._id;
    const viewerId = members.find(m => m.email === f.viewer.email)!._id;
    await expect(f.t.mutation(api.teams.updateRole, { sessionToken: f.member.token, teamId: f.teamId, memberId: viewerId, role: "admin" })).rejects.toThrow();
    await f.t.mutation(api.teams.updateRole, { sessionToken: f.owner.token, teamId: f.teamId, memberId, role: "admin" });
    await f.t.mutation(api.teams.removeMember, { sessionToken: f.member.token, teamId: f.teamId, memberId: viewerId });
    await expect(f.t.query(api.workspaces.access, { sessionToken: f.viewer.token, teamId: f.teamId })).rejects.toThrow();
    const ownerId = members.find(m => m.email === f.owner.email)!._id;
    await expect(f.t.mutation(api.teams.removeMember, { sessionToken: f.member.token, teamId: f.teamId, memberId: ownerId })).rejects.toThrow("owner");
  });
  test("admins see all projects; members and search see only explicit projects", async () => {
    const f = await fixture();
    expect(await f.t.query(api.projects.listForUser, { sessionToken: f.owner.token, teamId: f.teamId })).toHaveLength(2);
    expect((await f.t.query(api.projects.listForUser, { sessionToken: f.member.token, teamId: f.teamId })).map(p => p._id)).toEqual([f.shared]);
    await expect(f.t.query(api.tasks.details, { sessionToken: f.member.token, projectId: f.privateProject, taskId: f.privateIssue })).rejects.toThrow("You don't have access to this project");
    const rows = await f.t.query(api.workspaceSearch.issues, { sessionToken: f.member.token, teamId: f.teamId, text: "issue" });
    expect(rows.map(row => row._id)).toEqual([f.issue]);
    // The lane title, for the Link issue picker's status icon.
    expect(rows[0]?.status).toBe("Todo");
    const inbox = await f.t.query(api.inbox.list, { sessionToken: f.member.token, teamId: f.teamId, mine: false, done: false, paginationOpts: page });
    expect(inbox.page.map(row => row._id)).toEqual([f.issue]);
    await expect(f.t.mutation(api.projects.reorder, { sessionToken: f.member.token, teamId: f.teamId, projectIds: [f.privateProject] })).rejects.toThrow();
  });

  test("workspace viewers cannot gain edit rights through a project role", async () => {
    const f = await fixture();
    expect((await f.t.query(api.projects.get, { sessionToken: f.viewer.token, projectId: f.shared })).memberRole).toBe("viewer");
    await expect(f.t.mutation(api.tasks.updateTask, { sessionToken: f.viewer.token, projectId: f.shared, taskId: f.issue, done: true })).rejects.toThrow("You have view-only access");
    await expect(f.t.mutation(api.members.addWorkspaceMember, { sessionToken: f.member.token, projectId: f.privateProject, email: f.member.email, role: "member" })).rejects.toThrow();
  });

  test("project links add project access without granting workspace admin", async () => {
    const f = await fixture();
    const invite = await f.t.mutation(api.workspaces.createInvite, { sessionToken: f.owner.token, teamId: f.teamId, projectId: f.privateProject, role: "member" });
    await f.t.mutation(api.workspaces.acceptInvite, { sessionToken: f.member.token, token: invite.token });
    expect((await f.t.query(api.projects.listForUser, { sessionToken: f.member.token, teamId: f.teamId })).length).toBe(2);
    await expect(f.t.mutation(api.workspaces.createInvite, { sessionToken: f.owner.token, teamId: f.teamId, projectId: f.privateProject, role: "admin" })).rejects.toThrow();
    await f.t.mutation(api.workspaces.revokeInvite, { sessionToken: f.owner.token, inviteId: (await f.t.query(api.workspaces.invitations, { sessionToken: f.owner.token, teamId: f.teamId }))[0]._id });
    await expect(f.t.mutation(api.workspaces.acceptInvite, { sessionToken: f.viewer.token, token: invite.token })).rejects.toThrow("revoked");
  });

  test("removal immediately removes search, MCP and old notifications", async () => {
    const f = await fixture();
    const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.member.token, teamId: f.teamId, name: "Test", write: true });
    const membership = (await f.t.query(api.members.list, { sessionToken: f.owner.token, projectId: f.shared })).find(m => m.email === f.member.email)!;
    await f.t.mutation(api.members.remove, { sessionToken: f.owner.token, projectId: f.shared, memberId: membership._id });
    expect(JSON.parse(await f.t.query(api.connectors.read, { token: grant.token, kind: "projects" })).projects).toHaveLength(0);
    expect((await f.t.query(api.notifications.list, { sessionToken: f.member.token, teamId: f.teamId, unreadOnly: false, paginationOpts: page })).page).toHaveLength(0);
    await expect(f.t.mutation(api.connectors.write, { token: grant.token, requestId: "removed-member-test", change: { kind: "update_issue", projectId: f.shared, taskId: f.issue, done: true } })).rejects.toThrow();
  });
});

test("inactive and legacy projects preserve issues but leave active inbox and calendar", async () => {
  const f = await fixture();
  for (const status of ["inactive", "paused", "archived", "shipped"] as const) {
    if (status === "inactive") await f.t.mutation(api.projects.update, { sessionToken: f.owner.token, projectId: f.shared, status });
    else await f.t.run(ctx => ctx.db.patch(f.shared, { status }));
    expect((await f.t.query(api.projects.get, { sessionToken: f.owner.token, projectId: f.shared })).status).toBe("inactive");
    expect((await f.t.query(api.projects.listForUser, { sessionToken: f.owner.token, teamId: f.teamId })).find(p => p._id === f.shared)?.status).toBe("inactive");
    expect(await f.t.query(api.tasks.inbox, { sessionToken: f.member.token, teamId: f.teamId })).toHaveLength(0);
    expect((await f.t.query(api.inbox.list, { sessionToken: f.member.token, teamId: f.teamId, mine: true, done: false, paginationOpts: page })).page).toHaveLength(0);
    expect((await f.t.query(api.inbox.calendar, { sessionToken: f.member.token, teamId: f.teamId, start: "2026-10-01", end: "2026-10-31", mine: true })).tasks).toHaveLength(0);
    expect((await f.t.query(api.tasks.board, { sessionToken: f.member.token, projectId: f.shared })).tasks).toHaveLength(1);
  }
  await f.t.mutation(api.projects.update, { sessionToken: f.owner.token, projectId: f.shared, status: "active" });
  expect(await f.t.query(api.tasks.inbox, { sessionToken: f.member.token, teamId: f.teamId })).toHaveLength(1);
  await f.t.mutation(api.projects.remove, { sessionToken: f.owner.token, projectId: f.shared });
  expect((await f.t.query(api.projects.get, { sessionToken: f.owner.token, projectId: f.shared })).status).toBe("inactive");
});

test("comments support references, attached media and collaborative checklists with project permissions", async () => {
  const f = await fixture();
  const args = { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue };
  await f.t.mutation(api.tasks.addComment, { ...args, body: "See #Shared\n- [ ] Review screen\n- [ ] Ship", references: [{ type: "project", id: f.shared, projectId: f.shared, label: "Shared" }], attachments: [{ id: "a0000000-0000-0000-0000-000000000001", name: "screen.png", contentType: "image/png", size: 100 }] });
  const detail = await f.t.query(api.tasks.details, args);
  const comment = detail.comments[0];
  expect(comment.references?.[0].id).toBe(f.shared);
  expect(detail.assets[0].commentId).toBe(comment._id);
  await f.t.mutation(api.tasks.checkCommentItem, { sessionToken: f.member.token, projectId: f.shared, commentId: comment._id, line: 1, text: "Review screen", checked: true });
  await f.t.mutation(api.tasks.checkCommentItem, { sessionToken: f.owner.token, projectId: f.shared, commentId: comment._id, line: 2, text: "Ship", checked: true });
  expect((await f.t.query(api.tasks.details, args)).comments[0].body).toContain("- [x] Review screen\n- [x] Ship");
  await expect(f.t.mutation(api.tasks.checkCommentItem, { sessionToken: f.viewer.token, projectId: f.shared, commentId: comment._id, line: 1, text: "Review screen", checked: false })).rejects.toThrow();
  await expect(f.t.mutation(api.tasks.checkCommentItem, { sessionToken: f.owner.token, projectId: f.shared, commentId: comment._id, line: 1, text: "Stale text", checked: false })).rejects.toThrow("Checklist changed");
  await expect(f.t.mutation(api.tasks.addComment, { ...args, sessionToken: f.member.token, body: "#Private", references: [{ type: "issue", id: f.privateIssue, projectId: f.privateProject, label: "Private" }] })).rejects.toThrow();
  await expect(f.t.mutation(api.tasks.addComment, { ...args, body: "#Mismatch", references: [{ type: "issue", id: f.privateIssue, projectId: f.shared, label: "Mismatch" }] })).rejects.toThrow();
  await f.t.mutation(api.tasks.addComment, { ...args, body: "", attachments: [{ id: "a0000000-0000-0000-0000-000000000002", name: "file.txt", contentType: "text/plain", size: 100 }] });
  expect((await f.t.query(api.tasks.details, args)).comments).toHaveLength(2);
});

test("comment mentions validate access, store inline tokens and notify once", async () => {
  const f = await fixture();
  await f.t.mutation(api.tasks.addComment, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue, body: "Please review @member https://example.test", mentions: [{ userId: f.member.id, token: "@member" }] });
  const detail = await f.t.query(api.tasks.details, { sessionToken: f.member.token, projectId: f.shared, taskId: f.issue });
  expect(detail.comments[0].mentions?.[0].token).toBe("@member");
  const notifications = (await f.t.query(api.notifications.list, { sessionToken: f.member.token, teamId: f.teamId, unreadOnly: false, paginationOpts: page })).page;
  expect(notifications.filter(n => n.kind === "mention")).toHaveLength(1);
  expect(notifications.filter(n => n.kind === "comment")).toHaveLength(0);
  await expect(f.t.mutation(api.tasks.addComment, { sessionToken: f.owner.token, projectId: f.privateProject, taskId: f.privateIssue, body: "@member", mentions: [{ userId: f.member.id, token: "@member" }] })).rejects.toThrow();
  expect(containsMention("https://example.test/@member", "@member")).toBe(false);
  expect(containsMention("@member2", "@member")).toBe(false);
});

test("MCP inbox, completion and deletion are scoped and idempotent", async () => {
  const f = await fixture();
  const grant = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.member.token, teamId: f.teamId, name: "Codex", write: true });
  expect(JSON.parse(await f.t.query(api.connectors.read, { token: grant.token, kind: "inbox" })).issues[0].id).toBe(f.issue);
  const complete = { token: grant.token, requestId: "complete-issue-1", change: { kind: "update_issue" as const, projectId: f.shared, taskId: f.issue, done: true } };
  await f.t.mutation(api.connectors.write, complete);
  await f.t.mutation(api.connectors.write, complete);
  expect((await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue })).task.done).toBe(true);
  expect((await f.t.query(api.projects.get, { sessionToken: f.owner.token, projectId: f.shared })).openIssueCount).toBe(0);
  const request = { token: grant.token, requestId: "delete-issue-1", change: { kind: "delete_issue" as const, projectId: f.shared, taskId: f.issue } };
  expect(await f.t.mutation(api.connectors.write, request)).toBe(await f.t.mutation(api.connectors.write, request));
  const read = await f.t.mutation(api.connectors.createGrant, { sessionToken: f.owner.token, teamId: f.teamId, name: "Read-only", write: false });
  await expect(f.t.mutation(api.connectors.write, { ...request, token: read.token })).rejects.toThrow();
  await expect(f.t.query(api.connectors.read, { token: grant.token, kind: "issue", projectId: f.privateProject, taskId: f.privateIssue })).rejects.toThrow();
});

test("a merge receipt completes a mirrored issue once, and stale or repeated GitHub reports change nothing", async () => {
  const f = await fixture();
  const args = { projectId: f.shared, taskId: f.issue, repoUrl: "https://github.com/example/shared", number: 1, issueUrl: "https://github.com/example/shared/issues/1", state: "closed" as const, updatedAt: Date.now() };
  await f.t.mutation(internal.integrations.linkIssue, args);
  await f.t.mutation(internal.integrations.linkIssue, args);
  expect((await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue })).task.done).toBe(false);
  const receipt = { projectId: f.shared, taskId: f.issue, repoUrl: args.repoUrl, issueNumber: args.number, pullRequest: { number: 9, headSha: "a".repeat(40), mergeSha: "b".repeat(40), mergedAt: args.updatedAt } };
  await f.t.mutation(internal.integrations.completeMergedIssue, receipt);
  await f.t.mutation(internal.integrations.completeMergedIssue, receipt);
  await f.t.mutation(internal.integrations.linkIssue, { ...args, state: "open", updatedAt: args.updatedAt - 1 });
  expect((await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue })).task.done).toBe(true);
  expect((await f.t.query(api.projects.get, { sessionToken: f.owner.token, projectId: f.shared })).openIssueCount).toBe(0);
  await f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue, done: false });
  expect((await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue })).task.done).toBe(false);
  await f.t.mutation(internal.integrations.linkIssue, args);
  expect((await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue })).task.done).toBe(false);
  await f.t.mutation(internal.integrations.completeMergedIssue, receipt);
  expect((await f.t.query(api.tasks.details, { sessionToken: f.owner.token, projectId: f.shared, taskId: f.issue })).task.done).toBe(false);
});

test("repository linking normalizes URLs and only workspace admins approve credential use", async () => {
  const f = await fixture();
  expect(repositoryUrl("https://github.com/example/project.git")).toBe("https://github.com/example/project");
  for (const url of ["https://github.com.evil.test/a/b", "https://secret@github.com/a/b", "javascript:alert(1)"]) expect(() => repositoryUrl(url)).toThrow();
  const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Member project", repoUrl: "https://github.com/example/member" });
  expect((await f.t.query(api.projects.get, { sessionToken: f.member.token, projectId })).githubWorkspaceAccess).toBe(false);
  await f.t.mutation(api.projects.update, { sessionToken: f.owner.token, projectId, repoUrl: "https://github.com/example/approved" });
  expect((await f.t.query(api.projects.get, { sessionToken: f.member.token, projectId })).githubWorkspaceAccess).toBe(true);
  await f.t.mutation(api.projects.update, { sessionToken: f.member.token, projectId, repoUrl: "https://github.com/example/different" });
  expect((await f.t.query(api.projects.get, { sessionToken: f.member.token, projectId })).githubWorkspaceAccess).toBe(false);
});

test("a member who creates a project can share it, but not into projects they do not own", async () => {
  const f = await fixture();
  const projectId = await f.t.mutation(api.projects.create, { sessionToken: f.member.token, teamId: f.teamId, name: "Member share", repoUrl: "https://github.com/example/member-share" });
  await f.t.mutation(api.members.addWorkspaceMember, { sessionToken: f.member.token, projectId, email: f.viewer.email, role: "viewer" });
  expect((await f.t.query(api.projects.get, { sessionToken: f.viewer.token, projectId })).memberRole).toBe("viewer");
  await expect(f.t.mutation(api.members.addWorkspaceMember, { sessionToken: f.member.token, projectId: f.shared, email: f.viewer.email, role: "member" })).rejects.toThrow("Only admins can do this");
});

test("assignees and legacy local attachments respect project membership", async () => {
  const f = await fixture();
  const people = await f.t.query(api.members.people, { sessionToken: f.owner.token, projectId: f.privateProject });
  expect(people.map(p => p.email)).toEqual([f.owner.email]);
  expect(people.every(p => !("inviteToken" in p))).toBe(true);
  await expect(f.t.mutation(api.tasks.updateTask, { sessionToken: f.owner.token, projectId: f.privateProject, taskId: f.privateIssue, assignedToEmail: f.member.email })).rejects.toThrow();
  const fileId = "b3bc0123-4567-4567-8567-012345678901";
  await f.t.mutation(api.tasks.addAsset, { sessionToken: f.owner.token, projectId: f.privateProject, taskId: f.privateIssue, type: "file", name: "Design notes", localFileId: fileId, size: 12 });
  expect(await f.t.query(api.tasks.authorizeLocalFile, { sessionToken: f.owner.token, teamId: f.teamId, fileId })).toBe(null);
  await expect(f.t.query(api.tasks.authorizeLocalFile, { sessionToken: f.member.token, teamId: f.teamId, fileId })).rejects.toThrow();
});
