/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { createSession } from "./lib/auth";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const originalRepo = "https://github.com/fixture/original";
const replacementRepo = "https://github.com/fixture/replacement";

afterEach(() => { vi.unstubAllGlobals(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

async function fixture() {
  const t = convexTest(schema, modules);
  const sessionToken = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Owner", email: "owner@race.test", role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    return createSession(ctx, id);
  });
  const { teamId } = await t.mutation(api.workspaces.create, { sessionToken, name: "Race fixture" });
  const projectId = await t.mutation(api.projects.create, { sessionToken, teamId, name: "GitHub sync", repoUrl: originalRepo });
  const requested = deferred();
  const released = deferred();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    requested.resolve();
    await released.promise;
    const url = String(input);
    if (url.includes("/commits")) return Response.json([{ sha: "original-sha", html_url: `${originalRepo}/commit/original-sha`, commit: { message: "Original repository commit", author: { name: "Author", date: "2026-10-01T12:00:00Z" } } }]);
    if (url.includes("/pulls")) return Response.json([{ number: 2, title: "Original repository PR", html_url: `${originalRepo}/pull/2`, state: "open", created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z", head: { ref: "original-branch" } }]);
    return Response.json([{ number: 1, title: "Original repository issue", html_url: `${originalRepo}/issues/1`, state: "open", updated_at: "2026-10-01T12:00:00Z" }]);
  });
  vi.stubGlobal("fetch", fetch);
  return { t, sessionToken, projectId, requested, released, fetch };
}

describe("GitHub fetch commit boundaries", () => {
  test.each(["issues", "commits"] as const)("an authorized %s response still syncs into its original repository", async kind => {
    const f = await fixture();
    const scope = { sessionToken: f.sessionToken, projectId: f.projectId };
    f.released.resolve();
    const result = kind === "issues" ? await f.t.action(api.github.syncRepo, scope) : await f.t.action(api.commits.syncGitHub, scope);
    expect(result.ok).toBe(true);
    if (kind === "issues") {
      expect((await f.t.query(api.tasks.board, scope)).tasks).toHaveLength(1);
      expect(await f.t.query(api.github.listPullRequests, scope)).toHaveLength(1);
    } else expect(await f.t.query(api.commits.list, scope)).toHaveLength(1);
  });

  test.each(["issues", "commits"] as const)("a delayed %s response cannot enter a replacement repository", async kind => {
    const f = await fixture();
    const scope = { sessionToken: f.sessionToken, projectId: f.projectId };
    const sync = kind === "issues" ? f.t.action(api.github.syncRepo, scope) : f.t.action(api.commits.syncGitHub, scope);
    await f.requested.promise;
    await f.t.mutation(api.projects.update, { ...scope, repoUrl: replacementRepo });
    f.released.resolve();
    await expect(sync).rejects.toThrow("Repository changed");
    expect((await f.t.query(api.tasks.board, scope)).tasks).toEqual([]);
    expect(await f.t.query(api.github.listPullRequests, scope)).toEqual([]);
    expect(await f.t.query(api.commits.list, scope)).toEqual([]);
    expect((await f.t.query(api.projects.get, scope)).repoUrl).toBe(replacementRepo);
  });

  test.each(["issues", "commits"] as const)("a delayed %s response cannot write after sign-out", async kind => {
    const f = await fixture();
    const scope = { sessionToken: f.sessionToken, projectId: f.projectId };
    const sync = kind === "issues" ? f.t.action(api.github.syncRepo, scope) : f.t.action(api.commits.syncGitHub, scope);
    await f.requested.promise;
    await f.t.mutation(api.auth.logout, { sessionToken: f.sessionToken });
    f.released.resolve();
    await expect(sync).rejects.toThrow("Your session has expired. Sign in again.");
    expect(await f.t.run(ctx => ctx.db.query("tasks").collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query("commits").collect())).toEqual([]);
  });
});
