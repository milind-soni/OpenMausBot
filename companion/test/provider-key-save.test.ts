// Inside the desktop app a phone's key goes to the desktop's own save (encrypted store first), never straight to the
// harness; the standalone companion has no such save and forwards it. On the plain LAN listener a key must arrive
// inside an encrypted session.
import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createE2EOrigin } from "../src/e2e/origin.ts";
import { createProxyHandler, type ProxyListener, type ProxyOptions } from "../src/proxy.ts";

const TOKEN = "omb_test_token";
const servers: Server[] = [];

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function companion(saveProviderKey?: ProxyOptions["saveProviderKey"], listener: ProxyListener = "origin") {
  const harness: Array<{ method: string; url: string; body: string }> = [];
  const harnessPort = await listen(createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      harness.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ from: "harness" }));
    });
  }));
  const proxy = createProxyHandler({
    harnessPort,
    authenticate: (token) => (token === TOKEN ? { id: "phone-1", cloudDesktopAccess: false, browserControlAccess: false } : null),
    redeem: () => ({ error: "not used here", code: "pairing_code_wrong" }),
    serverName: () => "Test computer",
    saveProviderKey,
  });
  const port = await listen(createServer((req, res) => proxy(req, res, listener)));
  const send = async (method: string, path: string, body: string, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body || undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const put = (body: string, token = TOKEN) => send("PUT", "/api/config?secretStorage=external", body, token);
  // The same handler, reached through an encrypted session the way index.ts wires it.
  const e2eOrigin = createE2EOrigin((req, res) => proxy(req, res), (req, socket, head) => proxy.upgrade(req, socket, head));
  const sendE2E = async (method: string, path: string, body: string) => {
    const stream = await e2eOrigin.connect({ peer: { kind: "device", id: "phone-1" }, route: "wifi" });
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request({
        method, path, createConnection: () => stream,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          stream.destroy();
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  return { harness, put, send, sendE2E, closeE2E: () => e2eOrigin.close() };
}

describe("a phone's PUT /api/config", () => {
  it("goes to the desktop's save and never to the harness when the desktop supplies one", async () => {
    const patches: unknown[] = [];
    const { harness, put } = await companion(async (patch) => {
      patches.push(patch);
      return { status: 200, body: { mistral: { configured: true } } };
    });
    expect(await put(JSON.stringify({ mistral: { key: "k1" } }))).toEqual({ status: 200, body: { mistral: { configured: true } } });
    expect(patches).toEqual([{ mistral: { key: "k1" } }]);

    expect((await put("{", TOKEN)).status).toBe(400);
    // Past the bound the reader drops the connection, whether or not its 400 got out first.
    await put(JSON.stringify({ mistral: { key: "k".repeat(9000) } })).catch(() => {});
    expect((await put(JSON.stringify({ mistral: { key: "k2" } }), "not-paired")).status).toBe(401);
    expect(patches).toHaveLength(1);
    expect(harness).toEqual([]);
  });

  it("passes the desktop's refusal through", async () => {
    const { put } = await companion(async () => ({ status: 403, body: { error: "only keys" } }));
    expect(await put(JSON.stringify({ signIn: {} }))).toEqual({ status: 403, body: { error: "only keys" } });
  });

  it("is forwarded as before by the standalone companion, which has no desktop save", async () => {
    const { harness, put } = await companion();
    expect(await put(JSON.stringify({ mistral: { key: "k1" } }))).toEqual({ status: 200, body: { from: "harness" } });
    expect(harness).toEqual([{ method: "PUT", url: "/api/config?secretStorage=external", body: JSON.stringify({ mistral: { key: "k1" } }) }]);
  });
});

describe("a provider key on the plain LAN listener", () => {
  const key = JSON.stringify({ mistral: { key: "k1" } });

  it("is refused outside an encrypted session, and reaches neither the desktop's save nor the harness", async () => {
    const patches: unknown[] = [];
    const { harness, send, closeE2E } = await companion(async (patch) => {
      patches.push(patch);
      return { status: 200, body: { mistral: { configured: true } } };
    }, "lan");
    for (const [method, path] of [["PUT", "/api/config"], ["PUT", "/api/config?secretStorage=external"], ["POST", "/api/keys/test"]]) {
      const reply = await send(method, path, key);
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(JSON.stringify(reply.body)).not.toContain("k1");
    }
    expect(patches).toEqual([]);
    expect(harness).toEqual([]);
    // Unpaired is still unpaired.
    expect((await send("PUT", "/api/config", key, "not-paired")).status).toBe(401);
    // Everything else on the plain listener is untouched.
    expect((await send("GET", "/api/config", "")).status).toBe(200);
    closeE2E();
  });

  it("is refused by the standalone companion too, which would forward it", async () => {
    const { harness, send, closeE2E } = await companion(undefined, "lan");
    expect((await send("PUT", "/api/config", key)).status).toBe(403);
    expect((await send("POST", "/api/keys/test", key)).status).toBe(403);
    expect(harness).toEqual([]);
    closeE2E();
  });

  it("is accepted inside an encrypted session", async () => {
    const patches: unknown[] = [];
    const { harness, sendE2E, closeE2E } = await companion(async (patch) => {
      patches.push(patch);
      return { status: 200, body: { mistral: { configured: true } } };
    }, "lan");
    expect(await sendE2E("PUT", "/api/config", key)).toEqual({ status: 200, body: { mistral: { configured: true } } });
    expect(patches).toEqual([{ mistral: { key: "k1" } }]);
    expect((await sendE2E("POST", "/api/keys/test", key)).status).toBe(200);
    expect(harness).toEqual([{ method: "POST", url: "/api/keys/test", body: key }]);
    closeE2E();
  });
});
