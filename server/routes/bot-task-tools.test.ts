import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOT_TASKS_DEFAULTS, type BotTasksSettings } from "../../shared/bot-tasks.ts";
import { GithubError } from "../bot-tasks/github.ts";
import { createBotTasks, type GithubPort } from "../bot-tasks/service.ts";
import { createBotTaskToolRoutes } from "./bot-task-tools.ts";
import { createBotTasksRoutes } from "./bot-tasks.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const NAMES: Record<string, string> = { lin: "Lin", pixel: "Pixel" };
let dir: string;
let settings: BotTasksSettings;
let github: GithubPort;
let bot = "lin";
let sentBody: unknown;

const reply = { sent: undefined as undefined | { status: number; body: Record<string, unknown> } };
const fakeJson = ((_res: unknown, status: number, body: Record<string, unknown>) => { reply.sent = { status, body }; }) as unknown as RouteContext["json"];
const call = async (route: RouteHandler, method: string, path: string, body?: unknown, auth: unknown = {}) => {
  reply.sent = undefined;
  const url = new URL(path, "http://x");
  const outcome = await route({ req: {}, res: {}, url, path: url.pathname, method, auth, json: fakeJson, readBody: async () => body } as unknown as RouteContext);
  return outcome === PASS ? PASS : reply.sent!;
};

const make = () => {
  const tasks = createBotTasks({ dataDir: dir, settings: () => settings, botName: (id) => NAMES[id], github: () => github, log: () => {} });
  const tools = createBotTaskToolRoutes({
    tasks, settings: () => settings, requireActive: () => {}, botId: () => bot, readBody: async () => sentBody, botName: (id) => NAMES[id],
    bots: () => Object.entries(NAMES).map(([id, name]) => ({ id, name })),
  });
  return { tasks, tools };
};
const tool = async (route: RouteHandler, action: string, body: unknown) => {
  reply.sent = undefined;
  sentBody = body;
  const url = new URL(`/api/internal/bot-tasks/${action}`, "http://x");
  await route({ req: {}, res: {}, url, path: url.pathname, method: "POST", auth: {}, json: fakeJson, readBody: async () => body } as unknown as RouteContext);
  return reply.sent!;
};
const text = (sent: { body: Record<string, unknown> }) => String(sent.body.text ?? sent.body.error);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-bot-task-tools-"));
  settings = { ...BOT_TASKS_DEFAULTS, enabled: true, githubSync: true, repos: ["Acme/Widgets"] };
  bot = "lin";
  github = {
    pullCommitEvidence: vi.fn(async () => null),
    lookupEvidence: vi.fn(async () => ({ sha: "abc1234" })),
    sync: vi.fn(async () => ({ ref: { repo: "Acme/Widgets", number: 5, kind: "pull" as const }, githubState: { state: "open" as const }, activity: [{ key: "comment:1", at: Date.now(), by: { kind: "github" as const, login: "sam" }, type: "github_comment" as const, text: "Please rebase" }] })),
    pull: vi.fn(async () => ({ kind: "pull" as const, state: "open" as const, mergeable: true, headSha: "a".repeat(40), htmlUrl: "https://github.com/Acme/Widgets/pull/5" })),
    postComment: vi.fn(async () => ({ id: 9, url: "https://github.com/Acme/Widgets/pull/5#issuecomment-9" })),
    merge: vi.fn(async () => ({ merged: true })),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the bot task tools", () => {
  it("passes other paths on, and answers 404 while the feature is off", async () => {
    const { tools } = make();
    expect(await call(tools, "POST", "/api/internal/board/add", {})).toBe(PASS);
    expect(await call(tools, "GET", "/api/internal/bot-tasks/list")).toMatchObject({ status: 405 });
    settings = { ...settings, enabled: false };
    expect(await tool(tools, "list", {})).toMatchObject({ status: 404 });
  });

  it("creates, lists, updates and reads a task as the calling bot", async () => {
    const { tools } = make();
    const created = await tool(tools, "create", { title: "Fix scan crash", text: "see Acme/Widgets#5" });
    expect(created.status).toBe(201);
    const id = /tsk_\w+/.exec(text(created))![0];
    expect(text(created)).toContain("linked to Acme/Widgets#5");
    expect(text(await tool(tools, "list", { mine: true }))).toContain(`- ${id} [open] Fix scan crash · Lin · Acme/Widgets#5`);
    bot = "pixel";
    expect(text(await tool(tools, "list", { mine: true }))).toBe("No tasks.");
    expect((await tool(tools, "update", { id, status: "in_progress" })).status).toBe(403);
    bot = "lin";
    expect(text(await tool(tools, "update", { id, status: "in_progress" }))).toContain("is now in_progress");
    expect(text(await tool(tools, "comment", { id, text: "Cause found." }))).toContain("It stays in this app");
    expect(github.postComment).not.toHaveBeenCalled();
    const got = text(await tool(tools, "get", { id }));
    expect(got).toContain("Acme/Widgets#5");
    expect(got).toContain("open → in_progress");
    expect(got).toContain("Cause found.");
  });

  it("refuses done without evidence and says what to send", async () => {
    const { tools } = make();
    const id = /tsk_\w+/.exec(text(await tool(tools, "create", { title: "x" })))![0];
    const refused = await tool(tools, "update", { id, status: "done" });
    expect(refused.status).toBe(422);
    expect(text(refused)).toMatch(/needs evidence/);
    const done = await tool(tools, "update", { id, status: "done", evidence: [{ kind: "command", command: "pnpm test", exitCode: 0 }], comment: "all green" });
    expect(done.status).toBe(200);
    expect(text(await tool(tools, "get", { id }))).toContain("evidence: `pnpm test` exit 0");
  });

  it("waits for GitHub evidence and keeps the owner when the move is blocked", async () => {
    settings.githubSync = false;
    github.lookupEvidence = vi.fn(async () => { throw new GithubError("missing", 404); });
    const { tools, tasks } = make();
    const id = /tsk_\w+/.exec(text(await tool(tools, "create", { title: "x", github: "Acme/Widgets#5" })))![0];
    const result = await tool(tools, "update", { id, status: "done", owner: "Pixel", evidence: [{ kind: "commit", sha: "abc1234" }] });
    expect(result.status).toBe(422);
    expect(text(result)).toBe("Blocked: commit abc1234 not found in Acme/Widgets.");
    expect(tasks.get(id)).toMatchObject({ ownerBotId: "lin", status: "open" });
  });

  it("hands a task over by bot name and rejects an unknown bot", async () => {
    const { tools, tasks } = make();
    const id = /tsk_\w+/.exec(text(await tool(tools, "create", { title: "x", owner: "@pixel" })))![0];
    expect(tasks.get(id).ownerBotId).toBe("pixel");
    expect((await tool(tools, "create", { title: "y", owner: "nobody" })).status).toBe(400);
  });

  it("links a pull request and reads GitHub news with sync", async () => {
    const { tools } = make();
    const id = /tsk_\w+/.exec(text(await tool(tools, "create", { title: "x" })))![0];
    expect(text(await tool(tools, "link", { id, ref: "https://github.com/Acme/Widgets/pull/5" }))).toContain("linked to Acme/Widgets#5");
    const got = text(await tool(tools, "get", { id, sync: true }));
    expect(github.sync).toHaveBeenCalledWith(expect.objectContaining({ id }), 0);
    expect(got).toContain("sam (GitHub) commented on GitHub: Please rebase");
    expect(text(await tool(tools, "get", { id, sync: true }))).toContain("GitHub: nothing new");
    settings = { ...settings, githubSync: false };
    expect(text(await tool(tools, "get", { id, sync: true }))).toContain("GitHub sync did not run");
  });

  it("rejects unknown fields and bad values with the usage line", async () => {
    const { tools } = make();
    expect(text(await tool(tools, "create", { title: "x", bogus: 1 }))).toMatch(/task_create takes/);
    expect(text(await tool(tools, "update", { id: "t", status: "finished" }))).toMatch(/task_update takes/);
    expect((await tool(tools, "update", { id: "t" })).status).toBe(400);
    expect((await tool(tools, "nothing", {})).status).toBe(404);
    expect((await tool(tools, "get", { id: "tsk_missing" })).status).toBe(404);
  });

  it("has no bot-side GitHub write even when the owner enables UI posting", async () => {
    settings = { ...settings, allowOutboundComments: true, allowMerge: true };
    const { tools } = make();
    expect((await tool(tools, "post", { id: "tsk_1", text: "merge", merge: true })).status).toBe(404);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(github.merge).not.toHaveBeenCalled();
  });
});

