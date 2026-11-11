/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

// What project bots reach over MCP beyond issues: acceptance criteria, Needs spec, assets, the Vault, repositories
// and linked pull requests (also the project's Pull requests section).

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function fixture() {
  const t = convexTest(schema, modules);
  const people = await t.run(async ctx => {
    const rows = [];
    for (const name of ["Owner", "Member"]) {
      const email = `${name.toLowerCase()}@bots.test`;
      const id = await ctx.db.insert("users", { name, username: name.toLowerCase(), email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
      rows.push({ id, email, session: await createSession(ctx, id) });
    }
    return { owner: rows[0]!, member: rows[1]! };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: people.owner.session, name: "Bots" });
  await t.run(ctx => ctx.db.insert("teamMembers", { teamId, userId: people.member.id, email: people.member.email, name: "Member", role: "member", status: "active", createdAt: 1, updatedAt: 1 }));
  const shared = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "Shared" });
  const secret = await t.mutation(api.projects.create, { sessionToken: people.owner.session, teamId, name: "Secret" });
  await t.mutation(api.members.addWorkspaceMember, { sessionToken: people.owner.session, projectId: shared, email: people.member.email, role: "member" });
  const token = async (person: { session: string }, write = true) => (await t.mutation(api.mcp.createToken, { sessionToken: person.session, teamId, name: "bot", write })).token;
  const member = await token(people.member);
  const owner = await token(people.owner);
  const create = async (args: Record<string, unknown>, as = member) => JSON.parse(await t.mutation(api.mcp.createIssue, { token: as, project: "Shared", title: "Note", ...args }));
  return { t, ...people, teamId, shared, secret, token, memberToken: member, ownerToken: owner, create };
}

