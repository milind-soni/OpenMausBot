import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VisibleSet } from "../bot-visibility.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import type { Assignment, OfficeAttempt } from "../runtime/types.ts";
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
    } },
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
  it("selects the current native job from active user request ids across branch switches", async () => {
    const f = fixture();
    const firstRequest = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "First branch" });
    const secondRequest = f.store.branchMessage(f.threadId, firstRequest.id, "Second branch")!;
    f.rows = [f.root({ id: "first", rootId: "first", status: "cancelled", outcome: "stopped", requestMessageId: firstRequest.id }),
      f.root({ id: "second", rootId: "second", status: "completed", outcome: "done", createdAt: 3_000, requestMessageId: secondRequest.id }),
      f.root({ id: "foreign", rootId: "foreign", status: "running", createdAt: 4_000, requestMessageId: secondRequest.id,
        assignee: { botId: "foreign-chief", destination: { kind: "standing_thread", threadId: f.threadId } } })];
    const base = await serve(f);
    const second = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    expect(second.current).toMatchObject({ rootId: "second", requestMessageId: secondRequest.id, status: "completed", state: "completed" });
    const held = get(base, `/api/threads/${f.threadId}/job?since=0&wait=20000&version=${second.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    f.store.setActiveLeaf(f.threadId, firstRequest.id);
    const switched = (await held).body;
    expect(switched.current).toMatchObject({ rootId: "first", requestMessageId: firstRequest.id, status: "cancelled", state: "cancelled" });
    expect(switched.version).not.toBe(second.version);
    const unmatched = f.store.branchMessage(f.threadId, firstRequest.id, "Unstarted branch")!;
    expect(f.store.activeLeaf(f.threadId)).toBe(unmatched.id);
    expect((await get(base, `/api/threads/${f.threadId}/job?since=0`)).body.current).toBeNull();
  });

  it("refreshes native unconfirmed stops even when all assignment statuses remain terminal", async () => {
    const f = fixture();
    const oldRequest = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "Earlier request" });
    const latestRequest = f.store.appendMessage(f.threadId, { role: "user", kind: "text", text: "Latest request" });
    const officeAttempt: OfficeAttempt = {
      version: 1, attemptId: "old-attempt", assignmentId: "old", rootId: "old", botId: f.botId, threadId: f.threadId,
      generation: "old-generation", workerId: "hel1", instanceId: "codex", driverKind: "codex", profileId: f.botId,
      assignmentDigest: "assignment", profileDigest: "profile", cwd: "/fixture", rootDeadline: 60_000, startBefore: 2_000,
      kind: "work", digest: "attempt", capabilityHash: "capability", state: "uncertain", preparedAt: 1_000, consumedAt: 1_001,
    };
    f.rows = [f.root({ id: "old", rootId: "old", status: "cancelled", outcome: "stopped", requestMessageId: oldRequest.id,
      brief: "Earlier request", office: { rootDeadline: 60_000, attempts: [officeAttempt] } }),
    f.root({ id: "latest", rootId: "latest", status: "completed", outcome: "done", createdAt: 3_000, requestMessageId: latestRequest.id })];
    const base = await serve(f, 25);
    const before = (await get(base, `/api/threads/${f.threadId}/job?since=0`)).body;
    expect(before.current).toMatchObject({ rootId: "latest", state: "completed" });
    expect(before.unconfirmedStops).toEqual([{ rootId: "old", sourceRequest: "Earlier request" }]);
    const held = get(base, `/api/threads/${f.threadId}/job?since=0&wait=20000&version=${before.version}`);
    await expect.poll(() => f.subscribers()).toBe(1);
    officeAttempt.state = "cancelled";
    officeAttempt.finishedAt = 4_000;
    const after = (await held).body;
    expect(after.current).toEqual(before.current);
    expect(after.unconfirmedStops).toEqual([]);
    expect(after.version).not.toBe(before.version);
  });

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
