import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EGRESS_REFUSED, egressTarget, startEgressGuard, type EgressGuard, type EgressGuardOptions } from "./browser-egress-guard.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

/** A web server on this machine: the founder desk, another workspace, or (when
 * a test allows it) a stand-in for a public site. */
async function site(name: string): Promise<number> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${name} ${req.method} ${req.url} host=${req.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

async function guard(options: EgressGuardOptions = {}): Promise<EgressGuard> {
  const started = await startEgressGuard(options);
  closers.push(() => started.close());
  return started;
}

/** A plain http request in proxy (absolute) form, as Chrome sends one. */
function viaProxy(g: EgressGuard, target: string, path = target): Promise<{ status: number; body: string }> {
  const proxy = new URL(g.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: "GET", path, headers: { host: new URL(target).host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** CONNECT host:port, then (when allowed) one HTTP/1.0 request through the tunnel. */
function tunnel(g: EgressGuard, authority: string): Promise<{ status: number; body: string }> {
  const proxy = new URL(g.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let data = "";
    let status = 0;
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (!status && data.includes("\r\n\r\n")) {
        status = Number(data.split(" ")[1]);
        data = data.slice(data.indexOf("\r\n\r\n") + 4);
        if (status === 200) socket.write(`GET /inside HTTP/1.0\r\nHost: ${authority}\r\n\r\n`);
      }
    });
    socket.on("close", () => resolve({ status, body: data }));
    socket.on("error", reject);
  });
}

describe("the member browser's egress guard", () => {
  it("never reaches this machine's own servers, whatever they are called", async () => {
    const desk = await site("desk");
    const g = await guard();
    for (const target of [`http://127.0.0.1:${desk}/api/config`, `http://localhost:${desk}/`, `http://[::1]:${desk}/`, `http://127.1.2.3:${desk}/`,
      // IPv6 spellings of 127.0.0.1; a browser writes a mapped address in hex
      `http://[::ffff:127.0.0.1]:${desk}/`, `http://[::ffff:7f00:1]:${desk}/`, `http://[0:0:0:0:0:ffff:7f00:1]:${desk}/`]) {
      const answer = await viaProxy(g, target);
      expect(answer.status, target).toBe(403);
      expect(answer.body).toBe(EGRESS_REFUSED);
    }
    for (const authority of [`127.0.0.1:${desk}`, `localhost:${desk}`, `[::1]:${desk}`, `[::ffff:7f00:1]:${desk}`, `[::ffff:0:7f00:1]:${desk}`]) {
      const answer = await tunnel(g, authority);
      expect(answer.status, authority).toBe(403);
      expect(answer.body).not.toContain("desk");
    }
  });

  it("refuses private networks and cloud metadata before connecting", async () => {
    const g = await guard();
    for (const target of ["http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://172.16.0.9/", "http://100.64.0.1/", "http://[fd00::1]/", "http://[fe80::1]/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/", "http://[2002:a9fe:a9fe::1]/"]) {
      expect((await viaProxy(g, target)).status, target).toBe(403);
    }
    for (const authority of ["10.0.0.1:443", "169.254.169.254:80", "[fc00::1]:443", "0.0.0.0:443", "[::ffff:a9fe:a9fe]:80", "[::127.0.0.1]:443"]) {
      expect((await tunnel(g, authority)).status, authority).toBe(403);
    }
  });

  it("refuses a name when any of its addresses is private, since a resolver may answer either", async () => {
    const g = await guard({ lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
    expect((await viaProxy(g, "http://mixed.example/")).status).toBe(403);
    expect((await tunnel(g, "mixed.example:443")).status).toBe(403);
  });

  it("forwards to the one address it checked, over plain http and through tunnels", async () => {
    const port = await site("public");
    const lookups: string[] = [];
    const g = await guard({
      lookup: async (host) => { lookups.push(host); return [{ address: "127.0.0.1", family: 4 }]; },
      allow: new Set([`public.example:${port}`]),
    });
    const page = await viaProxy(g, `http://public.example:${port}/page?x=1`);
    expect(page).toEqual({ status: 200, body: `public GET /page?x=1 host=public.example:${port}` });
    const tunnelled = await tunnel(g, `public.example:${port}`);
    expect(tunnelled.status).toBe(200);
    expect(tunnelled.body).toContain("public GET /inside");
    // one resolution per request, and the connection went where it pointed
    expect(lookups).toEqual(["public.example", "public.example"]);
    // the allowance is for that exact host and port only
    expect((await viaProxy(g, `http://public.example:${port + 1}/`)).status).toBe(403);
    expect((await viaProxy(g, `http://127.0.0.1:${port}/`)).status).toBe(403);
  });

  it("answers only proxy requests", async () => {
    const g = await guard();
    expect((await viaProxy(g, "http://example.com/", "/not-a-proxy-request")).status).toBe(400);
    expect((await viaProxy(g, "http://example.com/", "ftp://example.com/file")).status).toBe(400);
  });
});

describe("egress rules", () => {
  it("keep literal public addresses and refuse bad ports", async () => {
    expect(await egressTarget("93.184.216.34", 443)).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await egressTarget("93.184.216.34", 0)).toBeNull();
    expect(await egressTarget("93.184.216.34", 70_000)).toBeNull();
    expect(await egressTarget("no-such-host.invalid", 443, { lookup: async () => { throw new Error("ENOTFOUND"); } })).toBeNull();
    expect(await egressTarget("empty.example", 443, { lookup: async () => [] })).toBeNull();
  });
});
