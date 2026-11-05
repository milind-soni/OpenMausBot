import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOVE_GRANT_TTL_MS, MoveGrants } from "../src/move-grants.ts";
import { companionIdentityHeaders, createProxyHandler, proxyHeadersTimeoutMs, type ProxyOptions } from "../src/proxy.ts";

const listen = (server: Server) => new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const close = (server: Server) => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

const noRoute = (method: string, path: string) => JSON.stringify({ error: `no route: ${method} ${path}` });

async function companion(overrides: Partial<ProxyOptions> = {}) {
  let clock = 1_000;
  const moves = new MoveGrants(() => clock);
  const askOwner = vi.fn((_ask: { deviceId: string; deviceName: string; bots: number }) => true);
  const seen: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }> = [];
  let answer = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
    req.resume();
    answer(res);
  });
  servers.push(upstream);
  const handler = createProxyHandler({
    harnessPort: await listen(upstream),
    mutationToken: () => "relay-secret",
    authenticate: (token) => token === "phone-token"
      ? { id: "phone-1", name: "Omkar's iPhone", cloudDesktopAccess: false, browserControlAccess: false }
      : null,
    redeem: () => ({ error: "not used here" }),
    serverName: () => "Test computer",
    moves,
    askOwner,
    ...overrides,
  });
  const relay = createServer(handler);
  servers.push(relay);
  const port = await listen(relay);
  const phone = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: "Bearer phone-token", ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, text: await res.text() };
  };
  return {
    moves,
    askOwner,
    seen,
    phone,
    advance: (ms: number) => { clock += ms; },
    answerWith: (next: (res: ServerResponse) => void) => { answer = next; },
  };
}

