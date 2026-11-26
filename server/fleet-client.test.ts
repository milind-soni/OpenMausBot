import { createServer, type IncomingMessage, type RequestListener, type RequestOptions, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fleetRequest } from "./fleet-client.ts";

const servers: Server[] = [];

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    request: (options: RequestOptions, listener: (res: IncomingMessage) => void) => actual.request({
      ...options, socketPath: undefined, hostname: "127.0.0.1", port: Number(options.socketPath),
    }, listener),
  };
});

async function fixture(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return String((server.address() as AddressInfo).port);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("fleet HTTP responses", () => {
  it("rejects a response cut off after its headers instead of waiting forever", async () => {
    const socket = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": 1000 });
      res.write('{"workspaces":', () => res.destroy());
    });
    await expect(fleetRequest(socket, "GET", "/workspaces", undefined, 50))
      .rejects.toThrow(/fleet agent:/);
  }, 2_000);

  it("returns complete JSON replies with their status", async () => {
    const socket = await fixture((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "工程" }));
    });
    await expect(fleetRequest(socket, "POST", "/workspaces", { name: "工程" }))
      .resolves.toEqual({ status: 201, body: { name: "工程" } });
  });

  it("retains the diagnostic for a complete non-JSON reply", async () => {
    const socket = await fixture((_req, res) => res.end("not JSON"));
    await expect(fleetRequest(socket, "GET", "/workspaces"))
      .resolves.toEqual({ status: 200, body: { error: "the fleet agent answered something that was not JSON" } });
  });
});
