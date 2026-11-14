import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BoardBroadcast } from "../../shared/board.ts";
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
const member: RequestAuth = { kind: "session", scopes: ["client"], via: "cookie", session: { id: "s1", email: "m@example.com", role: "user", createdAt: 0, expiresAt: 0 } as never };

async function serve(input: { auth?: RequestAuth; threads?: Set<string> } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "omb-board-routes-"));
  folders.push(folder);
  const frames: BoardBroadcast[] = [];
  const board = new BoardStore({ file: join(folder, "board.json"), broadcast: (frame) => frames.push(frame), now: () => new Date("2026-11-15T00:00:00.000Z") });
  const threads = input.threads ?? new Set(["t1"]);
  const routes = [createBoardRoutes({
    board,
    canManage: (auth) => auth.scopes.includes("admin"),
    threadExists: (botId, threadId) => botId === "b1" && threads.has(threadId),
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
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, board, frames };
}

const call = async (base: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe("/api/board", () => {
  it("serves the whole board and broadcasts every write", async () => {
    const { base, frames } = await serve();
    expect(await call(base, "GET", "/api/board")).toMatchObject({ status: 200, body: { version: 0, projects: [], tasks: [], capabilities: { manage: true } } });
    const created = await call(base, "POST", "/api/board/projects", { name: "创意板", description: "看板 v1" });
    expect(created.status).toBe(201);
    expect((created.body.board as { projects: Array<{ name: string }> }).projects[0]!.name).toBe("创意板");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "board", board: { version: 1 } });
  });

  it("refuses a member and an unsupported field", async () => {
    const memberServer = await serve({ auth: member });
    expect(await call(memberServer.base, "GET", "/api/board")).toMatchObject({ status: 403, body: { error: "BOARD_FORBIDDEN" } });
    const { base } = await serve();
    expect(await call(base, "POST", "/api/board/projects", { name: "创意板", color: "red" })).toMatchObject({
      status: 400, body: { error: "BOARD_INVALID" },
    });
  });

  it("answers 409 for a stale version and 422 for an accepted milestone without evidence", async () => {
    const { base } = await serve();
    const project = await call(base, "POST", "/api/board/projects", { name: "创意板" });
    const id = (project.body.board as { projects: Array<{ id: string }> }).projects[0]!.id;
    expect(await call(base, "POST", "/api/board/subprojects", { projectId: id, name: "看板", version: 0 })).toMatchObject({
      status: 409, body: { error: "BOARD_VERSION_CONFLICT" },
    });
    const milestone = await call(base, "POST", "/api/board/milestones", { projectId: id, title: "前端联调" });
    const milestoneId = (milestone.body.board as { milestones: Array<{ id: string }> }).milestones[0]!.id;
    expect(await call(base, "PATCH", `/api/board/milestones/${milestoneId}`, { status: "accepted" })).toMatchObject({
      status: 422, body: { error: "BOARD_NEEDS_EVIDENCE" },
    });
    expect(await call(base, "PATCH", `/api/board/milestones/${milestoneId}`, { status: "accepted", verdict: "通过", evidence: "check exit 0" })).toMatchObject({ status: 200 });
  });

  it("only attributes a real conversation, then accepts a verdict and unclassifies", async () => {
    const { base, frames } = await serve();
    const project = await call(base, "POST", "/api/board/projects", { name: "创意板" });
    const projectId = (project.body.board as { projects: Array<{ id: string }> }).projects[0]!.id;

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
    expect(accepted.body.task).toMatchObject({ phase: "done", status: "done", verdict: { decision: "accepted" } });
    expect(frames.at(-1)?.board.tasks[0]!.phase).toBe("done");

    expect(await call(base, "DELETE", "/api/board/tasks/t1")).toMatchObject({ status: 200, body: { board: { tasks: [] } } });
  });
});
