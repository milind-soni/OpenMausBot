import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { harnessPathAllowed, openHarnessGate, type HarnessGate } from "./harness-gate.ts";
import { testSocketPath } from "./test-socket-path.ts";

function call(socketPath: string, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the harness gate", () => {
  let upstream: Server, gate: HarnessGate, dir: string;
  const seen: Array<{ method: string; url: string; body: string; authorization: string | undefined }> = [];
  afterEach(async () => {
    await gate?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    seen.length = 0;
  });

  async function start(): Promise<void> {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body, authorization: req.headers.authorization });
        if (req.url?.startsWith("/api/internal/stream")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: one\n\n");
          setTimeout(() => res.end("data: two\n\n"), 30);
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "x-answered": "yes" });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    dir = mkdtempSync(join(tmpdir(), "omb-harness-"));
    gate = await openHarnessGate({ socketPath: testSocketPath(dir, "h.sock"), port: (upstream.address() as { port: number }).port });
  }

  it("forwards the harness routes with their method, query, body and bearer, and streams an event stream", async () => {
    await start();
    const posted = await call(gate.socketPath, "POST", "/api/internal/tool-result?id=7", JSON.stringify({ x: 1 }), { authorization: "Bearer cap" });
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body)).toEqual({ ok: true, url: "/api/internal/tool-result?id=7" });
    expect(posted.headers["x-answered"]).toBe("yes");
    expect(seen).toEqual([{ method: "POST", url: "/api/internal/tool-result?id=7", body: '{"x":1}', authorization: "Bearer cap" }]);
    const stream = await call(gate.socketPath, "GET", "/api/internal/stream");
    expect(stream.body).toBe("data: one\n\ndata: two\n\n");
    expect(gate.refused).toBe(0);
  });

  it("answers 403 itself for every other route, so the server is never asked", async () => {
    await start();
    for (const path of ["/api/bots", "/api/config", "/api/auth/session", "/", "/api/internal/../bots", "/api/internalx", "//api/internal/x"]) {
      const answer = await call(gate.socketPath, "GET", path);
      expect(answer.status, path).toBe(403);
      expect(JSON.parse(answer.body)).toEqual({ error: "not_a_harness_route" });
    }
    expect(seen).toEqual([]);
    expect(gate.refused).toBe(7);
  });

  it("says 502 when the server is not listening", async () => {
    await start();
    const port = (upstream.address() as { port: number }).port;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    upstream = createServer(() => {});
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    expect(port).not.toBe((upstream.address() as { port: number }).port);
    const answer = await call(gate.socketPath, "GET", "/api/internal/agents");
    expect(answer.status).toBe(502);
  });

  it("decides by path alone", () => {
    expect(harnessPathAllowed("/api/internal/agents")).toBe(true);
    expect(harnessPathAllowed("/api/internal/mcp-http/browser")).toBe(true);
    expect(harnessPathAllowed("/api/internal/")).toBe(true);
    expect(harnessPathAllowed("/api/internal")).toBe(false);
    expect(harnessPathAllowed("/api/bots")).toBe(false);
    expect(harnessPathAllowed("/api/internal/..\\x")).toBe(false);
    expect(harnessPathAllowed("/api/bots", ["/api/bots"])).toBe(true);
  });
});
