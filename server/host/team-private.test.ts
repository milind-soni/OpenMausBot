import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createReactions } from "../reactions.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createReactionRoutes } from "../routes/reactions.ts";
import type { Message } from "../store.ts";
import { createVisibilityHost } from "./visibility-host.ts";
import { hiddenThreadRefusal } from "./team-private.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(path: string, team = true) {
  let bot = { id: "b1", name: "Bot", threadId: "t1", visibility: "everyone" };
  let privateThread = false;
  let message: Message = { id: "m1", role: "bot", kind: "text", at: 1, text: "public text" };
  let writes = 0;
  const store = {
    get bots() { return [bot]; }, groups: [{ id: "g1", threadId: "room", memberIds: ["b1"] }], bot: (id: string) => id === "b1" ? bot : null,
    botByThread: (id: string) => id === "t1" ? bot : null, groupByThread: () => null,
    group: (id: string) => id === "g1" ? store.groups[0] : null,
    messagesFor: () => [message],
    setReaction: () => { writes++; return message; },
  };
  const visibility = createVisibilityHost({ store: () => store as never, routines: () => null, team,
    audiencesFor: () => team ? { person: "alice", of: () => privateThread ? "member:bob" : "team" } : undefined, threadsReferencing: () => [] });
  const auth: RequestAuth = { kind: "session", via: "bearer", scopes: ["client"], session: {
    id: "alice", email: "alice@example.test", tokenHash: "fixture", label: "Alice", scopes: ["client"],
    createdAt: 1, lastSeenAt: 1, expiresAt: Date.now() + 60_000,
  } };
  const reactions = createReactions({ store: store as never, reply: async () => { throw Error("unexpected reply"); },
    answerCard: async () => { throw Error("unexpected card"); }, withdraw: () => {} });
  const route = createReactionRoutes({ react: reactions.react, reactorFor: () => ({ by: "alice" }),
    cloudGuestSendRefusal: () => null, threadVisible: (viewer, threadId) => visibility.visibleTo(visibility.viewerFor(viewer)).thread(threadId) });
  const checked = deferred();
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url!, "http://localhost");
    const visible = visibility.visibleTo(visibility.viewerFor(auth));
    const refusal = (current: typeof visible) => visibility.hiddenPath(url.pathname, current);
    const hidden = refusal(visible) ?? hiddenThreadRefusal(req, url.pathname, url.searchParams, visible, () => bot.threadId,
      () => { const current = visibility.visibleTo(visibility.viewerFor(auth)); return { visible: current, hidden: refusal(current) }; });
    if (hidden) return json(res, 404, { error: hidden });
    checked.resolve();
    if (url.pathname.endsWith("/reactions")) {
      await route({ req, res, url, path: url.pathname, method: req.method!, auth, json, readBody });
    } else {
      await readBody(req);
      writes++;
      json(res, 200, { message });
    }
  })().catch((error) => json(res, error.status ?? 500, { error: error.message })); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const held = request(base + path, { method: "POST", headers: { "content-type": "application/json" } });
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    held.on("error", reject);
    held.on("response", (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
  });
  held.flushHeaders();
  await checked.promise;
  return { held, response, base, writes: () => writes, hideThread: () => { privateThread = true; visibility.forgetVisibility(); }, hide: () => {
    bot = { ...bot, visibility: "admins" };
    message = { ...message, text: "PRIVATE TEXT ADDED AFTER ACCESS WAS REVOKED" };
    visibility.forgetVisibility();
  } };
}

it("refuses a held reaction without changing the message after the bot becomes hidden", async () => {
  const path = "/api/threads/t1/messages/m1/reactions";
  const f = await fixture(path);
  f.hide();
  const fresh = await fetch(f.base + path, { method: "POST", body: '{"emoji":"❤️"}' });
  expect(fresh.status).toBe(404);
  await fresh.text();
  f.held.end('{"emoji":"❤️"}');
  expect(await f.response).toEqual({ status: 404, body: { error: "no such conversation" } });
  expect(f.writes()).toBe(0);
});

it.each([
  ["bot path", "/api/bots/b1/memory", {}, true, "no such bot"],
  ["non-team bot path", "/api/bots/b1/memory", {}, false, "no such bot"],
  ["thread path", "/api/threads/t1/undo", {}, true, "no such conversation"],
  ["group path", "/api/groups/g1/setup", {}, true, "no such channel"],
  ["query", "/api/example?threadId=t1", {}, true, "no such conversation"],
  ["body", "/api/example", { threadId: "t1" }, true, "no such conversation"],
  ["selected conversation", "/api/bots/b1/compact", {}, true, "no such bot"],
])("rechecks current visibility for a held %s before committing", async (_name, path, body, team, error) => {
  const f = await fixture(path, team);
  f.hide();
  f.held.end(JSON.stringify(body));
  expect(await f.response).toEqual({ status: 404, body: { error } });
  expect(f.writes()).toBe(0);
});

it.each([
  ["query", "/api/example?threadId=t1", {}],
  ["body", "/api/example", { threadId: "t1" }],
  ["selected conversation", "/api/bots/b1/compact", {}],
])("rechecks a held %s when only the conversation audience changes", async (_name, path, body) => {
  const f = await fixture(path);
  f.hideThread();
  f.held.end(JSON.stringify(body));
  expect(await f.response).toEqual({ status: 404, body: { error: "no such conversation" } });
  expect(f.writes()).toBe(0);
});

it("keeps a visible held reaction working", async () => {
  const f = await fixture("/api/threads/t1/messages/m1/reactions");
  f.held.end('{"emoji":"❤️"}');
  expect(await f.response).toMatchObject({ status: 200, body: { delivery: "noted" } });
  expect(f.writes()).toBe(1);
});