describe("the app's task routes", () => {
  const admin = { kind: "session", session: { email: "p@example.com" }, scopes: ["admin"] };
  const expectedRef = { repo: "Acme/Widgets", number: 5 };
  const routes = (enabled = true) => {
    const { tasks } = make();
    return { tasks, route: createBotTasksRoutes({ tasks, enabled: () => enabled, person: () => "Sam" }) };
  };

  it("answers an empty, disabled list when the feature is off, and 404 for one task", async () => {
    const { route } = routes(false);
    expect(await call(route, "GET", "/api/bot-tasks")).toEqual({ status: 200, body: { enabled: false, tasks: [] } });
    expect(await call(route, "GET", "/api/bot-tasks/tsk_1")).toMatchObject({ status: 404 });
    expect(await call(route, "GET", "/api/other")).toBe(PASS);
  });

  it("lists with filters, returns one task with its owner's name, and refuses a bad status", async () => {
    const { route, tasks } = routes();
    const a = tasks.create({ title: "Scanner", ownerBotId: "lin", by: { kind: "bot", id: "lin", name: "Lin" }, github: "Acme/Widgets#5" }).task;
    tasks.create({ title: "Page", ownerBotId: "pixel", by: { kind: "bot", id: "pixel", name: "Pixel" } });
    const all = await call(route, "GET", "/api/bot-tasks");
    expect((all as unknown as { body: { tasks: unknown[] } }).body.tasks).toHaveLength(2);
    expect(((await call(route, "GET", "/api/bot-tasks?bot=lin&repo=acme/widgets&status=open&q=scan")) as unknown as { body: { tasks: Array<{ id: string }> } }).body.tasks.map((task) => task.id)).toEqual([a.id]);
    expect(await call(route, "GET", "/api/bot-tasks?status=nope")).toMatchObject({ status: 400 });
    const one = (await call(route, "GET", `/api/bot-tasks/${a.id}`)) as unknown as { body: { task: { id: string }; ownerName: string } };
    expect(one.body.ownerName).toBe("Lin");
    expect(one.body.task.id).toBe(a.id);
    expect(await call(route, "GET", "/api/bot-tasks/tsk_missing")).toMatchObject({ status: 404 });
    expect(await call(route, "POST", "/api/bot-tasks")).toMatchObject({ status: 405 });
  });

  it("verifies REST status updates and returns evidence on the task and its status entry", async () => {
    settings.githubSync = false;
    const { route, tasks } = routes();
    const { task: { id } } = tasks.create({ title: "x", ownerBotId: "lin", by: { kind: "system" }, github: "Acme/Widgets#5" });
    const path = `/api/bot-tasks/${id}`;
    const evidence = [{ kind: "commit", sha: "abc1234" }];
    expect(await call(route, "PATCH", path, { status: "done", evidence }, admin)).toMatchObject({
      status: 200, body: { ok: true, task: { status: "done", evidence: [{ verification: { status: "verified" } }] } },
    });
    expect(await call(route, "GET", path, undefined, admin)).toMatchObject({
      status: 200, body: { task: { activity: expect.arrayContaining([expect.objectContaining({
        type: "status", by: { kind: "person", name: "Sam" }, evidence: [{ kind: "commit", sha: "abc1234", verification: {
          status: "verified", detail: "commit abc1234 exists in Acme/Widgets.", checkedAt: expect.any(Number),
        } }],
      })]) } },
    });
  });

  it("syncs on demand even with polling off", async () => {
    settings = { ...settings, githubSync: false };
    const { route, tasks } = routes();
    const id = tasks.create({ title: "x", ownerBotId: "lin", by: { kind: "bot", id: "lin", name: "Lin" }, github: "Acme/Widgets#5" }).task.id;
    const synced = (await call(route, "POST", `/api/bot-tasks/${id}/sync`)) as unknown as { status: number; body: { ok: boolean; task: { activity: unknown[] } } };
    expect(synced.status).toBe(200);
    expect(synced.body.task.activity.length).toBeGreaterThan(2);
  });

  it("checks the actor, displayed ref and prepared head for a merge", async () => {
    settings = { ...settings, githubSync: false, allowOutboundComments: true, allowMerge: true };
    const { route, tasks } = routes();
    const id = tasks.create({ title: "x", ownerBotId: "lin", by: { kind: "system" }, github: "Acme/Widgets#5" }).task.id;
    const path = `/api/bot-tasks/${id}`;
    const sha = "a".repeat(40);
    const prep = `${path}/merge-head?repo=Acme%2FWidgets&number=5`;
    expect(await call(route, "GET", prep, undefined, { ...admin, scopes: ["client"] })).toMatchObject({ status: 403 });
    expect(await call(route, "GET", prep, undefined, admin)).toMatchObject({ status: 200, body: { sha } });
    expect(await call(route, "POST", `${path}/post`, { text: "merge", expectedRef, merge: true }, admin)).toMatchObject({ status: 400 });
    expect(await call(route, "POST", `${path}/post`, { text: "merge", expectedRef, merge: true, sha: "b".repeat(40) }, admin)).toMatchObject({ status: 409 });
    expect(await call(route, "POST", `${path}/link`, { ref: "Acme/Widgets#6" }, admin)).toMatchObject({ status: 200 });
    expect(await call(route, "POST", `${path}/post`, { text: "merge", expectedRef, merge: true, sha }, admin)).toMatchObject({ status: 409 });
    expect(github.merge).not.toHaveBeenCalled();
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("posts a person's comment only when Settings allow it, as that person", async () => {
    const { route, tasks } = routes();
    const id = tasks.create({ title: "x", ownerBotId: "lin", by: { kind: "bot", id: "lin", name: "Lin" }, github: "Acme/Widgets#5" }).task.id;
    expect(await call(route, "POST", `/api/bot-tasks/${id}/post`, { text: "hello", expectedRef }, admin)).toMatchObject({ status: 403 });
    settings = { ...settings, allowOutboundComments: true };
    expect(await call(route, "POST", `/api/bot-tasks/${id}/post`, { text: "hello", extra: 1 }, admin)).toMatchObject({ status: 400 });
    const posted = (await call(route, "POST", `/api/bot-tasks/${id}/post`, { text: "hello", expectedRef }, admin)) as unknown as { status: number; body: { url: string; task: { activity: Array<{ type: string; by: unknown }> } } };
    expect(posted.status).toBe(200);
    expect(posted.body.task.activity.at(-1)).toMatchObject({ type: "posted", by: { kind: "person", name: "Sam" } });
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });
});
