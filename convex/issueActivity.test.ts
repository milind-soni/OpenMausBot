/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { createSession } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

test("an agent is a listed connection; delegating records Activity and keeps the human assignee", async () => {
  const t = convexTest(schema, modules);
  const owner = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Owner", username: "owner", email: "owner@agents.test", role: "user", status: "active", passwordHash: "x", salt: "x", iterations: 1, createdAt: 1, updatedAt: 1 });
    return { id, session: await createSession(ctx, id) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.session, name: "Agents" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: owner.session, teamId, name: "Web" });
  const bot = await t.mutation(api.mcp.createToken, { sessionToken: owner.session, teamId, name: "Grok Bot", write: true });
  const taskId = await t.mutation(api.tasks.createTask, { sessionToken: owner.session, projectId, title: "Import CSV", priority: "medium", assignedToEmail: "owner@agents.test" });

  expect(await t.query(api.issueActivity.agents, { sessionToken: owner.session, projectId })).toEqual([]);
  await expect(t.mutation(api.issueActivity.delegate, { sessionToken: owner.session, projectId, taskId, grantId: bot.grantId })).rejects.toThrow("can't take issues");
  await t.mutation(api.issueActivity.setDelegatable, { sessionToken: owner.session, teamId, grantId: bot.grantId, delegatable: true });
  expect(await t.query(api.issueActivity.agents, { sessionToken: owner.session, projectId })).toEqual([{ id: bot.grantId, name: "Grok Bot", owner: "Owner" }]);

  await t.mutation(api.issueActivity.delegate, { sessionToken: owner.session, projectId, taskId, grantId: bot.grantId });
  const task = await t.run(ctx => ctx.db.get(taskId as Id<"tasks">));
  expect(task).toMatchObject({ assignedToEmail: "owner@agents.test", delegateGrantId: bot.grantId, delegateName: "Grok Bot" });
  const activity = await t.query(api.issueActivity.list, { sessionToken: owner.session, projectId, taskId });
  expect(activity.map(row => [row.kind, row.actorName, row.to])).toEqual([["delegated", "Owner", "Grok Bot"]]);

  // Unlisting the agent takes it off its open issues, on the record.
  await t.mutation(api.issueActivity.setDelegatable, { sessionToken: owner.session, teamId, grantId: bot.grantId, delegatable: false });
  expect((await t.run(ctx => ctx.db.get(taskId as Id<"tasks">)))!.delegateGrantId).toBeUndefined();
  expect((await t.query(api.issueActivity.list, { sessionToken: owner.session, projectId, taskId })).map(row => row.kind)).toEqual(["delegated", "undelegated"]);
});

test("over MCP an agent can take an issue, report on it, and its writes land in Activity; get_inbox lists it", async () => {
  const t = convexTest(schema, modules);
  const owner = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Owner", username: "owner", email: "owner@agents.test", role: "user", status: "active", passwordHash: "x", salt: "x", iterations: 1, createdAt: 1, updatedAt: 1 });
    return { id, session: await createSession(ctx, id) };
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken: owner.session, name: "Agents" });
  const projectId = await t.mutation(api.projects.create, { sessionToken: owner.session, teamId, name: "Web" });
  const bot = await t.mutation(api.mcp.createToken, { sessionToken: owner.session, teamId, name: "Grok Bot", write: true });
  const taskId = await t.mutation(api.tasks.createTask, { sessionToken: owner.session, projectId, title: "Import CSV", priority: "medium", assignedToEmail: "owner@agents.test" });

  await expect(t.mutation(api.mcp.delegateIssue, { token: bot.token, issueId: taskId, agent: "me" })).rejects.toThrow("doesn't take issues");
  await t.mutation(api.issueActivity.setDelegatable, { sessionToken: owner.session, teamId, grantId: bot.grantId, delegatable: true });
  expect(JSON.parse(await t.query(api.mcp.agents, { token: bot.token, project: "Web" })).you).toMatchObject({ name: "Grok Bot", takesIssues: true });
  const issue = JSON.parse(await t.mutation(api.mcp.delegateIssue, { token: bot.token, issueId: taskId, agent: "me" }));
  expect(issue).toMatchObject({ delegate: { name: "Grok Bot" }, assignee: { email: "owner@agents.test" } });
  expect(JSON.parse(await t.query(api.mcp.inbox, { token: bot.token })).delegated.map((row: { id: string }) => row.id)).toEqual([taskId]);

  await t.mutation(api.mcp.addAgentActivity, { token: bot.token, issueId: taskId, kind: "question", body: "CSV or XLSX?" });
  await t.mutation(api.mcp.addComment, { token: bot.token, issueId: taskId, body: "Proposed spec in the description." });
  const log = JSON.parse(await t.query(api.mcp.issueActivity, { token: bot.token, issueId: taskId }));
  expect(log.activity.map((row: { kind: string; agentName: string | null }) => [row.kind, row.agentName])).toEqual([["delegated", "Grok Bot"], ["question", "Grok Bot"], ["commented", "Grok Bot"]]);

  await t.mutation(api.mcp.delegateIssue, { token: bot.token, issueId: taskId, agent: "none" });
  expect(JSON.parse(await t.query(api.mcp.issueActivity, { token: bot.token, issueId: taskId })).delegate).toBeNull();
});
