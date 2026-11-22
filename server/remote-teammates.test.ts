import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BotApiManager } from "./bot-api.ts";
import { createBotApiHost, type BotApiHostDeps } from "./bot-api-host.ts";
import { json, readBody } from "./harness/http.ts";
import { checkRemote, readRemote, remoteAddress, RemoteTeammates, sendToRemote, type RemoteTeammate } from "./remote-teammates.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createRemoteTeammateRoutes } from "./routes/remote-teammates.ts";
import { dispatchRoutes } from "./routes/table.ts";
import type { Message } from "./store.ts";
import { createWebhookIngressHandler } from "./webhook-ingress.ts";
import type { WebhookManager } from "./webhooks.ts";

const KEY = `bak_${"k".repeat(43)}`;
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-remote-teammates-"));
  dirs.push(dir);
  return join(dir, "remote-teammates.json");
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function teammate(base: string, key = KEY): RemoteTeammate {
  return { id: "00000000-0000-4000-8000-000000000001", name: "Far", base, botId: "b1", key, createdAt: 1 };
}

describe("remoteAddress", () => {
  it("takes https anywhere and plain http only on a private network", () => {
    expect(remoteAddress("https://maus.example.com/", "b1")).toEqual({ base: "https://maus.example.com", botId: "b1" });
    expect(remoteAddress("http://100.101.2.3:8799", "b1").base).toBe("http://100.101.2.3:8799");
    expect(remoteAddress("http://box.tail1234.ts.net:8799", "b1").base).toBe("http://box.tail1234.ts.net:8799");
    expect(remoteAddress("http://192.168.1.20:8799", "b1").base).toBe("http://192.168.1.20:8799");
    expect(() => remoteAddress("http://maus.example.com", "b1")).toThrow(/open internet/);
    expect(() => remoteAddress("ftp://maus.example.com", "b1")).toThrow(/https/);
    expect(() => remoteAddress("https://me:pw@maus.example.com", "b1")).toThrow(/without a sign-in/);
    expect(() => remoteAddress("maus", "b1")).toThrow(/not a server address/);
  });

  it("refuses link-local and cloud metadata hosts, and an address too long to keep", () => {
    expect(() => remoteAddress("http://169.254.169.254", "b1")).toThrow(/link-local/);
    expect(() => remoteAddress("http://2852039166", "b1")).toThrow(/link-local/);
    expect(() => remoteAddress("http://[fe80::1]:8799", "b1")).toThrow(/link-local/);
    expect(() => remoteAddress("http://[fd00:ec2::254]", "b1")).toThrow(/link-local/);
    expect(() => remoteAddress(`https://maus.example.com/${"p".repeat(300)}`, "b1")).toThrow(/too long/);
  });

  it("reads the bot from a pasted Bot API address and keeps a path the server is served under", () => {
    expect(remoteAddress("https://maus.example.com/hooks/api/bots/scout-1/messages")).toEqual({ base: "https://maus.example.com", botId: "scout-1" });
    expect(remoteAddress("https://example.com/omb/hooks/api/bots/b2/messages", "b2")).toEqual({ base: "https://example.com/omb", botId: "b2" });
    expect(() => remoteAddress("https://maus.example.com/hooks/api/bots/b2/messages", "b3")).toThrow(/different bot/);
    expect(() => remoteAddress("https://maus.example.com")).toThrow(/bot's id/);
  });
});

describe("RemoteTeammates", () => {
  it("keeps the key only in its own file and never lists it", () => {
    const file = tempFile();
    const store = new RemoteTeammates({ file, now: () => 5 });
    const added = store.add({ name: " Far ", address: "https://maus.example.com/hooks/api/bots/b1/messages", key: KEY });
    expect(added).toEqual({ id: expect.any(String), name: "Far", base: "https://maus.example.com", botId: "b1", createdAt: 5 });
    expect(JSON.stringify(store.list())).not.toContain(KEY);
    expect(store.get(added.id)?.key).toBe(KEY);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new RemoteTeammates({ file }).list()).toEqual([added]);
  });

  it("refuses a duplicate, a key of the wrong shape, and removes by id", () => {
    const store = new RemoteTeammates({ file: tempFile() });
    const added = store.add({ name: "Far", address: "https://maus.example.com", botId: "b1", key: KEY });
    expect(() => store.add({ name: "Again", address: "https://maus.example.com/", botId: "b1", key: KEY })).toThrow(/already a teammate/);
    expect(() => store.add({ name: "Bad", address: "https://maus.example.com", botId: "b2", key: "Bearer x\r\nX-Evil: 1" })).toThrow(/bak_/);
    expect(store.remove(added.id)).toBe(true);
    expect(store.remove(added.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("never overwrites a saved file it could not read", () => {
    const file = tempFile();
    writeFileSync(file, "{not json");
    const store = new RemoteTeammates({ file });
    expect(store.list()).toEqual([]);
    expect(() => store.add({ name: "Far", address: "https://maus.example.com", botId: "b1", key: KEY })).toThrow(/could not be read/);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("keeps its list as the file has it when a save fails", () => {
    const dir = dirname(tempFile());
    const store = new RemoteTeammates({ file: join(dir, "blocked", "remote-teammates.json") });
    writeFileSync(join(dir, "blocked"), "a file where the folder should be");
    expect(() => store.add({ name: "Far", address: "https://maus.example.com", botId: "b1", key: KEY })).toThrow();
    expect(store.list()).toEqual([]);
  });
});

describe("calling a teammate's Bot API", () => {
  it("maps each answer the Bot API gives, and refuses answers of any other shape", async () => {
    const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
    let next: { status: number; body: string; headers?: Record<string, string> } = { status: 200, body: JSON.stringify({ reply: "hi", thread: "t1" }) };
    const base = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        res.writeHead(next.status, { "content-type": "application/json", ...next.headers });
        res.end(next.body);
      });
    });
    const far = teammate(base);
    expect(await sendToRemote(far, { message: "hello", wait: 1 })).toEqual({ ok: true, answer: { reply: "hi", thread: "t1" } });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/hooks/api/bots/b1/messages", auth: `Bearer ${KEY}` });
    expect(JSON.parse(seen[0]!.body)).toEqual({ message: "hello", wait: 1 });
    // A fractional wait is a valid Bot API wait; it must not make the call throw before it is sent.
    expect(await sendToRemote(far, { message: "soon", wait: 1 / 3 })).toEqual({ ok: true, answer: { reply: "hi", thread: "t1" } });
    expect(JSON.parse(seen.pop()!.body)).toEqual({ message: "soon", wait: 1 / 3 });

    next = { status: 202, body: JSON.stringify({ thread: "t1", status: "needs_approval" }) };
    expect(await readRemote(far, "t1")).toEqual({ ok: true, answer: { thread: "t1", status: "needs_approval" } });
    expect(seen[1]).toMatchObject({ method: "GET", url: "/hooks/api/bots/b1/messages?thread=t1" });

    next = { status: 429, body: JSON.stringify({ error: "Too many calls" }), headers: { "retry-after": "12" } };
    expect(await sendToRemote(far, { message: "again", thread: "t1" })).toEqual({ ok: false, problem: "rate_limited", status: 429, detail: "Too many calls", retryAfterSeconds: 12 });
    next = { status: 401, body: JSON.stringify({ error: "Invalid key" }) };
    expect(await sendToRemote(far, { message: "x" })).toMatchObject({ ok: false, problem: "wrong_key", status: 401 });
    next = { status: 200, body: "<html>proxy login</html>" };
    expect(await sendToRemote(far, { message: "x" })).toEqual({ ok: false, problem: "bad_answer", status: 200 });
    next = { status: 200, body: JSON.stringify({ reply: "no thread" }) };
    expect(await sendToRemote(far, { message: "x" })).toEqual({ ok: false, problem: "bad_answer", status: 200 });
    next = { status: 200, body: JSON.stringify({ reply: "x".repeat(1_100_000), thread: "t1" }) };
    expect(await sendToRemote(far, { message: "x" })).toEqual({ ok: false, problem: "bad_answer", status: 200 });
    next = { status: 502, body: JSON.stringify({ error: "could not answer" }) };
    expect(await readRemote(far, "t1")).toMatchObject({ ok: false, problem: "failed", status: 502 });
    expect(await readRemote(far, "../etc")).toEqual({ ok: false, problem: "no_thread" });

    next = { status: 404, body: JSON.stringify({ error: "no such thread" }) };
    expect(await checkRemote(far)).toEqual({ ok: true });
    next = { status: 404, body: JSON.stringify({ error: "Not found" }) };
    expect(await checkRemote(far)).toEqual({ ok: false, problem: "bad_answer", status: 404, detail: "Not found" });
    next = { status: 404, body: "<html>no page</html>" };
    expect(await checkRemote(far)).toEqual({ ok: false, problem: "bad_answer", status: 404 });
  });

  it("never follows a redirect, so the key reaches only the saved address", async () => {
    const elsewhere: string[] = [];
    const other = await listen((req, res) => { elsewhere.push(req.headers.authorization ?? ""); res.end("{}"); });
    const base = await listen((_req, res) => { res.writeHead(307, { location: `${other}/hooks/api/bots/b1/messages` }); res.end(); });
    expect(await sendToRemote(teammate(base), { message: "x" })).toMatchObject({ ok: false, problem: "unreachable" });
    expect(elsewhere).toEqual([]);
  });

  it("says unreachable when nothing answers", async () => {
    const base = await listen(() => {});
    const closed = servers.pop()!;
    await new Promise((resolve) => closed.close(resolve));
    expect(await checkRemote(teammate(base))).toMatchObject({ ok: false, problem: "unreachable" });
  });
});

type Task = { threadId: string; title: string; busy: boolean; botApi?: true };

/** A real Bot API door on a loopback port, with the slice of the store it reads and writes in memory. */
async function realBotApi(): Promise<{ base: string; key: string; manager: BotApiManager }> {
  const bots = new Map<string, { id: string; name: string; tasks: Task[] }>([["b1", { id: "b1", name: "Scout", tasks: [] }]]);
  const messages = new Map<string, Message[]>();
  let ids = 0;
  const store = {
    bot: (id: string) => bots.get(id),
    taskByThread: (botId: string, threadId: string) => bots.get(botId)?.tasks.find((task) => task.threadId === threadId),
    createTask: (botId: string, title?: string) => {
      const task: Task = { threadId: `t${++ids}`, title: title ?? "New thread", busy: false };
      bots.get(botId)!.tasks.push(task);
      messages.set(task.threadId, []);
      return task;
    },
    patchTask: (botId: string, threadId: string, patch: Partial<Task>) => {
      const task = bots.get(botId)?.tasks.find((candidate) => candidate.threadId === threadId);
      if (task) Object.assign(task, patch);
      return task ?? null;
    },
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const line = { ...message, id: `m${++ids}`, at: Date.now() } as Message;
      messages.set(threadId, [...(messages.get(threadId) ?? []), line]);
      return line;
    },
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    activeLeaf: (threadId: string) => messages.get(threadId)?.at(-1)?.id ?? null,
    setActiveLeaf: (_threadId: string, messageId: string) => messageId,
    onChange: () => () => {},
  } as unknown as BotApiHostDeps["store"];
  const manager = new BotApiManager({ file: join(dirname(tempFile()), "bot-api.json") });
  const host = createBotApiHost({
    store, manager, waitMs: 5_000,
    startTurn: async (_botId, prompt, opts) => {
      store.appendMessage(opts.threadId, { role: "bot", kind: "text", text: `got ${prompt.includes("ping") ? "ping" : "?"}` } as never);
      opts.onSettled({ ok: true, text: "" });
    },
    threadBusy: () => false, canStart: () => true, canConfine: () => true, discard: () => {},
    hooksBaseUrl: () => "https://unused.example.test", manageRefusal: () => null,
  });
  const handle = createWebhookIngressHandler({ authorize: () => false, recordUnauthorized: () => null } as unknown as WebhookManager, undefined, host.door);
  const base = await listen((req, res) => { void handle(req, res); });
  return { base, key: manager.enable("b1").key, manager };
}

describe("against a real Bot API door", () => {
  it("checks the key without starting anything, then sends and gets the reply", async () => {
    const remote = await realBotApi();
    expect(await checkRemote(teammate(remote.base, remote.key))).toEqual({ ok: true });
    expect(await checkRemote(teammate(remote.base))).toMatchObject({ ok: false, problem: "wrong_key", status: 401 });
    expect(remote.manager.status("b1").callCount).toBe(0);
    const sent = await sendToRemote(teammate(remote.base, remote.key), { message: "ping", wait: 5 });
    expect(sent).toEqual({ ok: true, answer: { reply: "got ping", thread: expect.any(String) } });
    remote.manager.disable("b1");
    expect(await checkRemote(teammate(remote.base, remote.key))).toMatchObject({ ok: false, problem: "refused", status: 403 });
  });
});

describe("/api/remote-teammates", () => {
  async function app() {
    const teammates = new RemoteTeammates({ file: tempFile() });
    const remote = await realBotApi();
    const routes = [createRemoteTeammateRoutes({ teammates })];
    const base = await listen(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "no route" });
    });
    const call = async (method: string, path: string, body?: unknown): Promise<[number, any]> => {
      const response = await fetch(base + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
      return [response.status, await response.json()];
    };
    return { call, remote };
  }

  it("adds, lists without the key, checks and removes a teammate", async () => {
    const { call, remote } = await app();
    const [status, added] = await call("POST", "/api/remote-teammates", { name: "Far", address: `${remote.base}/hooks/api/bots/b1/messages`, key: remote.key });
    expect(status).toBe(201);
    expect(added.teammate).toMatchObject({ name: "Far", base: remote.base, botId: "b1" });
    const [, listed] = await call("GET", "/api/remote-teammates");
    expect(listed.teammates).toEqual([added.teammate]);
    expect(JSON.stringify(listed)).not.toContain(remote.key);
    expect(await call("POST", `/api/remote-teammates/${added.teammate.id}/check`)).toEqual([200, { ok: true }]);
    expect(await call("DELETE", `/api/remote-teammates/${added.teammate.id}`)).toEqual([200, { removed: true }]);
    expect(await call("DELETE", `/api/remote-teammates/${added.teammate.id}`)).toEqual([404, { error: "no such teammate" }]);
    expect((await call("GET", "/api/remote-teammates"))[1]).toEqual({ teammates: [] });
  });

  it("answers a bad teammate with 400 and leaves other paths to the next route", async () => {
    const { call } = await app();
    const [status, body] = await call("POST", "/api/remote-teammates", { name: "Far", address: "http://maus.example.com", botId: "b1", key: KEY });
    expect(status).toBe(400);
    expect(body.error).toMatch(/open internet/);
    expect(await call("GET", "/api/remote-teammates-other")).toEqual([404, { from: "no route" }]);
  });
});