describe("acceptance criteria and Needs spec", () => {
  test("a bare note gets Needs spec; a description plus criteria removes it and keeps other labels", async () => {
    const f = await fixture();
    const note = await f.create({ labels: ["Bug"] });
    expect(note.labels).toEqual(["Bug", "Needs spec"]);
    expect(note.acceptanceCriteria).toEqual([]);
    const described = JSON.parse(await f.t.mutation(api.mcp.updateIssue, { token: f.memberToken, issueId: note.id, description: "Users import a CSV." }));
    expect(described.labels).toEqual(["Bug", "Needs spec"]);
    const specified = JSON.parse(await f.t.mutation(api.mcp.addAcceptanceCriteria, { token: f.memberToken, issueId: note.key, items: ["Imports 10k rows", "Reports bad rows"] }));
    expect(specified.labels).toEqual(["Bug"]);
    expect(specified.acceptanceCriteria).toEqual([{ text: "Imports 10k rows", checked: false }, { text: "Reports bad rows", checked: false }]);
    // Clearing the spec later does not put the label back.
    const cleared = JSON.parse(await f.t.mutation(api.mcp.updateAcceptanceCriteria, { token: f.memberToken, issueId: note.id, replace: [] }));
    expect(cleared).toMatchObject({ labels: ["Bug"], acceptanceCriteria: [] });
    // The workspace registry knows the label, with its description.
    const { labels } = await f.t.query(api.labels.list, { sessionToken: f.owner.session, teamId: f.teamId });
    expect(labels.find(label => label.name === "Needs spec")).toMatchObject({ _id: expect.any(String), color: "#d4a72c", description: expect.stringContaining("acceptance criteria") });
  });

  test("issues created with a description, criteria or outside Draft never get it; an archived label opts the workspace out", async () => {
    const f = await fixture();
    expect((await f.create({ description: "Why" })).labels).toBeUndefined();
    expect((await f.create({ acceptanceCriteria: ["Works"] })).labels).toBeUndefined();
    expect((await f.create({ column: "Todo" })).labels).toBeUndefined();
    await f.t.mutation(api.labels.update, { sessionToken: f.owner.session, teamId: f.teamId, labelId: null, currentName: "Needs spec", archived: true });
    expect((await f.create({})).labels).toBeUndefined();
  });

  test("the board composer's labels arrive with the issue, next to Needs spec", async () => {
    const f = await fixture();
    const taskId = await f.t.mutation(api.tasks.createTask, { sessionToken: f.member.session, projectId: f.shared, title: "From the composer", priority: "medium", labels: ["Bug", "Design", "design"] });
    const task = await f.t.run(ctx => ctx.db.get(taskId));
    expect(task!.labels).toEqual(["Bug", "Design", "Needs spec"]);
  });

  test("update_acceptance_criteria checks, edits and removes by index or text, and list/get return the list", async () => {
    const f = await fixture();
    const issue = await f.create({ acceptanceCriteria: ["One", "Two", "Three"] });
    const updated = JSON.parse(await f.t.mutation(api.mcp.updateAcceptanceCriteria, { token: f.memberToken, issueId: issue.id, changes: [{ index: 0, checked: true }, { match: "two", text: "Two, edited" }, { index: 2, remove: true }] }));
    expect(updated.acceptanceCriteria).toEqual([{ text: "One", checked: true }, { text: "Two, edited", checked: false }]);
    const listed = JSON.parse(await f.t.query(api.mcp.issues, { token: f.memberToken, project: "Shared" })).issues.find((i: { id: string }) => i.id === issue.id);
    expect(listed.acceptanceCriteria).toEqual(updated.acceptanceCriteria);
    expect(JSON.parse(await f.t.query(api.mcp.issue, { token: f.memberToken, issueId: issue.id })).acceptanceCriteria).toEqual(updated.acceptanceCriteria);
    await expect(f.t.mutation(api.mcp.updateAcceptanceCriteria, { token: f.memberToken, issueId: issue.id, changes: [{ index: 5, checked: true }] })).rejects.toThrow("No acceptance criterion at index 5");
    await expect(f.t.mutation(api.mcp.updateAcceptanceCriteria, { token: f.memberToken, issueId: issue.id })).rejects.toThrow("either changes or replace");
    const readOnly = await f.token(f.member, false);
    await expect(f.t.mutation(api.mcp.addAcceptanceCriteria, { token: readOnly, issueId: issue.id, items: ["x"] })).rejects.toThrow();
  });

  test("the issue page's edits name the item by index and text, so a stale edit fails", async () => {
    const f = await fixture();
    const issue = await f.create({ description: "Spec", acceptanceCriteria: ["One", "Two"] });
    const edit = (edits: { index: number; match: string; checked?: boolean; remove?: boolean }[]) => f.t.mutation(api.tasks.updateAcceptanceCriteria, { sessionToken: f.member.session, projectId: f.shared, taskId: issue.id as Id<"tasks">, edits });
    await edit([{ index: 1, match: "Two", checked: true }]);
    await f.t.mutation(api.mcp.updateAcceptanceCriteria, { token: f.ownerToken, issueId: issue.id, changes: [{ index: 0, remove: true }] });
    await expect(edit([{ index: 1, match: "Two", checked: false }])).rejects.toThrow("changed");
    await f.t.mutation(api.tasks.updateAcceptanceCriteria, { sessionToken: f.member.session, projectId: f.shared, taskId: issue.id as Id<"tasks">, add: ["Three"] });
    expect((await f.t.run(ctx => ctx.db.get(issue.id as Id<"tasks">)))!.acceptanceCriteria).toEqual([{ text: "Two", checked: true }, { text: "Three", checked: false }]);
  });
});

