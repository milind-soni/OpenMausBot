import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VisibleSet } from "../bot-visibility.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { HandoffView } from "../coordinator.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import type { Assignment } from "../runtime/types.ts";
import { Store } from "../store.ts";
import { createJobRoutes } from "./jobs.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

interface Fixture {
  store: Store; rows: Assignment[]; reads: number; hidden: Set<string>; subscribers: () => number; failing?: boolean;
  session?: { live: boolean };
  nodes?: Map<string, Partial<HandoffView>>; stops?: string[]; refusal?: string;
}

async function serve(f: Fixture, recheckMs = 60_000): Promise<string> {
  let listeners = 0;
  const onChange = f.store.onChange.bind(f.store);
  const store = Object.assign(Object.create(f.store) as Store, {
    onChange: (listener: Parameters<Store["onChange"]>[0]) => {
      listeners += 1;
      const off = onChange(listener);
      return () => { listeners -= 1; return off(); };
    },
  });
  f.subscribers = () => listeners;
  const routes = [createJobRoutes({
    store,
    coordinator: { job: () => {
      f.reads += 1;
      if (f.failing) throw new Error("runtime.db is not readable");
      return { scopes: f.rows.filter((row) => !row.parentId).map((row) => row.id), rows: f.rows };
    },
    node: (id) => f.nodes?.get(id) as HandoffView | undefined,
    stopHandoff: (id) => {
      const node = f.nodes?.get(id);
      if (!node?.parentId) return undefined;
      if (node.status === "completed" || node.status === "cancelled") return "ended";
      f.stops?.push(id);
      node.status = "cancelled";
      return "stopped";
    } },
    stopRefusal: () => f.refusal ?? null,
    groupThreadIsWorking: () => false,
    viewerFor: () => ({ kind: "all" }),
    visibleTo: () => ({ thread: (threadId: string) => !f.hidden.has(threadId) }) as VisibleSet,
    sessions: { isLive: (id: string) => id === "phone" && f.session?.live === true },
    now: () => 5_000,
    recheckMs,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth: RequestAuth = f.session
        ? { kind: "session", session: { id: "phone" }, via: "bearer", scopes: ["client"] } as unknown as RequestAuth
        : { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fixture(): Fixture & { botId: string; threadId: string; root: (patch?: Partial<Assignment>) => Assignment } {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Room Lead" });
  const root = (patch: Partial<Assignment> = {}): Assignment => ({
    id: "root", rootId: "root", depth: 0, origin: { kind: "person", source: "chat" },
    requester: { kind: "person", threadId: bot.threadId, botId: bot.id },
    assignee: { botId: bot.id, destination: { kind: "standing_thread", threadId: bot.threadId } },
    mode: "work", reply: "resume", brief: "Rehearse", status: "running", level: "full", levelSource: "own",
    executions: 1, restarts: 0, createdAt: 1_000, lastActivityAt: 1_000, result: "", rework: false, version: 1, ...patch,
  });
  return { store, rows: [], reads: 0, hidden: new Set(), subscribers: () => 0, botId: bot.id, threadId: bot.threadId, root };
}

const get = async (base: string, path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() as any };
};

describe("GET /api/threads/:id/job", () => {
  it("is a client read, like the transcript", () => {
    expect(requiredScope("GET", "/api/threads/thread-1/job")).toBe("client");
  });

  it("answers with the conversation's job now, and refuses what it cannot read", async () => {
    const f = fixture();
    f.rows = [f.root({ status: "completed" })];
    const base = await serve(f);
    const { status, body } = await get(base, `/api/threads/${f.threadId}/job?since=0`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ threadId: f.threadId, scope: "job", since: 0, now: 5_000, state: "completed", roots: ["root"],
      conversation: { kind: "bot", busy: false, queued: 0 } });
    expect((await get(base, `/api/threads/${f.threadId}/job`)).body.since).toBe(5_000);
    expect((await get(base, "/api/threads/nobody/job")).status).toBe(404);
    f.hidden.add(f.threadId);
    expect((await get(base, `/api/threads/${f.threadId}/job`)).status).toBe(404);
    f.hidden.clear();
    expect((await get(base, `/api/threads/${f.threadId}/job?scope=all`)).status).toBe(400);
    expect((await get(base, `/api/threads/${f.threadId}/job?wait=999999`)).status).toBe(400);
    expect((await get(base, `/api/threads/${f.threadId}/job?since=-1`)).status).toBe(400);
  });

  it("holds a read until the job changes, waking on the store's change feed", async () => {
    const f = fixture();
    f.rows = [f.root()];
    f.store.setTaskActivity(f.botId, f.threadId, "working");
    const base = await serve(f);
    const first = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    expect(first).toMatchObject({ state: "running", reason: "Room Lead is working" });
    const started = Date.now();
    const held = get(base, `/api/threads/${f.threadId}/job?since=0&wait=20000&version=${first.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    f.rows = [f.root({ status: "completed", result: "Done", finishedAt: 4_000 })];
    f.store.setTaskActivity(f.botId, f.threadId, "idle");
    const answered = await held;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(answered.body).toMatchObject({ state: "completed", reason: "Room Lead finished" });
    expect(answered.body.version).not.toBe(first.version);
    expect(f.subscribers()).toBe(0);
  });

  it("answers with the same job when its wait runs out, and looks again for changes the feed does not carry", async () => {
    const f = fixture();
    f.rows = [f.root({ status: "waiting" })];
    const base = await serve(f, 50);
    const first = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    const timedOut = await get(base, `/api/threads/${f.threadId}/job?since=0&wait=300&version=${first.version}`);
    expect(timedOut.body.version).toBe(first.version);
    expect(f.subscribers()).toBe(0);
    // a runtime-only transition (no store change): the recheck finds it
    const held = get(base, `/api/threads/${f.threadId}/job?since=0&wait=20000&version=${first.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    f.rows = [f.root({ status: "completed" })];
    expect((await held).body).toMatchObject({ state: "completed" });
  });

  it("answers a held read whose last look fails with that failure, instead of throwing from its timer and never answering", async () => {
    const f = fixture();
    f.rows = [f.root()];
    const base = await serve(f);
    const first = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    const held = get(base, `/api/threads/${f.threadId}/job?since=0&wait=200&version=${first.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    f.failing = true;
    expect(await held).toEqual({ status: 500, body: { error: "Error: runtime.db is not readable" } });
    expect(f.subscribers()).toBe(0);
  });

  it("asks again who is reading before a held read answers: signed out meanwhile is 401, no longer allowed to see it is 404", async () => {
    const f = fixture();
    f.rows = [f.root()];
    f.store.setTaskActivity(f.botId, f.threadId, "working");
    f.session = { live: true };
    const base = await serve(f);
    const first = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    expect(first).toMatchObject({ state: "running" });
    const signedOut = get(base, `/api/threads/${f.threadId}/job?since=0&wait=20000&version=${first.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    f.session.live = false;
    f.rows = [f.root({ status: "completed" })];
    f.store.setTaskActivity(f.botId, f.threadId, "idle");
    expect(await signedOut).toEqual({ status: 401, body: { error: "unauthorized: this session has expired or was revoked" } });

    f.session.live = true;
    f.rows = [f.root()];
    f.store.setTaskActivity(f.botId, f.threadId, "working");
    const again = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    const hidden = get(base, `/api/threads/${f.threadId}/job?since=0&wait=20000&version=${again.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    f.hidden.add(f.threadId);
    f.rows = [f.root({ status: "completed" })];
    f.store.setTaskActivity(f.botId, f.threadId, "idle");
    expect(await hidden).toEqual({ status: 404, body: { error: "no such conversation" } });
  });

  it("lets go of a held read whose client went away", async () => {
    const f = fixture();
    f.rows = [f.root()];
    const base = await serve(f);
    const first = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    const controller = new AbortController();
    const held = fetch(`${base}/api/threads/${f.threadId}/job?since=0&wait=20000&version=${first.version}`, { signal: controller.signal });
    await expect.poll(() => f.subscribers()).toBe(1);
    controller.abort();
    await expect(held).rejects.toThrow();
    await expect.poll(() => f.subscribers()).toBe(0);
  });
});

describe("POST /api/threads/:id/job/:assignmentId/stop", () => {
  /** The person's turn in their chat handed work to a helper, which handed some on. */
  const handedOut = () => {
    const f = fixture();
    f.stops = [];
    f.nodes = new Map<string, Partial<HandoffView>>([
      ["root", { id: "root", rootId: "root", threadId: f.threadId, botId: f.botId, status: "source" }],
      ["as-help", { id: "as-help", rootId: "root", parentId: "root", threadId: "helper-work", botId: "helper", status: "running" }],
      ["as-deep", { id: "as-deep", rootId: "root", parentId: "as-help", threadId: "scout-work", botId: "scout", status: "queued" }],
      ["as-room", { id: "as-room", rootId: "root", parentId: "root", threadId: "room-1", groupId: "g1", botId: "helper", status: "running" }],
      ["other", { id: "other", rootId: "other", threadId: "elsewhere", botId: "helper", status: "source" }],
      ["as-other", { id: "as-other", rootId: "other", parentId: "other", threadId: "helper-work", botId: "helper", status: "running" }],
    ]);
    return f;
  };
  const post = async (base: string, path: string) => {
    const response = await fetch(`${base}${path}`, { method: "POST" });
    return { status: response.status, body: await response.json() as any };
  };

  it("is a client action, like stopping the conversation", () => {
    expect(requiredScope("POST", "/api/threads/thread-1/job/as-1/stop")).toBe("client");
  });

  it("stops a hand-off this conversation made, a deeper one included, and says when it had already ended", async () => {
    const f = handedOut();
    const base = await serve(f);
    expect(await post(base, `/api/threads/${f.threadId}/job/as-deep/stop`)).toEqual({ status: 200, body: { ok: true, outcome: "stopped" } });
    expect(await post(base, `/api/threads/${f.threadId}/job/as-help/stop`)).toEqual({ status: 200, body: { ok: true, outcome: "stopped" } });
    expect(f.stops).toEqual(["as-deep", "as-help"]);
    expect(await post(base, `/api/threads/${f.threadId}/job/as-help/stop`)).toEqual({ status: 200, body: { ok: true, outcome: "already-ended" } });
    expect(f.stops).toEqual(["as-deep", "as-help"]);
  });

  it("finds nothing to stop outside this conversation's hand-offs: its own turn, room work, another conversation's, an unknown id", async () => {
    const f = handedOut();
    const base = await serve(f);
    for (const id of ["root", "as-room", "as-other", "missing"]) {
      expect(await post(base, `/api/threads/${f.threadId}/job/${id}/stop`)).toMatchObject({ status: 404 });
    }
    expect(await post(base, "/api/threads/elsewhere/job/as-help/stop")).toMatchObject({ status: 404 });
    expect(f.stops).toEqual([]);
  });

  it("finds nothing where the reader may not open the conversation or the helper's thread", async () => {
    const f = handedOut();
    const base = await serve(f);
    f.hidden.add("helper-work");
    expect(await post(base, `/api/threads/${f.threadId}/job/as-help/stop`)).toMatchObject({ status: 404 });
    f.hidden.clear();
    f.hidden.add(f.threadId);
    expect(await post(base, `/api/threads/${f.threadId}/job/as-help/stop`)).toMatchObject({ status: 404 });
    expect(f.stops).toEqual([]);
  });

  it("refuses a reader who may not stop this conversation's work, with the code the client knows", async () => {
    const f = handedOut();
    f.refusal = "Only Ana can stop this request.";
    const base = await serve(f);
    expect(await post(base, `/api/threads/${f.threadId}/job/as-help/stop`)).toEqual({ status: 403, body: { error: "Only Ana can stop this request.", code: "stop_not_yours" } });
    expect(f.stops).toEqual([]);
  });

  it("leaves other methods and paths to the routes after it", async () => {
    const f = handedOut();
    const base = await serve(f);
    expect(await get(base, `/api/threads/${f.threadId}/job/as-help/stop`)).toEqual({ status: 404, body: { from: "inline routes" } });
    expect(await post(base, `/api/threads/${f.threadId}/stop`)).toEqual({ status: 404, body: { from: "inline routes" } });
  });
});
