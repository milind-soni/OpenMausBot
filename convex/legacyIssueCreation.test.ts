/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createSession } from "./lib/auth";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const legacyEmail = "legacy-owner@issues.example";
const repoUrl = "https://github.com/fixture/legacy-issues";
let createdNumber = 100;
const post = vi.fn(async (url: string, init?: RequestInit) => {
  expect(url).toBe("https://api.github.com/repos/fixture/legacy-issues/issues");
  expect(init?.method).toBe("POST");
  const number = ++createdNumber;
  return Response.json({ number, html_url: `${repoUrl}/issues/${number}`, state: "open" });
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ORIGIN_LEGACY_OWNER_EMAIL", legacyEmail);
  vi.stubEnv("GITHUB_TOKEN", "synthetic-legacy-token");
  createdNumber = 100;
  post.mockClear();
  vi.stubGlobal("fetch", post);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(options: { linked?: boolean; email?: string; role?: "owner" | "member" | "viewer" } = {}) {
  const t = convexTest(schema, modules);
  const email = options.email ?? legacyEmail;
  const scope = await t.run(async ctx => {
    const userId = await ctx.db.insert("users", { name: "Fixture member", email, role: "user", status: "active", passwordHash: "unused", salt: "unused", iterations: 1, createdAt: 1, updatedAt: 1 });
    const sessionToken = await createSession(ctx, userId);
    const projectId = await ctx.db.insert("projects", { name: "Fixture project", repoUrl, ownerEmail: legacyEmail, status: "active", accent: "#4b57db", createdAt: 1, updatedAt: 1 });
    await ctx.db.insert("members", { projectId, userId, name: "Fixture member", email, role: options.role ?? "owner", status: "active", createdAt: 1, updatedAt: 1 });
    const columnId = await ctx.db.insert("columns", { projectId, title: "Todo", order: 0, isDraft: false, createdAt: 1, updatedAt: 1 });
    const taskId = await ctx.db.insert("tasks", { projectId, columnId, title: "Synthetic issue", description: "Fixture description", priority: "medium", done: false, order: 0, createdAt: 1, updatedAt: 1,
      ...(options.linked ? { githubIssueNumber: 7, githubIssueUrl: `${repoUrl}/issues/7`, githubIssueState: "open" as const } : {}) });
    return { sessionToken, projectId, taskId, columnId };
  });
  return { t, ...scope, call: () => t.action(api.github.createIssueForTask, { sessionToken: scope.sessionToken, projectId: scope.projectId, taskId: scope.taskId, origin: "https://origin.example" }) };
}

describe("legacy GitHub issue creation", () => {
  test("an already linked task returns its existing issue without creating another", async () => {
    const f = await fixture({ linked: true });
    const [result] = await Promise.allSettled([f.call()]);
    const task = await f.t.run(ctx => ctx.db.get(f.taskId));
    expect(task?.githubIssueNumber).toBe(7);
    expect.soft(post).toHaveBeenCalledTimes(0);
    expect.soft(result).toMatchObject({ status: "fulfilled", value: { ok: true, issueUrl: `${repoUrl}/issues/7`, manualUrl: "" } });
  });

  test("concurrent unlinked legacy calls leave automatic creation to the maintained host path", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.call(), f.call()]);
    expect.soft(post).toHaveBeenCalledTimes(0);
    expect.soft((await f.t.run(ctx => ctx.db.get(f.taskId)))?.githubIssueNumber).toBeUndefined();
    for (const result of results) expect.soft(result).toMatchObject({ status: "fulfilled", value: { ok: false, issueUrl: "", manualUrl: expect.stringContaining(`${repoUrl}/issues/new?`) } });
  });

  test("an unconfigured legacy publisher retains the prefilled manual URL", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const result = await (await fixture()).call();
    expect(result).toMatchObject({ ok: false, issueUrl: "" });
    const manual = new URL(result.manualUrl);
    expect(manual.origin + manual.pathname).toBe(`${repoUrl}/issues/new`);
    expect(manual.searchParams.get("title")).toBe("Synthetic issue");
    expect(manual.searchParams.get("body")).toContain("Fixture description");
    expect(post).not.toHaveBeenCalled();
  });

  test("an ordinary active editor retains manual sharing without server-token authority", async () => {
    const result = await (await fixture({ email: "member@issues.example", role: "member" })).call();
    expect(result).toMatchObject({ ok: false, issueUrl: "", manualUrl: expect.stringContaining(`${repoUrl}/issues/new?`) });
    expect(post).not.toHaveBeenCalled();
  });

  test("a viewer cannot use the legacy action", async () => {
    await expect((await fixture({ role: "viewer" })).call()).rejects.toThrow("You have view-only access");
    expect(post).not.toHaveBeenCalled();
  });

  test("an invalid session cannot create or share an issue", async () => {
    const f = await fixture();
    await expect(f.t.action(api.github.createIssueForTask, { projectId: f.projectId, taskId: f.taskId, sessionToken: "synthetic-invalid-session" })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  test("a task from a different project is refused before external work", async () => {
    const f = await fixture();
    await f.t.run(async ctx => {
      const other = await ctx.db.insert("projects", { name: "Other fixture", ownerEmail: legacyEmail, status: "active", accent: "#4b57db", createdAt: 1, updatedAt: 1 });
      await ctx.db.patch(f.taskId, { projectId: other });
    });
    await expect(f.call()).rejects.toThrow("Issue not found");
    expect(post).not.toHaveBeenCalled();
  });

  test("Draft remains private even when legacy credentials are configured", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.columnId, { isDraft: true }));
    await expect(f.call()).rejects.toThrow("Draft issues stay in Origin");
    expect(post).not.toHaveBeenCalled();
  });

  test("an invalid repository keeps the existing empty manual result", async () => {
    const f = await fixture();
    await f.t.run(ctx => ctx.db.patch(f.projectId, { repoUrl: "https://example.invalid/not-github" }));
    expect(await f.call()).toMatchObject({ ok: false, issueUrl: "", manualUrl: "" });
    expect(post).not.toHaveBeenCalled();
  });
});
