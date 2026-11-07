import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { LinkOpened } from "../electron/device-link-protocol.mjs";
import { StdioSessions } from "./lent-mcp-stdio.ts";
import { stdioChild } from "./testing/stdio-mcp-child.ts";

const servers: Server[] = [];
const sessions: StdioSessions[] = [];

afterEach(() => {
  for (const each of sessions.splice(0)) each.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); }
});

const within = <T>(promise: Promise<T>, ms = 3000): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, fail) => setTimeout(() => fail(new Error("timed out")), ms).unref())]);

const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 5));
  }
};

async function make(open: () => Promise<LinkOpened>, extra: { idleMs?: number; now?: () => number; sweepMs?: number; onEmpty?: () => void } = {}) {
  const outcomes: unknown[] = [];
  const stdio = new StdioSessions({ open, idleMs: 600_000, ...extra });
  sessions.push(stdio);
  const server = createServer((req, res) => void stdio.handle(req, res).then((outcome) => {
    outcomes.push(outcome);
    if (outcome && outcome !== "opened") res.writeHead(502).end(JSON.stringify(outcome.refused));
  }, () => res.destroy()));
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const post = (body: unknown, session?: string) => within(fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { stdio, url, post, outcomes };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine", version: "1" } } };

async function opened(extra?: Parameters<typeof make>[1]) {
  const { child, link } = stdioChild();
  let opens = 0;
  const made = await make(async () => { opens += 1; return link; }, extra);
  const answer = await made.post(initialize);
  const session = answer.headers.get("mcp-session-id")!;
  return { ...made, child, answer, session, opens: () => opens };
}

describe("StdioSessions", () => {
  it("initialize opens one stream and returns a session id; tools/list on that session gets its answer by id", async () => {
    const { child, answer, session, post, opens, outcomes, stdio } = await opened();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(((await answer.json()) as { id: number; result: { protocolVersion: string } })).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    expect(outcomes).toEqual(["opened"]);

    const listed = await post({ jsonrpc: "2.0", id: "list-1", method: "tools/list" }, session);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("mcp-session-id"), "only initialize's answer names the session").toBeNull();
    const list = (await listed.json()) as { id: string; result: { tools: { name: string }[] } };
    expect(list.id).toBe("list-1");
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["charge", "refund"]);

    const batch = await post([{ jsonrpc: "2.0", id: 7, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/progress" }, { jsonrpc: "2.0", id: "7", method: "tools/list" }], session);
    expect(((await batch.json()) as { id: unknown }[]).map((each) => each.id), "an array answers an array, matched by exact id").toEqual([7, "7"]);

    expect(opens(), "one stream for the whole session").toBe(1);
    expect(stdio.size).toBe(1);
    expect(child.lines.map((line) => JSON.parse(line).method)).toEqual(["initialize", "tools/list", "tools/list", "notifications/progress", "tools/list"]);
    expect(outcomes.slice(1)).toEqual([undefined, undefined]);
  });

  it("a notification gets 202 and no answer is awaited", async () => {
    const { child, session, post } = await opened();
    const answer = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    expect(answer.status).toBe(202);
    expect(await answer.text()).toBe("");
    const response = await post({ jsonrpc: "2.0", id: 99, result: {} }, session);
    expect(response.status, "a client's answer to the server is not a request").toBe(202);
    await until(() => child.lines.length === 3);
    expect(child.lines.slice(1).map((line) => JSON.parse(line))).toEqual([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 99, result: {} }]);
  });

  it("a server-sent message reaches the GET stream as an SSE event", async () => {
    const { session, post, url } = await opened();
    const stale = await within(fetch(url, { headers: { "mcp-session-id": session } }));
    const events = await within(fetch(url, { headers: { "mcp-session-id": session } }));
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    await expect(within(stale.text()), "a newer GET replaces the older").resolves.toBe("");

    const called = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "charge", arguments: {} } }, session);
    expect(((await called.json()) as { result: unknown }).result).toEqual({ content: [{ type: "text", text: "charged" }] });
    const reader = events.body!.getReader();
    let streamed = "";
    while (streamed.split("\n\n").length < 3) streamed += new TextDecoder().decode((await within(reader.read())).value);
    expect(streamed, "the server's own request under the call's id is not taken for the call's answer").toBe([
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "charging" } })}\n\n`,
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "roots/list" })}\n\n`,
    ].join(""));
    await reader.cancel();
  });

  it("DELETE and idle end the stream", async () => {
    const { child, session, post, url, stdio } = await opened();
    const deleted = await within(fetch(url, { method: "DELETE", headers: { "mcp-session-id": session } }));
    expect(deleted.status).toBe(200);
    await until(() => child.closed);
    expect(stdio.size).toBe(0);
    expect((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session)).status).toBe(404);

    let now = 1_000;
    const { child: idle, session: quiet, post: postQuiet, stdio: quietStdio } = await opened({ idleMs: 60_000, now: () => now, sweepMs: 10 });
    const pending = postQuiet({ jsonrpc: "2.0", id: 3, method: "slow" }, quiet);
    await until(() => idle.lines.length === 2);
    now += 59_999;
    await new Promise((done) => setTimeout(done, 50));
    expect(quietStdio.size, "a session quiet for less than idleMs stays").toBe(1);
    now += 1;
    expect((await pending).status, "a POST pending when the session idles out").toBe(504);
    await until(() => idle.closed);
    expect(quietStdio.size).toBe(0);
  });

  it("the computer ending the stream answers pending POSTs 502 and ends the SSE", async () => {
    const { child, session, post, url, stdio } = await opened();
    const events = await within(fetch(url, { headers: { "mcp-session-id": session } }));
    const pending = post({ jsonrpc: "2.0", id: 3, method: "slow" }, session);
    await until(() => child.lines.length === 2);
    child.end();
    expect((await pending).status).toBe(502);
    await expect(within(events.text())).resolves.toBe("");
    await until(() => child.closed);
    expect(stdio.size).toBe(0);
  });

  it("a POST without a session id that isn't an initialize request is 400; an unknown session is 404", async () => {
    let opens = 0;
    const { post, url, stdio } = await make(async () => { opens += 1; return stdioChild().link; });
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(400);
    const { id: _id, ...notice } = initialize;
    expect((await post(notice)).status, "an initialize with no id: nobody would get the session").toBe(400);
    expect((await post([notice, { jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(7)).status, "a message is an object").toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post({ ...initialize, padding: "x".repeat(4 * 1024 * 1024) })).status).toBe(413);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "f".repeat(36))).status).toBe(404);
    expect((await within(fetch(url, { headers: { "mcp-session-id": "nope" } }))).status).toBe(404);
    expect((await within(fetch(url))).status, "a GET names its session").toBe(400);
    expect((await within(fetch(url, { method: "DELETE", headers: { "mcp-session-id": "nope" } }))).status).toBe(404);
    expect((await within(fetch(url, { method: "PUT" }))).status).toBe(405);
    expect(opens).toBe(0);
    expect(stdio.size).toBe(0);
  });

  it("an initialize while the computer refuses is reported to the caller, not answered as a session", async () => {
    const { post, outcomes, stdio } = await make(async () => ({ refused: "needs-approval" }));
    const answer = await post(initialize);
    expect(answer.status).toBe(502);
    expect(answer.headers.get("mcp-session-id")).toBeNull();
    expect(await answer.json()).toEqual({ refused: "needs-approval" });
    expect(outcomes).toEqual([{ refused: { refused: "needs-approval" }, messages: [initialize] }]);
    expect(stdio.size).toBe(0);

    const thrown = await make(async () => { throw new Error("link gone"); });
    expect(await (await thrown.post(initialize)).json()).toEqual({ gone: true });
  });

  it("a refused initialize comes back with the parsed messages, so the caller answers without reading the body again", async () => {
    const { post, outcomes } = await make(async () => ({ refused: "needs-approval" }));
    expect((await post([initialize])).status).toBe(502);
    expect(outcomes).toEqual([{ refused: { refused: "needs-approval" }, messages: [initialize] }]);
  });

  it("onEmpty runs once the last session ends, by DELETE or by the idle sweep", async () => {
    let empties = 0;
    const onEmpty = () => { empties += 1; };
    const deleted = await opened({ onEmpty });
    const second = await deleted.post(initialize);
    await second.arrayBuffer();
    const url = deleted.url;
    await within(fetch(url, { method: "DELETE", headers: { "mcp-session-id": deleted.session } }));
    expect(empties, "one session is still open").toBe(0);
    await within(fetch(url, { method: "DELETE", headers: { "mcp-session-id": second.headers.get("mcp-session-id")! } }));
    expect(empties).toBe(1);

    let now = 1_000;
    const idle = await opened({ idleMs: 60_000, now: () => now, sweepMs: 10, onEmpty });
    now += 60_000;
    await until(() => empties === 2);
    expect(idle.stdio.size).toBe(0);
  });

  it("drop ends every session", async () => {
    const { child, stdio } = await opened();
    stdio.drop();
    await until(() => child.closed);
    expect(stdio.size).toBe(0);
  });
});