describe("a phone moving its bots in", () => {
  it("raises one ask with the phone's name and answers pending, then granted once the owner allows", async () => {
    const { phone, askOwner, seen, moves } = await companion();
    const first = await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.text)).toEqual({ v: 1, state: "pending", expiresAt: expect.any(Number) });
    expect(askOwner.mock.calls).toEqual([[{ deviceId: "phone-1", deviceName: "Omkar's iPhone", bots: 4 }]]);

    const again = await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    expect(again.status).toBe(202);
    expect(askOwner).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);

    moves.allow("phone-1");
    const granted = await phone("GET", "/api/companion/move");
    expect(granted.status).toBe(200);
    expect(JSON.parse(granted.text)).toEqual({ v: 1, state: "granted", expiresAt: expect.any(Number) });
    const repeat = await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    expect(repeat.status).toBe(200);
    expect(askOwner).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed ask, and one no app on this computer can show", async () => {
    const { phone, askOwner } = await companion();
    for (const body of [{ v: 1, bots: 0 }, { v: 1, bots: 201 }, { v: 1, bots: "4" }, { bots: 4 }, { v: 1, bots: 1.5 }]) {
      const res = await phone("POST", "/api/companion/move", body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text)).toEqual({ error: "send { v: 1, bots }" });
    }
    expect(askOwner).not.toHaveBeenCalled();

    const headless = await companion({ askOwner: undefined });
    const refused = await headless.phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text)).toEqual({ error: "Open OpenMausBot on this computer to move bots here." });
    expect(JSON.parse((await headless.phone("GET", "/api/companion/move")).text)).toEqual({ v: 1, state: "none" });

    const unpaired = await phone("POST", "/api/companion/move", { v: 1, bots: 4 }, { authorization: "Bearer unpaired" });
    expect(unpaired.status).toBe(401);
    expect(askOwner).not.toHaveBeenCalled();
  });

  it("forwards the move header only on a move route while the grant is live", async () => {
    const { phone, moves, seen } = await companion();
    const forged = { "x-openmausbot-companion-move": "1" };

    for (const headers of [{}, forged]) {
      const closed = await phone("POST", "/api/cloud-send/chats", { v: 1 }, headers);
      expect(closed.status).toBe(404);
      expect(closed.text).toBe(noRoute("POST", "/api/cloud-send/chats"));
    }
    expect(seen).toEqual([]);

    await phone("PATCH", "/api/bots/b1", { name: "x" }, forged);
    expect(seen.at(-1)?.path).toBe("/api/bots/b1");
    expect(seen.at(-1)?.headers["x-openmausbot-companion-move"]).toBeUndefined();

    await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    moves.allow("phone-1");
    expect((await phone("POST", "/api/cloud-send/chats", { v: 1 }, forged)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/cloud-send/chats",
      headers: {
        "x-openmausbot-companion-move": "1",
        "x-openmausbot-companion-device": "phone-1",
        "x-openmausbot-companion-auth": "relay-secret",
      },
    });

    await phone("GET", "/api/bots", undefined, forged);
    expect(seen.at(-1)?.path).toBe("/api/bots");
    expect(seen.at(-1)?.headers["x-openmausbot-companion-move"]).toBeUndefined();
  });

  it("never marks a move without the relay token the harness checks it against", () => {
    expect(companionIdentityHeaders("phone-1", undefined, true)).not.toHaveProperty("x-openmausbot-companion-move");
    expect(companionIdentityHeaders("phone-1", "relay-secret", false)).not.toHaveProperty("x-openmausbot-companion-move");
    expect(companionIdentityHeaders("phone-1", "relay-secret", true)).toHaveProperty("x-openmausbot-companion-move", "1");
  });

  it("a request that began under the grant finishes; the next one gets today's 404", async () => {
    const { phone, moves, answerWith } = await companion();
    await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    moves.allow("phone-1");

    let release = () => {};
    const reached = new Promise<void>((resolve) => {
      answerWith((res) => {
        release = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ conversations: 1 }));
        };
        resolve();
      });
    });
    const inFlight = phone("POST", "/api/cloud-send/chats", { v: 1 });
    await reached;
    moves.refuse("phone-1");
    release();
    expect((await inFlight).status).toBe(200);

    const next = await phone("POST", "/api/cloud-send/chats", { v: 1 });
    expect(next.status).toBe(404);
    expect(next.text).toBe(noRoute("POST", "/api/cloud-send/chats"));
    expect(JSON.parse((await phone("GET", "/api/companion/move")).text)).toEqual({ v: 1, state: "refused" });
  });

  it("closes the move routes again once the grant runs out", async () => {
    const { phone, moves, advance } = await companion();
    await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    moves.allow("phone-1");
    expect((await phone("POST", "/api/cloud-send/memory", { v: 1 })).status).toBe(200);
    advance(MOVE_GRANT_TTL_MS);
    const next = await phone("POST", "/api/cloud-send/memory", { v: 1 });
    expect(next.status).toBe(404);
    expect(next.text).toBe(noRoute("POST", "/api/cloud-send/memory"));
    expect(JSON.parse((await phone("GET", "/api/companion/move")).text)).toEqual({ v: 1, state: "expired" });
  });

  it("lets the phone end its own grant", async () => {
    const { phone, moves } = await companion();
    await phone("POST", "/api/companion/move", { v: 1, bots: 4 });
    moves.allow("phone-1");
    const ended = await phone("DELETE", "/api/companion/move");
    expect(ended.status).toBe(200);
    expect(JSON.parse(ended.text)).toEqual({ v: 1, state: "none" });
    const next = await phone("POST", "/api/cloud-send/memory", { v: 1 });
    expect(next.status).toBe(404);
    expect(next.text).toBe(noRoute("POST", "/api/cloud-send/memory"));
  });

  it("gives a request the grant opened the long deadline a large upload needs", () => {
    expect(proxyHeadersTimeoutMs("/api/cloud-send/chats", undefined, true)).toBe(105_000);
    expect(proxyHeadersTimeoutMs("/api/cloud-send/files?path=workspaces/b/x&size=1", undefined, true)).toBe(105_000);
    expect(proxyHeadersTimeoutMs("/api/bots")).toBe(30_000);
    expect(proxyHeadersTimeoutMs("/api/cloud-send/chats")).toBe(30_000);
  });
});
