import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProxyFetch, resolveProxyUrl } from "./antigravity-proxy.ts";
import { antigravityAccount } from "./antigravity-account.ts";
import { clearPlanUsageCache, loadPlanUsage, type PlanAccount } from "../plan-usage.ts";
import { clearAntigravityUsageAccess } from "./antigravity-usage-limits.ts";
import { antigravityTokenPath } from "./antigravity-acp.ts";

let home: string;
const servers: Array<ReturnType<typeof createServer>> = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "omb-proxy-test-"));
  clearPlanUsageCache();
  clearAntigravityUsageAccess();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearPlanUsageCache();
  clearAntigravityUsageAccess();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(home, { recursive: true, force: true });
});

function startHttpProxy(status = 502) {
  const seenTargets: string[] = [];
  const server = createServer((req, res) => {
    seenTargets.push(req.url ?? "");
    res.writeHead(status);
    res.end();
  });
  server.on("connect", (req, socket) => {
    seenTargets.push(req.url ?? "");
    socket.write(`HTTP/1.1 ${status} Proxy Intercepted\r\n\r\n`);
    socket.destroy();
  });
  servers.push(server);
  return new Promise<{ url: string; seenTargets: string[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, seenTargets });
    });
  });
}

it("resolves proxy URLs and honors NO_PROXY rules", () => {
  expect(resolveProxyUrl({ HTTPS_PROXY: "http://127.0.0.1:30064" }, "https://oauth2.googleapis.com/token"))
    .toBe("http://127.0.0.1:30064");
  expect(resolveProxyUrl({ HTTPS_PROXY: "http://127.0.0.1:30064", NO_PROXY: "localhost,.googleapis.com" }, "https://oauth2.googleapis.com/token"))
    .toBeUndefined();
  expect(() => resolveProxyUrl({ HTTPS_PROXY: "socks5://127.0.0.1:1080" }, "https://oauth2.googleapis.com/token"))
    .toThrow(/Unsupported proxy protocol/);
});

it("routes antigravityAccount requests through the configured CONNECT proxy and isolates identity cache by proxy", async () => {
  const proxy = await startHttpProxy();
  const tokenPath = join(home, "acp_token.json");
  await writeFile(tokenPath, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }));

  const globalFetch = vi.fn().mockImplementation(async (url: string) => Response.json(
    url.endsWith("/token") ? { access_token: "direct-access" } : { email: "direct@example.test" },
  ));
  vi.stubGlobal("fetch", globalFetch);

  // Without proxy: hits globalThis.fetch
  expect(await antigravityAccount(tokenPath)).toEqual({ email: "direct@example.test", method: "login" });
  expect(globalFetch).toHaveBeenCalledTimes(2);

  // With proxy: must intercept via CONNECT on the proxy server, never hitting globalThis.fetch
  const proxied = await antigravityAccount(tokenPath, { environment: { HTTPS_PROXY: proxy.url } });
  expect(proxied).toBeUndefined();
  expect(proxy.seenTargets).toContain("oauth2.googleapis.com:443");
  expect(globalFetch).toHaveBeenCalledTimes(2);
});

it("routes loadPlanUsage antigravity requests through each account's own proxy without leaking to globalThis.fetch", async () => {
  const proxyA = await startHttpProxy();
  const proxyB = await startHttpProxy();
  const idA = "antigravity-proxy-a-test";
  const idB = "antigravity-proxy-b-test";
  const pathA = antigravityTokenPath(idA);
  const pathB = antigravityTokenPath(idB);
  const fs = await import("node:fs");
  fs.mkdirSync(join(pathA, ".."), { recursive: true });
  fs.mkdirSync(join(pathB, ".."), { recursive: true });
  fs.writeFileSync(pathA, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "ra" }));
  fs.writeFileSync(pathB, JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "rb" }));

  try {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);

    const accounts: PlanAccount[] = [
      { id: idA, name: "A", driver: "antigravity", environment: { HTTPS_PROXY: proxyA.url } },
      { id: idB, name: "B", driver: "antigravity", environment: { HTTPS_PROXY: proxyB.url } },
    ];
    await loadPlanUsage({ accounts, refresh: true, timeoutMs: 2_000 });
    expect(proxyA.seenTargets).toContain("oauth2.googleapis.com:443");
    expect(proxyB.seenTargets).toContain("oauth2.googleapis.com:443");
    expect(globalFetch).not.toHaveBeenCalled();
  } finally {
    await rm(join(pathA, "..", ".."), { recursive: true, force: true });
    await rm(join(pathB, "..", ".."), { recursive: true, force: true });
  }
});

it("falls back to globalThis.fetch dynamically when no proxy is configured", async () => {
  const fn = createProxyFetch({});
  const stub = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", stub);
  const res = await fn("https://example.invalid/ping", { method: "GET" });
  expect(res.status).toBe(200);
  expect(stub).toHaveBeenCalledTimes(1);
});