describe("assets", () => {
  test("lists library files and issue attachments the token can see; uploaded issue files have no url", async () => {
    const f = await fixture();
    const issue = await f.create({ description: "x" });
    await f.t.run(async ctx => {
      await ctx.db.insert("designAssets", { projectId: f.shared, type: "figma", name: "Design system", url: "https://figma.com/file/abc", notes: "Tokens live here", createdAt: 10, updatedAt: 10 });
      await ctx.db.insert("taskAssets", { projectId: f.shared, taskId: issue.id, type: "link", name: "Spec doc", url: "https://docs.example/spec", authorUserId: f.member.id, createdAt: 20 });
      await ctx.db.insert("taskAssets", { projectId: f.shared, taskId: issue.id, type: "file", name: "trace.log", url: "", localFileId: "00000000-0000-0000-0000-000000000000", size: 12, contentType: "text/plain", authorUserId: f.member.id, createdAt: 30 });
      await ctx.db.insert("designAssets", { projectId: f.secret, type: "image", name: "Secret logo", url: "https://img.example/x.png", createdAt: 40, updatedAt: 40 });
    });
    const { assets } = JSON.parse(await f.t.query(api.mcp.assets, { token: f.memberToken }));
    expect(assets.map((a: { name: string; url: string | null; kind: string }) => [a.name, a.kind, a.url])).toEqual([
      ["trace.log", "file", null], ["Spec doc", "link", "https://docs.example/spec"], ["Design system", "figma", "https://figma.com/file/abc"],
    ]);
    expect(assets[0]).toMatchObject({ project: "Shared", issue: { id: issue.id, key: issue.key }, size: 12, createdAt: new Date(30).toISOString() });
    expect(JSON.parse(await f.t.query(api.mcp.assets, { token: f.memberToken, issueId: issue.id })).assets).toHaveLength(2);
    const library = assets.find((a: { name: string }) => a.name === "Design system");
    expect(JSON.parse(await f.t.query(api.mcp.asset, { token: f.memberToken, assetId: library.id }))).toMatchObject({ name: "Design system", notes: "Tokens live here", issue: null });
    const secretAsset = (JSON.parse(await f.t.query(api.mcp.assets, { token: f.ownerToken, project: "Secret" })).assets)[0];
    await expect(f.t.query(api.mcp.asset, { token: f.memberToken, assetId: secretAsset.id })).rejects.toThrow("Asset not found");
  });
});

describe("vault", () => {
  const sealed = { ciphertext: "c", iv: "i", salt: "s", iterations: 1, kdf: "PBKDF2-SHA256/AES-256-GCM" };
  test("lists and returns only items agents may use, in projects the token can see, plus the owner's own", async () => {
    const f = await fixture();
    const ids = await f.t.run(async ctx => ({
      allowed: await ctx.db.insert("credentials", { projectId: f.shared, kind: "service", service: "convex", title: "Convex deploy", ...sealed, agentUse: true, createdAt: 1, updatedAt: 1 }),
      denied: await ctx.db.insert("credentials", { projectId: f.shared, kind: "password", title: "Admin login", ...sealed, createdAt: 1, updatedAt: 1 }),
      other: await ctx.db.insert("credentials", { projectId: f.secret, kind: "api_key", title: "Secret key", ...sealed, agentUse: true, createdAt: 1, updatedAt: 1 }),
      mine: await ctx.db.insert("personalCredentials", { userId: f.member.id, kind: "api_key", title: "My npm", ...sealed, agentUse: true, createdAt: 1, updatedAt: 1 }),
      theirs: await ctx.db.insert("personalCredentials", { userId: f.owner.id, kind: "api_key", title: "Owner npm", ...sealed, agentUse: true, createdAt: 1, updatedAt: 1 }),
    }));
    const { items } = JSON.parse(await f.t.query(api.mcp.vaultItems, { token: f.memberToken }));
    expect(items.map((item: { name: string; env: string[]; scope: string }) => [item.name, item.env, item.scope])).toEqual([["Convex deploy", ["CONVEX_DEPLOY_KEY"], "project"], ["My npm", [], "personal"]]);
    expect(JSON.stringify(items)).not.toContain("ciphertext");
    expect(JSON.parse(await f.t.query(api.mcp.vaultItem, { token: f.memberToken, itemId: ids.allowed }))).toMatchObject({ name: "Convex deploy", sealed });
    await expect(f.t.query(api.mcp.vaultItem, { token: f.memberToken, itemId: ids.denied })).rejects.toThrow("Agents may not use \"Admin login\"");
    for (const id of [ids.other, ids.theirs]) await expect(f.t.query(api.mcp.vaultItem, { token: f.memberToken, itemId: id })).rejects.toThrow("Vault item not found");
  });
});

