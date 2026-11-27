import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

import { listenHost } from "./lan-address.ts";
import { createTailnetShare } from "./tailnet-listener.ts";

const NAME = "laptop.tail1234.ts.net";
const servers: Server[] = [];
let share: ReturnType<typeof createTailnetShare> | null = null;
const handle = async (_req: unknown, res: { end: (body: string) => void }) => { res.end("handled"); };
const interfaces = () => ({ lo: [{ address: "127.0.0.1", family: "IPv4" as const, internal: true, netmask: "255.0.0.0", mac: "", cidr: "127.0.0.1/8" }] });

async function listen(lan = true): Promise<Server> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost(server, lan ? { OMB_LAN: "1" } : {}), resolve);
  });
  return server;
}

function ask(port: number, host: string, address = "127.0.0.1"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request({ host: address, port, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    call.on("error", reject);
    call.end();
  });
}

afterEach(async () => {
  await share?.close();
  share = null;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

it("shares the live LAN listener without repeatedly binding the same IPv4 address", async () => {
  const main = await listen();
  const port = (main.address() as AddressInfo).port;
  const attached: Server[] = [];
  const logs: string[] = [];
  share = createTailnetShare({ port, primaryAddress: () => main.address(), interfaces, handle, attach: (server) => attached.push(server), log: (line) => logs.push(line) });
  const config = { name: NAME, addresses: ["127.0.0.1"] };
  await share.apply(config);
  expect(share.origin()).toBeNull();
  await share.start();
  expect(share.state()).toEqual({ origin: `http://${NAME}:${port}`, listening: ["127.0.0.1"], error: null });
  expect(await ask(port, `${NAME}:${port}`)).toEqual({ status: 200, body: "handled" });
  await share.apply(config);
  expect(attached).toHaveLength(0);
  expect(logs.join("\n")).not.toContain("EADDRINUSE");

  await share.apply(null);
  expect(share.state()).toEqual({ origin: null, listening: [], error: null });
  expect((await ask(port, "localhost")).body).toBe("handled");
  await share.apply(config);
  await share.close();
  expect(share.origin()).toBeNull();
  expect((await ask(port, "localhost")).body).toBe("handled");
});

it("still binds IPv6 separately and accepts the shared IPv4 address as a tailnet Host", async () => {
  const main = await listen();
  const port = (main.address() as AddressInfo).port;
  const attached: Server[] = [];
  share = createTailnetShare({ port, primaryAddress: () => main.address(), interfaces, handle, attach: (server) => attached.push(server) });
  await share.start();
  await share.apply({ name: NAME, addresses: ["127.0.0.1", "::1"] });
  expect(share.state()).toEqual({ origin: `http://${NAME}:${port}`, listening: ["127.0.0.1", "::1"], error: null });
  expect(attached).toHaveLength(1);
  expect(await ask(port, `127.0.0.1:${port}`, "::1")).toEqual({ status: 200, body: "handled" });
  expect((await ask(port, `evil.example.com:${port}`, "::1")).status).toBe(421);
});

it("reports a port occupied by another listener instead of borrowing a primary on a different port", async () => {
  const other = await listen();
  const main = await listen();
  const port = (other.address() as AddressInfo).port;
  share = createTailnetShare({ port, primaryAddress: () => main.address(), interfaces, handle, attach: () => {} });
  await share.start();
  await share.apply({ name: NAME, addresses: ["127.0.0.1"] });
  expect(share.origin()).toBeNull();
  expect(share.state().listening).toEqual([]);
  expect(share.state().error).toContain("127.0.0.1: EADDRINUSE");
});

it("does not advertise an address absent from the machine just because the primary is a wildcard", async () => {
  const main = await listen();
  const port = (main.address() as AddressInfo).port;
  share = createTailnetShare({ port, primaryAddress: () => main.address(), interfaces, handle, attach: () => {} });
  await share.start();
  await share.apply({ name: NAME, addresses: ["192.0.2.123"] });
  expect(share.origin()).toBeNull();
  expect(share.state().listening).toEqual([]);
  expect(share.state().error).toContain("192.0.2.123:");
});
