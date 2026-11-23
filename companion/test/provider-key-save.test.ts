// Inside the desktop app a phone's key goes to the desktop's own save (encrypted store first), never straight to the
// harness; the standalone companion has no such save and forwards it.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createProxyHandler, type ProxyOptions } from "../src/proxy.ts";

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

async function companion(saveProviderKey?: ProxyOptions["saveProviderKey"]) {
  const harness: Array<{ method: string; url: string; body: string }> = [];
  const harnessPort = await listen(createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      harness.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ from: "harness" }));
    });
  }));
  const port = await listen(createServer(createProxyHandler({
    harnessPort,
    authenticate: (token) => (token === TOKEN ? { id: "phone-1", cloudDesktopAccess: false, browserControlAccess: false } : null),
    redeem: () => ({ error: "not used here", code: "pairing_code_wrong" }),
    serverName: () => "Test computer",
    saveProviderKey,
  })));
  const put = async (body: string, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config?secretStorage=external`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
    });
    return { status: res.status, body: await res.json() };
  };
  return { harness, put };
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
