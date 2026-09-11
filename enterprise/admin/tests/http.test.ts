import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { portalHttpServer } from "../server/http.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(unix = false) {
  const directory = mkdtempSync(join(tmpdir(), "omb-admin-http-"));
  writeFileSync(join(directory, "index.html"), "<h1>Disposable portal</h1>");
  const seen: Request[] = [];
  const url = "http://admin.example.test";
  const server = portalHttpServer({ url, webDir: directory, handle: async request => {
    seen.push(request);
    return Response.json({ ok: true });
  } });
  const socketPath = join(directory, "http.sock");
  await new Promise<void>(resolve => unix ? server.listen(socketPath, resolve) : server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { server, seen, socketPath, unix };
}

function call(f: { server: Server; socketPath: string; unix: boolean }, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const request = httpRequest({
      ...(f.unix ? { socketPath: f.socketPath } : { hostname: "127.0.0.1", port: (f.server.address() as AddressInfo).port }),
      path, method: body === undefined ? "GET" : "POST", headers: { host: "admin.example.test", ...headers },
    }, response => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, text }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("private portal HTTP boundary", () => {
  it("rejects wrong hosts and strips a TCP caller's claimed proxy identity", async () => {
    const f = await fixture();
    expect((await call(f, "/api/health", { host: "tenant.example.test" })).status).toBe(403);
    expect(f.seen).toHaveLength(0);
    const result = await call(f, "/api/health", { "x-omb-client-ip": "198.51.100.4" });
    expect(result.status).toBe(200);
    expect(f.seen[0].headers.get("x-omb-client-ip")).toBe("127.0.0.1");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it.skipIf(process.platform === "win32")("accepts only a valid address from the adjacent private Unix proxy", async () => {
    const f = await fixture(true);
    await call(f, "/api/health", { "x-omb-client-ip": "198.51.100.4" });
    await call(f, "/api/health", { "x-omb-client-ip": "198.51.100.4, 127.0.0.1" });
    expect(f.seen[0].headers.get("x-omb-client-ip")).toBe("198.51.100.4");
    expect(f.seen[1].headers.get("x-omb-client-ip")).toBeNull();
  });

  it("serves the built shell without allowing directory escape or oversized API bodies", async () => {
    const f = await fixture();
    expect((await call(f, "/workspaces")).text).toContain("Disposable portal");
    expect((await call(f, "/%2e%2e%2foutside")).status).toBe(404);
    expect((await call(f, "/api/anything", {}, "a".repeat(8 * 1024 * 1024 + 1))).status).toBe(413);
    expect(f.seen).toHaveLength(0);
  });
});
