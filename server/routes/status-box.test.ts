// The MausBot connector on a server its owner runs reads whether the bot box is on from the server's own health answer.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createStatusRoutes, type StatusRouteDeps } from "./status.ts";
import { dispatchRoutes } from "./table.ts";

async function health(boxOn?: () => boolean, eventLogDrops?: () => { events: number; bytes: number }): Promise<Record<string, unknown>> {
  const routes = [createStatusRoutes({ staticDir: null, sharedWorkspaceFullAccessEnabled: () => false, ...(boxOn ? { boxOn } : {}), ...(eventLogDrops ? { eventLogDrops } : {}) } as unknown as StatusRouteDeps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["client"], trust: "service" }, json, readBody });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    return await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`)).json() as Record<string, unknown>;
  } finally {
    server.close();
  }
}

describe("the health answer behind the gate", () => {
  it("says whether the bot box is on, on or off and nothing more", async () => {
    expect((await health(() => true)).box).toBe("on");
    expect((await health(() => false)).box).toBe("off");
    expect(await health()).not.toHaveProperty("box");
  });

  it("reports how much of the canonical event log the bus dropped", async () => {
    expect(await health(undefined, () => ({ events: 7, bytes: 2048 }))).toMatchObject({ eventLogDrops: { events: 7, bytes: 2048 } });
    expect(await health()).not.toHaveProperty("eventLogDrops");
  });
});
