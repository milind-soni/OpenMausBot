import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BROKER_PROCESS_TTL_MS, BROKER_THREAD_TTL_MS, BROKER_TOKEN_PREFIX, brokerUrl, openCredentialBroker, type CredentialBroker } from "./broker.ts";
import { testSocketPath } from "./test-socket-path.ts";

const REAL_KEY = "sk-ant-real-key-0123456789abcdef";

function call(socketPath: string, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ socketPath, path, method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the credential broker", () => {
  let upstream: Server, broker: CredentialBroker, dir: string, clock = 1_800_000_000_000;
  const seen: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  afterEach(async () => {
    await broker?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    seen.length = 0;
  });

  async function start(): Promise<number> {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        if (req.url?.includes("/stream")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: message_start\ndata: {}\n\n");
          setTimeout(() => res.end("event: message_stop\ndata: {}\n\n"), 20);
          return;
        }
        res.writeHead(req.headers["x-api-key"] === REAL_KEY || req.headers.authorization === `Bearer ${REAL_KEY}` ? 200 : 401, { "content-type": "application/json", "x-upstream": "yes" });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    dir = mkdtempSync(join(tmpdir(), "omb-broker-"));
    broker = await openCredentialBroker({ socketPath: testSocketPath(dir, "b.sock"), now: () => clock });
    return (upstream.address() as { port: number }).port;
  }

  it("adds the real key for a fixed upstream, strips the client's credential headers, and streams", async () => {
    const port = await start();
    const minted = broker.mintForProcess({ botId: "bot-a", threadId: "t1", grants: { anthropic: { upstream: `http://127.0.0.1:${port}/v1/`, headers: { "x-api-key": REAL_KEY } } } });
    expect(minted.token.startsWith(BROKER_TOKEN_PREFIX)).toBe(true);
    expect(minted.token).toHaveLength(BROKER_TOKEN_PREFIX.length + 48);
    const answer = await call(broker.socketPath, "POST", `/b/${minted.token}/anthropic/messages?beta=1`, { "x-api-key": minted.token, authorization: "Bearer leaked", "anthropic-version": "2023-06-01", "content-type": "application/json" }, '{"model":"x"}');
    expect(answer.status).toBe(200);
    expect(answer.headers["x-upstream"]).toBe("yes");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/messages?beta=1", body: '{"model":"x"}' });
    expect(seen[0]!.headers["x-api-key"]).toBe(REAL_KEY);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(minted.token);
    const stream = await call(broker.socketPath, "GET", `/b/${minted.token}/anthropic/stream`);
    expect(stream.body).toBe("event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
    expect(broker.stats()).toMatchObject({ tokens: 1, forwarded: 2, refused: 0 });
    expect(brokerUrl(18080, minted.token, "anthropic")).toBe(`http://127.0.0.1:18080/b/${minted.token}/anthropic`);
  });

  it("refuses a wrong token, another bot's grant name, a revoked token and an expired one", async () => {
    const port = await start();
    const grants = { anthropic: { upstream: `http://127.0.0.1:${port}`, headers: { "x-api-key": REAL_KEY } } };
    const mine = broker.mintForProcess({ botId: "bot-a", threadId: "t1", grants });
    const theirs = broker.mintForThread({ botId: "bot-b", threadId: "t2", grants: { openai: { upstream: `http://127.0.0.1:${port}`, headers: { authorization: `Bearer ${REAL_KEY}` } } } });
    expect((await call(broker.socketPath, "GET", `/b/${BROKER_TOKEN_PREFIX}${"0".repeat(48)}/anthropic/x`)).status).toBe(401);
    expect((await call(broker.socketPath, "GET", `/b/not-a-token/anthropic/x`)).status).toBe(401);
    expect((await call(broker.socketPath, "GET", `/b/${mine.token}/openai/x`)).status).toBe(403);
    expect((await call(broker.socketPath, "GET", `/b/${theirs.token}/anthropic/x`)).status).toBe(403);
    expect((await call(broker.socketPath, "GET", `/b/${theirs.token}/openai/x`)).status).toBe(200);
    expect((await call(broker.socketPath, "GET", `/b/${mine.token}/anthropic/x`)).status).toBe(200);
    broker.revoke(mine.token);
    expect((await call(broker.socketPath, "GET", `/b/${mine.token}/anthropic/x`)).status).toBe(401);
    broker.revokeThread("t2");
    expect((await call(broker.socketPath, "GET", `/b/${theirs.token}/openai/x`)).status).toBe(401);
    const short = broker.mintForProcess({ grants, ttlMs: 1_000 });
    expect((await call(broker.socketPath, "GET", `/b/${short.token}/anthropic/x`)).status).toBe(200);
    clock += 1_001;
    expect(await call(broker.socketPath, "GET", `/b/${short.token}/anthropic/x`)).toMatchObject({ status: 401, body: JSON.stringify({ error: "expired_token" }) });
    expect((await call(broker.socketPath, "GET", "/other")).status).toBe(404);
    expect(seen).toHaveLength(3);
    expect(broker.stats().refused).toBe(7);
  });

  it("a thread-bound token slides with each turn and a process-bound one does not", async () => {
    await start();
    const grants = { g: { upstream: "http://127.0.0.1:9", headers: {} } };
    const forThread = broker.mintForThread({ threadId: "t9", grants });
    const forProcess = broker.mintForProcess({ threadId: "t9", grants });
    expect(forThread.expiresAt).toBe(clock + BROKER_THREAD_TTL_MS);
    expect(forProcess.expiresAt).toBe(clock + BROKER_PROCESS_TTL_MS);
    clock += BROKER_THREAD_TTL_MS - 1_000;
    broker.touchThread("t9");
    clock += 2_000;
    expect(broker.lookup(forThread.token, "g").ok).toBe(true);
    expect(broker.lookup(forProcess.token, "g")).toMatchObject({ ok: false, error: "expired_token" });
    broker.revokeThread("t9");
    expect(broker.lookup(forThread.token, "g")).toMatchObject({ ok: false, error: "unknown_token" });
  });

  it("refuses a grant name it cannot put in a URL", async () => {
    await start();
    expect(() => broker.mintForProcess({ grants: { "../x": { upstream: "http://127.0.0.1:9", headers: {} } } })).toThrow(/grant name/);
  });
});
