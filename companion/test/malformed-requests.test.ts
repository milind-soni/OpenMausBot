import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";

const servers: Server[] = [];
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  return address.port;
}
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const rawStatus = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const sent = request({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on("error", reject);
    sent.end();
  });

const sidecar = async (redeemed: unknown[] = []) => {
  const proxy = createProxyHandler({
    harnessPort: 9,
    authenticate: (token) => token === "paired" ? { id: "phone", cloudDesktopAccess: true, browserControlAccess: false } : null,
    redeem: (code, deviceName) => {
      redeemed.push([code, deviceName]);
      return { error: "that pairing credential is not right" };
    },
    serverName: () => "Fixture",
  });
  const server = createServer(proxy);
  server.on("upgrade", proxy.upgrade);
  return listen(server);
};

it("answers a request target that is not a URL with 400, paired or not", async () => {
  const port = await sidecar();
  expect(await rawStatus(port, "//[")).toBe(400);
  expect(await rawStatus(port, "//[", { authorization: "Bearer paired" })).toBe(400);
  expect(await rawStatus(port, "/vps-viewer/abcdefghijklmnopqrstuvwxyz012345//[", { authorization: "Bearer paired" })).toBe(404);
  expect((await fetch(`http://127.0.0.1:${port}/api/companion/endpoints`, { headers: { authorization: "Bearer paired" } })).status).toBe(200);
});

it("refuses a WebSocket upgrade to a target that is not a URL", async () => {
  const port = await sidecar();
  const client = createConnection({ host: "127.0.0.1", port });
  let response = "";
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    response += chunk;
  });
  client.once("connect", () => client.write(
    "GET //[ HTTP/1.1\r\n"
      + `Host: 127.0.0.1:${port}\r\n`
      + "Authorization: Bearer paired\r\n"
      + "Connection: Upgrade\r\n"
      + "Upgrade: websocket\r\n"
      + "Sec-WebSocket-Key: dGVzdA==\r\n"
      + "Sec-WebSocket-Version: 13\r\n\r\n",
  ));
  await once(client, "close");
  expect(response).toMatch(/^HTTP\/1\.1 404 /);
});

it("refuses pairing credentials and device names that are not plain values", async () => {
  const redeemed: unknown[] = [];
  const port = await sidecar(redeemed);
  const pair = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
  };
  expect(await pair({ code: { toString: 0 } })).toBe(400);
  expect(await pair({ credential: ["123456"] })).toBe(400);
  expect(await pair({ code: "123456", deviceName: { toString: 0 } })).toBe(400);
  expect(redeemed).toEqual([]);
  expect(await pair({ code: "123456", deviceName: "Phone" })).toBe(401);
  expect(await pair({ code: 123456 })).toBe(401);
  expect(redeemed).toEqual([["123456", "Phone"], ["123456", undefined]]);
});

it("answers 500 and logs the cause when pairing itself fails", async () => {
  const proxy = createProxyHandler({
    harnessPort: 9,
    authenticate: () => null,
    redeem: () => {
      throw new Error("registry broke");
    },
    serverName: () => "Fixture",
  });
  const port = await listen(createServer(proxy));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith("companion: pairing failed", expect.objectContaining({ message: "registry broke" }));
  } finally {
    logged.mockRestore();
  }
});
