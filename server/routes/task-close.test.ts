import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import type { WireBot, WireTask } from "../../shared/wire.ts";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { Store, type BotRecord, type TaskRecord } from "../store.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createTaskRoutes, type TaskRouteDeps } from "./tasks.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
// Authority comes from scopes alone here; the session's identity matters only to the stubbed Cloud refusal.
const signedIn = {} as SessionRecord;

interface PatchAnswer {
  closed?: true;
  alreadyClosed?: true;
  task?: TaskRecord;
  bot?: BotRecord;
  error?: string;
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function fixture() {
  const store = new Store(() => sonnet);
  const rowan = store.createBot({ name: "Rowan" });
  const lead = store.createBot({ name: "Lead" });
  const busy = new Set<string>();
  const queued = new Set<string>();
  const awaiting = new Set<string>();
  const direct = new Set<string>();
  const routineThreads = new Set<string>();
  // Only what a close touches; any other dependency is absent, and a route that reached for one would throw.
  const deps = {
    store,
    coordinator: { awaitingAnswer: (id: string) => awaiting.has(id), activeDirect: (id: string) => direct.has(id) },
    routines: () => ({ isActiveThread: (id: string) => routineThreads.has(id) }),
    threadBusy: (_bot: string, id: string) => busy.has(id),
    queuedThreadPosition: (_bot: string, id: string) => queued.has(id) ? 1 : null,
    cloudThreadRefusal: () => null,
    wireTask: (task: TaskRecord) => task as unknown as WireTask,
    publicBot: (bot: BotRecord) => bot as unknown as WireBot,
  } as unknown as TaskRouteDeps;
  const handler = createTaskRoutes(deps);
  const patch = async (botId: string, threadId: string, body: unknown, auth: RequestAuth = owner) => {
    const sent: Array<{ status: number; body: PatchAnswer }> = [];
    const path = `/api/bots/${botId}/tasks/${threadId}`;
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost${path}`),
      path,
      method: "PATCH",
      auth,
      json: ((_res: ServerResponse, status: number, response: PatchAnswer) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  const openedByRowan = (title = "@Lead · work") =>
    store.createTask(lead.id, title, false, undefined, { botId: rowan.id, name: "Rowan before rename", kind: "work", at: 1 })!;
  const closeChips = (threadId: string) => store.messagesFor(threadId).filter((message) => message.tool?.name.startsWith("Closed by"));
  const threadsAndMessages = (botId: string) => structuredClone((store.bot(botId)?.tasks ?? []).map((task) => ({
    task: store.taskByThread(botId, task.threadId),
    messages: store.messagesFor(task.threadId),
  })));
  return { store, rowan, lead, busy, queued, awaiting, direct, routineThreads, patch, openedByRowan, closeChips, threadsAndMessages };
}

describe("PATCH /api/bots/:bot/tasks/:thread { close: true }", () => {
  it("closes a teammate thread as the bot that opened it, under that bot's current name", async () => {
    const f = fixture();
    const task = f.openedByRowan();
    f.store.patchTask(f.lead.id, task.threadId, { unread: true, pinned: true });
    const before = Date.now();
    const closed = await f.patch(f.lead.id, task.threadId, { close: true });
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(true);
    expect(closed.body).not.toHaveProperty("alreadyClosed");
    const closedBy = closed.body.task?.closedBy;
    expect(closedBy).toEqual({ botId: f.rowan.id, name: "Rowan", at: expect.any(Number) });
    expect(closedBy?.at).toBeGreaterThanOrEqual(before);
    expect(closed.body.bot?.id).toBe(f.lead.id);
    const persisted = new Store(() => sonnet).taskByThread(f.lead.id, task.threadId)!;
    expect(persisted.closedBy).toEqual(closedBy);
    expect(persisted.unread).not.toBe(true);
    expect(persisted.pinned).toBe(true);
    expect(persisted).not.toHaveProperty("archivedAt");
    expect(persisted.openedBy).toMatchObject({ botId: f.rowan.id, kind: "work" });
    expect(f.closeChips(task.threadId)).toEqual([expect.objectContaining({
      kind: "activity",
      from: { botId: f.rowan.id, name: "Rowan", color: f.rowan.color },
      tool: { name: "Closed by @Rowan", ok: true },
    })]);
  });

  it("closes a bot's own self-opened thread as that bot", async () => {
    const f = fixture();
    const self = f.store.createTask(f.rowan.id, "Follow-up", false, undefined, { botId: f.rowan.id, name: "Rowan", at: 1 })!;
    const closed = await f.patch(f.rowan.id, self.threadId, { close: true });
    expect(closed.status).toBe(200);
    expect(closed.body.task?.closedBy).toMatchObject({ botId: f.rowan.id, name: "Rowan" });
  });

  it("is idempotent: a second close changes nothing and says alreadyClosed", async () => {
    const f = fixture();
    const task = f.openedByRowan();
    const first = await f.patch(f.lead.id, task.threadId, { close: true });
    const again = await f.patch(f.lead.id, task.threadId, { close: true });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ closed: true, alreadyClosed: true });
    expect(again.body.task?.closedBy).toEqual(first.body.task?.closedBy);
    expect(f.closeChips(task.threadId)).toHaveLength(1);
  });

  it("still answers alreadyClosed after the bot that opened and closed it is deleted", async () => {
    const f = fixture();
    const task = f.openedByRowan();
    const first = await f.patch(f.lead.id, task.threadId, { close: true });
    expect(first.status).toBe(200);
    const closedHistory = f.threadsAndMessages(f.lead.id);
    expect(f.store.deleteBot(f.rowan.id)).toBe(true);
    expect(f.store.bot(f.rowan.id)).toBeNull();
    const retry = await f.patch(f.lead.id, task.threadId, { close: true });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ closed: true, alreadyClosed: true });
    expect(retry.body.task?.closedBy).toEqual(first.body.task?.closedBy);
    expect(retry.body.bot?.id).toBe(f.lead.id);
    expect(f.threadsAndMessages(f.lead.id)).toEqual(closedHistory);
    expect(f.closeChips(task.threadId)).toHaveLength(1);
  });

  it("refuses a thread no bot opened, or whose opener is gone", async () => {
    const f = fixture();
    const persons = f.store.createTask(f.lead.id, "Started by the person", false)!;
    const refused = await f.patch(f.lead.id, persons.threadId, { close: true });
    expect(refused.status).toBe(403);
    const orphan = f.store.createTask(f.lead.id, "Opener deleted", false, undefined, { botId: "deleted-bot", name: "Gone", at: 1 })!;
    expect((await f.patch(f.lead.id, orphan.threadId, { close: true })).status).toBe(403);
    expect((await f.patch(f.lead.id, f.lead.threadId, { close: true })).status).toBe(403);
    for (const threadId of [persons.threadId, orphan.threadId, f.lead.threadId]) {
      expect(f.store.taskByThread(f.lead.id, threadId)).not.toHaveProperty("closedBy");
      expect(f.closeChips(threadId)).toHaveLength(0);
    }
  });

  it.each(["Team incidents", "Team escalations"])("refuses the %s thread OpenMausBot reports into, though its bot opened it", async (title) => {
    const f = fixture();
    const notices = f.store.createTask(f.rowan.id, title, false, undefined, { botId: f.rowan.id, name: "Rowan", at: 1 })!;
    expect((await f.patch(f.rowan.id, notices.threadId, { close: true })).status).toBe(403);
    expect(f.store.taskByThread(f.rowan.id, notices.threadId)).not.toHaveProperty("closedBy");
    expect(f.closeChips(notices.threadId)).toHaveLength(0);
  });

  it.each([
    ["false", { close: false }, 400],
    ["a string", { close: "true" }, 400],
    ["null", { close: null }, 400],
    ["combined with archivedAt", { close: true, archivedAt: 5 }, 400],
    ["combined with a title", { close: true, title: "Renamed" }, 400],
    ["combined with pinned", { close: true, pinned: true }, 400],
    ["with a caller-chosen closer", { close: true, closedBy: { botId: "x", name: "Mallory", at: 1 } }, 400],
  ])("rejects close %s and changes nothing", async (_label, body, status) => {
    const f = fixture();
    const task = f.openedByRowan("Unchanged");
    expect((await f.patch(f.lead.id, task.threadId, body)).status).toBe(status);
    const after = f.store.taskByThread(f.lead.id, task.threadId)!;
    expect(after).not.toHaveProperty("closedBy");
    expect(after).not.toHaveProperty("archivedAt");
    expect(after).not.toHaveProperty("pinned");
    expect(after.title).toBe("Unchanged");
  });

  it.each([
    ["service-trust loopback (a shared server's bot shell)", { kind: "loopback", scopes: ["admin", "client"], trust: "service" } as RequestAuth, 403],
    ["a client-scoped session", { kind: "session", session: signedIn, via: "bearer", scopes: ["client"] } as RequestAuth, 403],
    ["an admin session", { kind: "session", session: signedIn, via: "bearer", scopes: ["admin", "client"] } as RequestAuth, 200],
  ])("authority: %s", async (_label, auth, status) => {
    const f = fixture();
    const task = f.openedByRowan();
    expect((await f.patch(f.lead.id, task.threadId, { close: true }, auth)).status).toBe(status);
    expect(Boolean(f.store.taskByThread(f.lead.id, task.threadId)!.closedBy)).toBe(status === 200);
  });

  it.each(["busy", "queued", "awaiting", "direct", "routineThreads"] as const)("refuses while the thread is %s", async (state) => {
    const f = fixture();
    const task = f.openedByRowan();
    f[state].add(task.threadId);
    const refused = await f.patch(f.lead.id, task.threadId, { close: true });
    expect(refused.status).toBe(409);
    expect(f.store.taskByThread(f.lead.id, task.threadId)).not.toHaveProperty("closedBy");
    expect(f.closeChips(task.threadId)).toHaveLength(0);
  });

  it("answers 404 for a thread the bot does not have", async () => {
    const f = fixture();
    const theirs = f.store.createTask(f.rowan.id, "Rowan's", false, undefined, { botId: f.rowan.id, name: "Rowan", at: 1 })!;
    expect((await f.patch(f.lead.id, theirs.threadId, { close: true })).status).toBe(404);
    expect(f.store.taskByThread(f.rowan.id, theirs.threadId)).not.toHaveProperty("closedBy");
  });

  it.each(["thread", "bot"] as const)("answers 404 when the %s does not exist and changes nothing", async (missing) => {
    const f = fixture();
    const task = f.openedByRowan();
    const before = [f.threadsAndMessages(f.rowan.id), f.threadsAndMessages(f.lead.id)];
    const answer = missing === "thread"
      ? await f.patch(f.lead.id, "no-such-thread", { close: true })
      : await f.patch("no-such-bot", task.threadId, { close: true });
    expect(answer.status).toBe(404);
    expect([f.threadsAndMessages(f.rowan.id), f.threadsAndMessages(f.lead.id)]).toEqual(before);
  });

  it.each([
    ["null", null],
    ["an empty array", []],
    ["an array holding a close", [{ close: true }]],
    ["a string", "close"],
    ["a number", 1],
    ["true", true],
  ])("rejects a body that is %s and changes nothing", async (_label, body) => {
    const f = fixture();
    const task = f.openedByRowan();
    const before = [f.threadsAndMessages(f.rowan.id), f.threadsAndMessages(f.lead.id)];
    expect((await f.patch(f.lead.id, task.threadId, body)).status).toBe(400);
    expect([f.threadsAndMessages(f.rowan.id), f.threadsAndMessages(f.lead.id)]).toEqual(before);
  });
});
