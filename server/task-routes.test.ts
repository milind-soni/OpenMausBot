// The durable task board's HTTP surface through a real, isolated harness
// server: off by default (404 on every /api/tasks* and /api/internal/task-*
// route until features.board is turned on), the illegal-transition 400 that
// keeps a stale board view from ever producing a 500, and the internal
// endpoints' comms-token guard.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

interface Reply {
  status: number;
  // SAFETY: test-only view of JSON bodies; every field read below is asserted first
  body: any;
}

describe("the task board routes through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let botId = "";
  const api = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    const catalog = (await api("GET", "/api/instances")).body.instances.find(
      (instance: { instanceId: string }) => instance.instanceId === "claude",
    );
    const model = catalog.models.options[0].id;
    const created = await api("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model } });
    expect(created.status).toBe(201);
    botId = created.body.bot.id;
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it("answers 404 on every board route while the flag is off — an existing install sees no new surface", async () => {
    expect((await api("GET", "/api/tasks")).status).toBe(404);
    expect((await api("POST", "/api/tasks", { title: "should not exist yet" })).status).toBe(404);
    expect((await api("POST", "/api/internal/task-create", { title: "x" })).status).toBe(401);
    // Nor does the flag being off leave a database behind: storage opens on
    // first use, and only while the board is actually turned on.
    expect(existsSync(join(fixture.info.dataDir, "tasks.db"))).toBe(false);
  });

  it("files, lists, and edits a task once features.board is turned on", async () => {
    const enabled = await api("PATCH", "/api/config", { features: { board: true } });
    expect(enabled.status).toBe(200);

    const created = await api("POST", "/api/tasks", { title: "write the changelog", body: "see PR #1" });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ title: "write the changelog", status: "todo", attempts: 0 });
    const taskId = created.body.task.id as string;

    const listed = await api("GET", "/api/tasks");
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.map((t: { id: string }) => t.id)).toContain(taskId);
    // Comments are loaded per task, never folded into the list response.
    expect(listed.body.comments).toBeUndefined();
    expect((await api("GET", `/api/tasks/${taskId}/comments`)).body.comments).toEqual([]);

    // An unrecognised status is a client mistake, not "show me everything".
    expect((await api("GET", "/api/tasks?status=bogus")).status).toBe(400);
    expect((await api("GET", "/api/tasks?status=ready")).status).toBe(200);

    // todo → running directly is illegal (must pass through ready); the
    // route must answer 400, not crash with a 500.
    const illegal = await api("PATCH", `/api/tasks/${taskId}`, { status: "running" });
    expect(illegal.status).toBe(400);
    expect(illegal.body.error).toMatch(/todo → running/);

    const promoted = await api("PATCH", `/api/tasks/${taskId}`, { status: "ready", priority: 5 });
    expect(promoted.status).toBe(200);
    expect(promoted.body.task).toMatchObject({ status: "ready", priority: 5 });

    const assigned = await api("PATCH", `/api/tasks/${taskId}`, { assigneeBotId: botId });
    expect(assigned.status).toBe(200);
    expect(assigned.body.task.assigneeBotId).toBe(botId);

    const badAssignee = await api("PATCH", `/api/tasks/${taskId}`, { assigneeBotId: "no-such-bot" });
    expect(badAssignee.status).toBe(404);

    const commented = await api("POST", `/api/tasks/${taskId}/comments`, { text: "starting on this" });
    expect(commented.status).toBe(201);
    expect(commented.body.comment).toMatchObject({ taskId, text: "starting on this", botId: null });

    expect((await api("GET", `/api/tasks/${taskId}/comments`)).body.comments).toHaveLength(1);

    // Input caps, in step with the rest of the server: neither a person nor
    // a looping bot can write an unbounded row.
    const longTitle = await api("POST", "/api/tasks", { title: "x".repeat(201) });
    expect(longTitle.status).toBe(400);
    const longBody = await api("POST", "/api/tasks", { title: "ok", body: "x".repeat(8_001) });
    expect(longBody.status).toBe(400);
    const longComment = await api("POST", `/api/tasks/${taskId}/comments`, { text: "x".repeat(4_001) });
    expect(longComment.status).toBe(400);
    // Phase 2 part 1: owner, due date and a money cap ride the same routes
    const withFields = await api("POST", "/api/tasks", { title: "invoice Acme", owner: "person", dueAt: 1_800_000_000_000, budgetUsd: 2 });
    expect(withFields.status).toBe(201);
    expect(withFields.body.task).toMatchObject({ owner: "person", dueAt: 1_800_000_000_000, budgetUsd: 2, spentUsd: 0 });
    const fieldsPatched = await api("PATCH", `/api/tasks/${withFields.body.task.id}`, { owner: null, budgetUsd: 3 });
    expect(fieldsPatched.body.task).toMatchObject({ owner: null, budgetUsd: 3 });
    expect((await api("PATCH", `/api/tasks/${withFields.body.task.id}`, { budgetUsd: -1 })).status).toBe(400);
    expect((await api("POST", "/api/tasks", { title: "bad due", dueAt: "tomorrow" })).status).toBe(400);
    expect((await api("PATCH", "/api/tasks/no-such-task", { priority: 1 })).status).toBe(404);
    expect((await api("POST", "/api/tasks/no-such-task/comments", { text: "x" })).status).toBe(404);
  });

  it("refuses a bad assignee at creation and rejects an internal call without the comms token", async () => {
    const badAssignee = await api("POST", "/api/tasks", { title: "x", assigneeBotId: "no-such-bot" });
    expect(badAssignee.status).toBe(404);

    const noParent = await api("POST", "/api/tasks", { title: "x", parentIds: ["no-such-parent"] });
    expect(noParent.status).toBe(404);

    for (const path of ["/api/internal/task-create", "/api/internal/task-list"]) {
      const refused = await api("POST", path, { title: "x" });
      expect(refused.status).toBe(401);
    }
  });
});
