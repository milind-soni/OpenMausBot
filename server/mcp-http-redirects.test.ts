import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainHttpProxyFetch, RemoteMcpClient } from "./mcp-http.ts";

interface Seen { url: string; method: string; body: string; headers: IncomingMessage["headers"] }
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function proxy(respond: (seen: Seen, res: ServerResponse) => void, fallback?: typeof fetch) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const seen = { url: req.url!, method: req.method!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(seen);
      respond(seen, res);
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return { requests, fetch: plainHttpProxyFetch({ HTTP_PROXY: `http://proxy-user:proxy-password@127.0.0.1:${address.port}` }, fallback)! };
}
const start = "http://mcp.example.test/start";
const redirected = (status: number, location: string, res: ServerResponse) => { res.writeHead(status, { location }); res.end("redirect"); };

describe("MCP plain HTTP proxy redirects", () => {
  for (const status of [307, 308]) {
    it(`preserves the MCP POST through a same-origin ${status}`, async () => {
      const p = await proxy((seen, res) => seen.url === start ? redirected(status, "/rpc", res) : res.end("ok"));
      const response = await p.fetch(start, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: '{"method":"initialize"}' });
      expect(await response.text()).toBe("ok");
      expect(p.requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
        { url: start, method: "POST", body: '{"method":"initialize"}' },
        { url: "http://mcp.example.test/rpc", method: "POST", body: '{"method":"initialize"}' },
      ]);
      expect(p.requests[1]!.headers.authorization).toBe("Bearer fixture");
    });
  }

  for (const status of [301, 302, 303]) {
    it(`changes a POST to GET and drops body headers for ${status}`, async () => {
      const p = await proxy((seen, res) => seen.url === start ? redirected(status, "/get", res) : res.end("ok"));
      await (await p.fetch(start, { method: "POST", body: "payload", headers: { "content-type": "text/plain", "content-language": "en", "content-encoding": "identity", "content-location": "/payload", "content-length": "7" } })).text();
      expect(p.requests).toHaveLength(2);
      expect(p.requests[1]).toMatchObject({ method: "GET", body: "" });
      for (const name of ["content-type", "content-language", "content-encoding", "content-location", "content-length"]) expect(p.requests[1]!.headers[name]).toBeUndefined();
    });
  }

  it("does not forward origin credentials to a different host", async () => {
    const p = await proxy((seen, res) => seen.url === start ? redirected(307, "http://other.example.test/rpc", res) : res.end("ok"));
    await (await p.fetch(start, { method: "POST", body: "payload", headers: { authorization: "Bearer private", cookie: "session=private", host: "mcp.example.test", "proxy-authorization": "Basic caller-private" } })).text();
    expect(p.requests).toHaveLength(2);
    expect(p.requests[1]!.headers.authorization).toBeUndefined();
    expect(p.requests[1]!.headers.cookie).toBeUndefined();
    expect(p.requests[1]!.headers.host).toBe("other.example.test");
    expect(p.requests[1]!.headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`);
  });

  it("passes an HTTPS redirect to the ordinary fetch transport with safe headers", async () => {
    const fallback = vi.fn<typeof fetch>().mockResolvedValue(new Response("secure"));
    const p = await proxy((_seen, res) => redirected(307, "https://secure.example.test/rpc", res), fallback);
    const response = await p.fetch(start, { method: "POST", body: "request", headers: { authorization: "Bearer private", cookie: "session=private" } });
    expect(await response.text()).toBe("secure");
    expect(fallback).toHaveBeenCalledOnce();
    const [url, init] = fallback.mock.calls[0]!;
    expect(String(url)).toBe("https://secure.example.test/rpc");
    expect(init).toMatchObject({ method: "POST", body: "request", redirect: "manual" });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    expect(new Headers(init?.headers).has("proxy-authorization")).toBe(false);
  });

  it("returns manual redirects without following them", async () => {
    const p = await proxy((_seen, res) => redirected(307, "/rpc", res));
    const response = await p.fetch(start, { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(await response.text()).toBe("redirect");
    expect(p.requests).toHaveLength(1);
  });

  it("rejects redirect:error without following the location", async () => {
    const p = await proxy((_seen, res) => redirected(307, "/rpc", res));
    await expect(p.fetch(start, { redirect: "error" })).rejects.toThrow(/redirect/i);
    expect(p.requests).toHaveLength(1);
  });

  it("bounds redirect loops", async () => {
    const p = await proxy((_seen, res) => redirected(307, "/again", res));
    await expect(p.fetch(start)).rejects.toThrow(/redirect/i);
    expect(p.requests).toHaveLength(21);
  });

  it("rejects non-HTTP and credential-bearing redirect targets", async () => {
    for (const location of ["file:///tmp/fixture", "http://user:password@other.example.test/rpc"]) {
      const fallback = vi.fn<typeof fetch>();
      const p = await proxy((_seen, res) => redirected(307, location, res), fallback);
      await expect(p.fetch(start)).rejects.toThrow(/redirect/i);
      expect(p.requests).toHaveLength(1);
      expect(fallback).not.toHaveBeenCalled();
    }
  });

  it("initializes and calls a real MCP endpoint behind a redirecting proxy", async () => {
    const p = await proxy((seen, res) => {
      if (seen.url === start) return redirected(307, "/rpc", res);
      const frame = JSON.parse(seen.body) as { id?: number; method: string };
      if (frame.id === undefined) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: frame.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { tools: [] } }));
    });
    const client = new RemoteMcpClient({ type: "http", url: start, headers: {} }, { fetch: p.fetch });
    try {
      await expect(client.initialize("fixture", AbortSignal.timeout(5000))).resolves.toMatchObject({ protocolVersion: "2025-06-18" });
      await expect(client.request("tools/list", {}, AbortSignal.timeout(5000))).resolves.toEqual({ tools: [] });
    } finally { await client.close(); }
    expect(p.requests).toHaveLength(6);
  });
});
