import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { PASS } from "./table.ts";
import { createWorkTaskRoutes, handleInternalWorkTaskRoute } from "./work-tasks.ts";
import { WorkTaskStore } from "../work-tasks.ts";
import { JiraSyncService } from "../work-tasks-jira.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "looma-wt-routes-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function fakeRes() {
  let status = 200;
  let body: any = null;
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      this.statusCode = code;
      return this;
    },
    setHeader() {},
    end(chunk?: string) {
      this.headersSent = true;
      this.writableEnded = true;
      body = chunk ? JSON.parse(chunk) : null;
    },
  } as any;
  return { res, result: () => ({ status, body }) };
}

describe("WorkTask HTTP & internal agent routes RBAC", () => {
  it("enforces server-derived bot actor identity and worker vs QA vs coordinator privileges", async () => {
    const dir = tempDir();
    const tasks = new WorkTaskStore({ file: join(dir, "work-tasks.json") });
    const jira = new JiraSyncService({ store: tasks });

    const bots: Record<string, any> = {
      coord: { id: "coord", name: "Coordinator", title: "Lead", chiefOfStaff: true },
      worker: { id: "worker", name: "Backend-Agent", title: "Backend Engineer" },
      qa: { id: "qa", name: "QA-Agent", title: "QA Engineer" },
    };
    const room: any = {
      id: "room-1",
      name: "ProjectHub",
      threadId: "room-t1",
      memberIds: ["coord", "worker", "qa"],
      defaultResponder: { kind: "member", botId: "coord" },
    };

    const route = createWorkTaskRoutes({
      tasks,
      jira,
      group: (id) => (id === room.id ? room : undefined),
      groups: () => [room],
      groupByThread: (t) => (t === room.threadId ? room : undefined),
      bot: (id) => bots[id],
      visible: () => ({ everything: true, group: () => true, bot: () => true }),
      actorName: () => "Alice",
    });

    const callPublic = async (method: string, pathAndQuery: string, payload?: unknown) => {
      const url = new URL(`http://127.0.0.1${pathAndQuery}`);
      const r = fakeRes();
      const req = {
        headers: { "content-type": "application/json" },
        async *[Symbol.asyncIterator]() {
          if (payload !== undefined) yield Buffer.from(JSON.stringify(payload));
        },
      } as any;
      await route({
        req,
        res: r.res,
        url,
        path: url.pathname,
        method,
        auth: { kind: "loopback", trust: "owner", scopes: ["admin", "client"] } as any,
        json,
        readBody: async () => payload,
      });
      return r.result();
    };

    const callInternal = async (botId: string, method: string, pathAndQuery: string, payload?: unknown) => {
      const url = new URL(`http://127.0.0.1${pathAndQuery}`);
      const r = fakeRes();
      const out = await handleInternalWorkTaskRoute({
        method,
        path: url.pathname,
        url,
        res: r.res,
        json,
        bot: bots[botId],
        threadId: room.threadId,
        readBody: async () => payload,
        tasks,
        jira,
        group: (id) => (id === room.id ? room : undefined),
        groupByThread: (t) => (t === room.threadId ? room : undefined),
        groups: () => [room],
        botLookup: (id) => bots[id],
      });
      if (out === PASS) return { status: 404, body: { error: "pass" } };
      return r.result();
    };

    // User creates task
    const created = await callPublic("POST", "/api/work-tasks", {
      roomId: room.id,
      title: "Build dashboard",
      assigneeBotId: "worker",
    });
    expect(created.status).toBe(201);
    expect(created.body.task.key).toBe("LOOMA-101");

    // Worker moves to in-progress, then tries to spoof qa actorId or transition to done -> MUST BE 403
    const started = await callInternal("worker", "PATCH", `/api/internal/work-tasks/LOOMA-101`, {
      status: "in-progress",
      actorId: "qa", // spoofed field must have no effect
      botId: "qa",
    });
    expect(started.status).toBe(200);

    const selfDone = await callInternal("worker", "PATCH", `/api/internal/work-tasks/LOOMA-101`, {
      status: "done",
    });
    expect(selfDone.status).toBe(403);

    // Worker moves to in-review -> succeeds
    const toReview = await callInternal("worker", "PATCH", `/api/internal/work-tasks/LOOMA-101`, {
      status: "in-review",
      evidence: { type: "test", label: "unit", value: "all green" },
    });
    expect(toReview.status).toBe(200);
    expect(toReview.body.task.status).toBe("in-review");

    // QA moves in-review -> done -> succeeds
    const qaDone = await callInternal("qa", "PATCH", `/api/internal/work-tasks/LOOMA-101`, {
      status: "done",
      statusNote: "Verified by QA",
    });
    expect(qaDone.status).toBe(200);
    expect(qaDone.body.task.status).toBe("done");

    // Telegram command endpoint
    const tg = await callPublic("POST", "/api/work-tasks/telegram/command", {
      command: "/status",
      roomId: room.id,
    });
    expect(tg.status).toBe(200);
    expect(tg.body.text).toContain("LOOMA-101: Done");

    // Keep unused import check satisfied
    expect(typeof readBody).toBe("function");
  });
});