describe("repositories and pull requests", () => {
  test("lists linked repos and the PRs linked to issues, grouped per PR, in the MCP tool and the project section", async () => {
    const f = await fixture();
    const a = await f.create({ description: "x" });
    const b = await f.create({ description: "y" });
    await f.t.run(async ctx => {
      await ctx.db.patch(f.shared, { repoUrl: "https://github.com/acme/web" });
      const row = (taskId: string, number: number, state: "open" | "draft" | "merged" | "closed", updatedAt: number, closes?: boolean) => ctx.db.insert("taskPullRequests", {
        repository: "acme/web", projectId: f.shared, taskId: taskId as Id<"tasks">, requesterUserId: f.member.id, number, url: `https://github.com/acme/web/pull/${number}`, branch: `b${number}`,
        title: `PR ${number}`, state, checks: "success", review: "approved", linkSource: "reference", ...(closes === undefined ? {} : { closes }), githubUpdatedAt: updatedAt, updatedAt,
      });
      await row(a.id, 1, "merged", 100);
      await row(a.id, 2, "open", 50);
      await row(b.id, 2, "open", 60, false);
      await row(b.id, 3, "draft", 10);
      await row(b.id, 4, "closed", 200);
    });
    expect(JSON.parse(await f.t.query(api.mcp.repositories, { token: f.memberToken })).repositories).toEqual([{ project: "Shared", projectId: f.shared, repo: "acme/web", url: "https://github.com/acme/web" }]);
    const open = JSON.parse(await f.t.query(api.mcp.pullRequests, { token: f.memberToken })).pullRequests;
    expect(open.map((pr: { number: number; state: string }) => [pr.number, pr.state])).toEqual([[2, "open"], [3, "draft"]]);
    expect(open[0].issues.map((i: { key: string; completesOnMerge: boolean }) => [i.key, i.completesOnMerge])).toEqual(expect.arrayContaining([[a.key, true], [b.key, false]]));
    expect(open[0]).toMatchObject({ repo: "acme/web", title: "PR 2", checks: "success", review: "approved", project: "Shared" });
    expect(JSON.parse(await f.t.query(api.mcp.pullRequests, { token: f.memberToken, state: "merged" })).pullRequests.map((pr: { number: number }) => pr.number)).toEqual([1]);
    expect(JSON.parse(await f.t.query(api.mcp.pullRequests, { token: f.memberToken, state: "all", project: "Shared" })).pullRequests).toHaveLength(4);
    await expect(f.t.query(api.mcp.pullRequests, { token: f.memberToken, project: "Secret" })).rejects.toThrow("Project not found");

    const section = await f.t.query(api.taskPRs.projectPullRequests, { sessionToken: f.member.session, projectId: f.shared });
    expect(section.pullRequests.map(pr => [pr.number, pr.state, pr.issues.length])).toEqual([[2, "open", 2], [3, "draft", 1], [1, "merged", 1], [4, "closed", 1]]);
    expect(section).toMatchObject({ reviewColumn: null, doneColumn: "Done" });
    const review = (await f.t.query(api.taskPRs.columns, { sessionToken: f.owner.session, projectId: f.shared })).find(c => c.title === "In review" || c.title === "In progress")!;
    await f.t.mutation(api.taskPRs.configure, { sessionToken: f.owner.session, projectId: f.shared, mode: "issue", reviewColumnId: review.id });
    expect((await f.t.query(api.taskPRs.projectPullRequests, { sessionToken: f.member.session, projectId: f.shared })).reviewColumn).toBe(review.title);
    await expect(f.t.query(api.taskPRs.projectPullRequests, { sessionToken: f.member.session, projectId: f.secret })).rejects.toThrow();
  });
});
