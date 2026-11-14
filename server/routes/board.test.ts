import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardBroadcast } from "../../shared/board.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { BoardStore } from "../board/store.ts";
import { createBoardRoutes } from "./board.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const admin: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member = (email = "m@example.com"): RequestAuth => ({
  kind: "session", scopes: ["client"], via: "cookie",
  session: { id: `s-${email}`, email, role: "user", createdAt: 0, expiresAt: 0 } as never,
});

function visible(options: { threads?: Set<string>; bots?: Set<string>; all?: boolean } = {}): VisibleSet {
  const threads = options.threads ?? new Set(["t1", "t2"]);
  const bots = options.bots ?? new Set(["b1", "b2"]);
  return {
    everything: Boolean(options.all),
    thread: (id: string) => Boolean(options.all) || threads.has(id),
    bot: (id: string) => Boolean(options.all) || bots.has(id),
    hides: (id: string) => !options.all && !threads.has(id),
  } as unknown as VisibleSet;
}

async function serve(input: {
  auth?: RequestAuth; threads?: Set<string>; bots?: Set<string>; all?: boolean; boardFile?: unknown; folder?: string;
} = {}) {
  const folder = input.folder ?? mkdtempSync(join(tmpdir(), "omb-board-routes-"));
  if (!input.folder) folders.push(folder);
  if (input.boardFile !== undefined) writeFileSync(join(folder, "board.json"), JSON.stringify(input.boardFile));
  const frames: BoardBroadcast[] = [];
  const board = new BoardStore({ file: join(folder, "board.json"), broadcast: (frame) => frames.push(frame), now: () => new Date("2026-11-15T00:00:00.000Z") });
  const threads = input.threads ?? new Set(["t1", "t2", "t3"]);
  const routes = [createBoardRoutes({
    board,
    canManage: (auth) => auth.scopes.includes("admin"),
    threadExists: (botId, threadId) => botId === "b2" ? threadId === "t2" : threadId !== "t2" && threads.has(threadId),
    threadInfo: (botId, threadId) => {
      if (!(botId === "b2" ? threadId === "t2" : threadId !== "t2" && threads.has(threadId))) return null;
      return threadId === "routine" ? { routineRunId: "run-1" } : {};
    },
    visibleFor: () => visible({ threads, bots: input.bots, all: input.all ?? input.auth?.scopes.includes("admin") ?? true }),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: input.auth ?? admin, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, folder, board, frames };
}

const call = async (base: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

async function project(base: string, body: Record<string, unknown> = { name: "创意板", owner: "朱明跃", goal: "交付", acceptance: "上线" }): Promise<string> {
  const created = await call(base, "POST", "/api/board/projects", body);
  expect(created.status).toBe(201);
  return (created.body.board as { projects: Array<{ id: string }> }).projects[0]!.id;
}

describe("/api/board", () => {
  it("serves the whole board and broadcasts every write", async () => {
    const { base, frames } = await serve();
    expect(await call(base, "GET", "/api/board")).toMatchObject({
      status: 200, body: { version: 0, projects: [], tasks: [], capabilities: { manage: true }, counts: { tasks: 0, topLevel: 0, subtasks: 0, done: 0 } },
    });
    const created = await call(base, "POST", "/api/board/projects", { name: "创意板", description: "看板 v1", owner: "朱明跃", goal: "交付", acceptance: "上线" });
    expect(created.status).toBe(201);
    expect((created.body.board as { projects: Array<{ name: string }> }).projects[0]!.name).toBe("创意板");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "board", board: { version: 1 } });
  });

  it("gives a member a filtered read-only board and real counts", async () => {
    const adminServer = await serve();
    const projectId = await project(adminServer.base, {
      name: "创意板", visibility: { people: ["m@example.com"] }, owner: "朱明跃", goal: "交付", acceptance: "上线",
    });
    await call(adminServer.base, "PUT", "/api/board/tasks/t1", {
      botId: "b1", projectId, phase: "build", status: "in_progress", ownerEmail: "m@example.com",
    });
    await call(adminServer.base, "PUT", "/api/board/tasks/t2", { botId: "b2", projectId, phase: "design" });
    const child = await call(adminServer.base, "PUT", "/api/board/tasks/t3", { botId: "b1", projectId, parentThreadId: "t1" });
    expect(child.status, JSON.stringify(child.body)).toBe(200);

    const memberServer = await serve({ auth: member(), folder: adminServer.folder, bots: new Set(["b1"]), threads: new Set(["t1", "t2", "t3"]) });
    const reply = await call(memberServer.base, "GET", "/api/board");
    expect(reply.status).toBe(200);
    const board = reply.body as {
      projects: Array<{ id: string }>; tasks: Array<{ threadId: string }>; capabilities: { manage: boolean };
      counts: { tasks: number; topLevel: number; subtasks: number; done: number };
      permissions: { projects: Record<string, boolean>; tasks: Record<string, boolean> };
    };
    expect(board.projects.map((value) => value.id)).toEqual([projectId]);
    expect(board.tasks.map((value) => value.threadId)).toEqual(["t1", "t3"]);
    expect(board.capabilities.manage).toBe(false);
    expect(board.counts).toEqual({ tasks: 2, topLevel: 1, subtasks: 1, done: 0 });
    expect(board.permissions.tasks.t1).toBe(true);
    expect(board.permissions.projects[projectId]).toBe(false);
  });

  it("lets a project owner change the project and a task owner record their own verdict", async () => {
    const setup = await serve();
    const projectId = await project(setup.base, {
      name: "创意板", visibility: { people: ["m@example.com"] }, ownerEmail: "m@example.com", owner: "朱明跃", goal: "交付", acceptance: "上线",
    });
    await call(setup.base, "PUT", "/api/board/tasks/t1", {
      botId: "b1", projectId, phase: "build", ownerEmail: "m@example.com",
    });

    const memberServer = await serve({ auth: member(), folder: setup.folder, bots: new Set(["b1"]), threads: new Set(["t1"]) });
    expect((await call(memberServer.base, "PATCH", `/api/board/projects/${projectId}`, { goal: "交付" })).status).toBe(200);
    const decided = await call(memberServer.base, "POST", "/api/board/tasks/t1/verdict", {
      decision: "accepted", evidence: "真实 API 通过",
    });
    expect(decided.status).toBe(200);
    expect((decided.body.task as { verdict: { by: string } }).verdict.by).toBe("m@example.com");
    const audit = await call(memberServer.base, "GET", "/api/board/audit");
    expect(audit.status).toBe(403);

    // Assigning the task to another address is not the task owner's call.
    const handed = await call(memberServer.base, "PUT", "/api/board/tasks/t1", {
      botId: "b1", projectId, ownerEmail: "other@example.com",
    });
    expect(handed.status).toBe(403);

    // A task owner may change the work, not move it into a project they do not own.
    const other = await call(setup.base, "POST", "/api/board/projects", {
      name: "另一个项目", visibility: { people: ["m@example.com"] }, owner: "朱明跃", goal: "交付", acceptance: "上线",
    });
    const otherId = (other.body.board as { projects: Array<{ id: string; name: string }> }).projects.find((value) => value.name === "另一个项目")!.id;
    const moved = await call(memberServer.base, "PUT", "/api/board/tasks/t1", { botId: "b1", projectId: otherId });
    expect(moved.status).toBe(403);
  });

  it("refuses a member's project creation, another project's edit, and a hidden conversation", async () => {
    const server = await serve({ auth: member(), bots: new Set(["b1"]), threads: new Set(["t1", "t2"]) });
    expect((await call(server.base, "POST", "/api/board/projects", { name: "x" })).status).toBe(403);
    expect((await call(server.base, "PUT", "/api/board/tasks/t2", { botId: "b2", phase: "build" })).status).toBe(403);
  });

  it("requires project owner/goal/acceptance and subproject owner/deliverable/acceptance", async () => {
    const { base } = await serve();
    expect(await call(base, "POST", "/api/board/projects", { name: "缺字段" })).toMatchObject({ status: 400, body: { error: "BOARD_INVALID", message: "owner is required" } });
    expect(await call(base, "POST", "/api/board/projects", { name: "缺字段", owner: "朱明跃" })).toMatchObject({ status: 400, body: { message: "goal is required" } });
    expect(await call(base, "POST", "/api/board/projects", { name: "缺字段", owner: "朱明跃", goal: "交付" })).toMatchObject({ status: 400, body: { message: "acceptance is required" } });

    const projectId = await project(base);
    expect(await call(base, "POST", "/api/board/subprojects", { projectId, name: "缺字段" })).toMatchObject({ status: 400, body: { message: "owner is required" } });
    expect(await call(base, "POST", "/api/board/subprojects", { projectId, name: "缺字段", owner: "唐僧" })).toMatchObject({ status: 400, body: { message: "deliverable is required" } });
    expect(await call(base, "POST", "/api/board/subprojects", { projectId, name: "缺字段", owner: "唐僧", deliverable: "办理卡" })).toMatchObject({ status: 400, body: { message: "acceptance is required" } });
  });

  it("requires evidence for a subproject phase transition and a receipt for live/done", async () => {
    const { base } = await serve();
    const projectId = await project(base);
    const refused = await call(base, "POST", "/api/board/subprojects", {
      projectId, name: "财税", owner: "唐僧", deliverable: "办理卡", acceptance: "双账号验收", phase: "build",
    });
    expect(refused).toMatchObject({ status: 422, body: { error: "BOARD_NEEDS_EVIDENCE" } });
    const created = await call(base, "POST", "/api/board/subprojects", {
      projectId, name: "财税", owner: "唐僧", deliverable: "办理卡", acceptance: "双账号验收",
    });
    const subprojectId = (created.body.board as { subprojects: Array<{ id: string }> }).subprojects[0]!.id;
    expect(await call(base, "PATCH", `/api/board/subprojects/${subprojectId}`, { phase: "build" })).toMatchObject({
      status: 422, body: { error: "BOARD_NEEDS_EVIDENCE" },
    });
    expect(await call(base, "PATCH", `/api/board/subprojects/${subprojectId}`, { phase: "build", phaseEvidence: "联调通过" })).toMatchObject({ status: 200 });
    expect(await call(base, "PATCH", `/api/board/subprojects/${subprojectId}`, { phase: "done", phaseEvidence: "上线了" })).toMatchObject({
      status: 422, body: { error: "BOARD_NEEDS_EVIDENCE" },
    });
    const done = await call(base, "PATCH", `/api/board/subprojects/${subprojectId}`, {
      phase: "done", phaseEvidence: "https://example.test/receipt/42",
    });
    expect(done.status).toBe(200);
    expect((done.body.board as { subprojects: Array<{ phase: string; phaseEvidence: string }> }).subprojects[0]).toMatchObject({
      phase: "done", phaseEvidence: "https://example.test/receipt/42",
    });
  });

  it("answers 409 for a stale version and 422 for an accepted milestone without evidence", async () => {
    const { base } = await serve();
    const projectId = await project(base);
    expect(await call(base, "POST", "/api/board/subprojects", {
      projectId, name: "看板", owner: "唐僧", deliverable: "办理卡", acceptance: "双账号验收", version: 0,
    })).toMatchObject({
      status: 409, body: { error: "BOARD_VERSION_CONFLICT" },
    });
    const milestone = await call(base, "POST", "/api/board/milestones", { projectId, title: "前端联调" });
    const milestoneId = (milestone.body.board as { milestones: Array<{ id: string }> }).milestones[0]!.id;
    expect(await call(base, "PATCH", `/api/board/milestones/${milestoneId}`, { status: "accepted" })).toMatchObject({
      status: 422, body: { error: "BOARD_NEEDS_EVIDENCE" },
    });
    expect(await call(base, "PATCH", `/api/board/milestones/${milestoneId}`, { status: "accepted", verdict: "通过", evidence: "check exit 0" })).toMatchObject({ status: 200 });
    expect((await call(base, "GET", "/api/board/audit?limit=5")).status).toBe(200);
  });

  it("only attributes a real conversation, then accepts a verdict and unclassifies", async () => {
    const { base, frames } = await serve();
    const projectId = await project(base);

    expect(await call(base, "PUT", "/api/board/tasks/t-missing", { botId: "b1", projectId })).toMatchObject({
      status: 400, body: { error: "BOARD_INVALID" },
    });
    expect(await call(base, "PUT", "/api/board/tasks/t1", { botId: "b2", projectId })).toMatchObject({ status: 400 });
    expect(await call(base, "PUT", "/api/board/tasks/t1", { botId: "b1", projectId, phase: "done" })).toMatchObject({
      status: 422, body: { error: "BOARD_NEEDS_EVIDENCE" },
    });
    const attributed = await call(base, "PUT", "/api/board/tasks/t1", { botId: "b1", projectId, phase: "build", status: "review", owner: "Pixel" });
    expect(attributed.status).toBe(200);
    expect((attributed.body.board as { tasks: Array<{ threadId: string; owner: string }> }).tasks[0]).toMatchObject({ threadId: "t1", owner: "Pixel" });

    const accepted = await call(base, "POST", "/api/board/tasks/t1/verdict", { decision: "accepted", evidence: "真实 API 通过" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.task).toMatchObject({ phase: "build", status: "done", verdict: { decision: "accepted", by: "This computer" } });
    expect(frames.at(-1)?.board.tasks[0]!.phase).toBe("build");

    expect(await call(base, "DELETE", "/api/board/tasks/t1")).toMatchObject({ status: 200, body: { board: { tasks: [] } } });
  });

  it("previews a batch without writing, then links only unclassified work atomically", async () => {
    const { base, board } = await serve({ threads: new Set(["ready", "already", "other", "routine", "ready2"]) });
    const projectA = await project(base, { name: "批量目标", owner: "朱明跃", goal: "交付", acceptance: "上线" });
    const createdB = await call(base, "POST", "/api/board/projects", { name: "别的项目", owner: "朱明跃", goal: "交付", acceptance: "上线" });
    const projectB = (createdB.body.board as { projects: Array<{ id: string; name: string }> }).projects.find((value) => value.name === "别的项目")!.id;
    await call(base, "PUT", "/api/board/tasks/already", { botId: "b1", projectId: projectA });
    await call(base, "PUT", "/api/board/tasks/other", { botId: "b1", projectId: projectB });

    const threads = [
      { threadId: "ready", botId: "b1" },
      { threadId: "already", botId: "b1" },
      { threadId: "other", botId: "b1" },
      { threadId: "routine", botId: "b1" },
      { threadId: "missing", botId: "b1" },
    ];
    const preview = await call(base, "POST", "/api/board/tasks/batch/preview", { projectId: projectA, threads });
    expect(preview.status).toBe(200);
    const previewBody = preview.body as {
      version: number; items: Array<{ threadId: string; status: string }>;
      summary: { total: number; ready: number; alreadyAssigned: number; conflict: number; routine: number; missing: number };
    };
    expect(previewBody.summary).toEqual({ total: 5, ready: 1, alreadyAssigned: 1, missing: 1, hidden: 0, routine: 1, conflict: 1 });
    expect(previewBody.items.find((item) => item.threadId === "ready")?.status).toBe("ready");
    expect(previewBody.items.find((item) => item.threadId === "routine")?.status).toBe("routine");
    expect(board.state().tasks.some((task) => task.threadId === "ready")).toBe(false);
    expect(board.version()).toBe(previewBody.version);

    const refused = await call(base, "POST", "/api/board/tasks/batch", { projectId: projectA, version: previewBody.version, threads });
    expect(refused).toMatchObject({ status: 409, body: { error: "BOARD_BATCH_CONFLICT" } });
    expect(board.state().tasks.some((task) => task.threadId === "ready")).toBe(false);
    expect(board.version()).toBe(previewBody.version);
    const audit = await call(base, "GET", "/api/board/audit?limit=5");
    expect((audit.body.audit as Array<{ action: string; count: number; reason: string }>).at(-1)).toMatchObject({ action: "task.batch", count: 5 });
    expect((audit.body.audit as Array<{ action: string; count: number; reason: string }>).at(-1)!.reason).toContain("conflict=1");

    const confirmed = await call(base, "POST", "/api/board/tasks/batch", {
      projectId: projectA, version: board.version(), threads: [{ threadId: "ready", botId: "b1" }],
    });
    expect(confirmed.status).toBe(200);
    expect((confirmed.body.batch as { assigned: number }).assigned).toBe(1);
    expect(board.state().tasks.find((task) => task.threadId === "ready")).toMatchObject({ projectId: projectA });
    expect(board.version()).toBe(previewBody.version + 1);

    const stale = await call(base, "POST", "/api/board/tasks/batch", {
      projectId: projectA, version: previewBody.version, threads: [{ threadId: "ready2", botId: "b1" }],
    });
    expect(stale).toMatchObject({ status: 409, body: { error: "BOARD_VERSION_CONFLICT" } });
    expect(board.state().tasks.some((task) => task.threadId === "ready2")).toBe(false);
  });

  it("defaults new projects to admins and only shares on an explicit everyone", async () => {
    const setup = await serve();
    const created = await call(setup.base, "POST", "/api/board/projects", { name: "默认安全", owner: "朱明跃", goal: "交付", acceptance: "上线" });
    const projectId = (created.body.board as { projects: Array<{ id: string; visibility: string }> }).projects[0]!;
    expect(projectId.visibility).toBe("admins");

    const memberServer = await serve({ auth: member(), folder: setup.folder, bots: new Set(["b1"]), threads: new Set(["t1"]) });
    expect(((await call(memberServer.base, "GET", "/api/board")).body as { projects: unknown[] }).projects).toEqual([]);
    await call(setup.base, "PATCH", `/api/board/projects/${projectId.id}`, { visibility: "everyone" });
    const after = await serve({ auth: member(), folder: setup.folder, bots: new Set(["b1"]), threads: new Set(["t1"]) });
    expect(((await call(after.base, "GET", "/api/board")).body as { projects: Array<{ id: string }> }).projects.map((project) => project.id)).toEqual([projectId.id]);
  });

  it("serves 503 and leaves a newer board file untouched", async () => {
    const newer = { version: 3, boardVersion: 4, projects: [], subprojects: [], milestones: [], tasks: [], updatedAt: "x" };
    const { base } = await serve({ boardFile: newer });
    const reply = await call(base, "GET", "/api/board");
    expect(reply.status).toBe(503);
    expect(reply.body.error).toBe("BOARD_UNAVAILABLE");
  });
});
