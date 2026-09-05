import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
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

it("adds the private capability only after authenticating and authorizing, never from client headers", async () => {
  const received: IncomingHttpHeaders[] = [];
  const harnessPort = await listen(createServer((req, res) => {
    received.push(req.headers);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }));
  let capability: string | null = null;
  const port = await listen(createServer(createProxyHandler({
    harnessPort, mutationToken: () => capability,
    authenticate: (token) => token === "paired" ? { id: "real-phone", cloudDesktopAccess: false } : null,
    redeem: () => ({ error: "not pairing" }), serverName: () => "Fixture",
  })));
  const call = async (path: string, token = "paired", method = "POST") => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: {
      authorization: `Bearer ${token}`,
      "x-openmausbot-companion-auth": "forged",
      "x-openmausbot-desktop-owner": "forged-owner",
      "x-openmausbot-companion-device": "forged-phone",
    } });
    await res.text();
    return res.status;
  };
  expect(await call("/api/bots/b/read")).toBe(503);
  expect(received).toHaveLength(0);
  capability = "private-relay-secret";
  expect(await call("/api/bots/b/read", "unpaired")).toBe(401);
  expect(await call("/api/config", "paired", "PUT")).toBe(403);
  expect(await call("/api/bots/b/computer/join")).toBe(403);
  expect(received).toHaveLength(0);
  expect(await call("/api/bots/b/read")).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]["x-openmausbot-companion-auth"]).toBe(capability);
  expect(received[0]["x-openmausbot-companion-device"]).toBe("real-phone");
  expect(received[0]["x-openmausbot-desktop-owner"]).toBeUndefined();
  expect(received[0].authorization).toBeUndefined();
  await call("/api/health", "unpaired", "GET");
  expect(received[1]["x-openmausbot-companion-auth"]).toBeUndefined();
});
