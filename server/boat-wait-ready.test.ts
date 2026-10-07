// Waiting for a cloud computer to be ready ends inside its budget, even when
// the relay accepts a request and then never answers it. Before each poll had
// a deadline, one stalled read held the turn's start until the 20-minute
// watchdog.
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("waiting for a cloud computer", () => {
  const botId = "stalled-relay-bot";
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = `ogb-${prefix}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;
  const held: ServerResponse[] = [];
  let stall: "read" | "resume" = "read";
  let api: Server;
  let boat: typeof import("./boat.ts");

  beforeAll(async () => {
    api = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://boat.test").pathname;
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (path === "/api/box/v1/boxes") {
          res.end(JSON.stringify({ ok: true, boxes: [{ id: "bx_23456789", name, state: "archived" }] }));
        } else if (path === "/api/box/v1/boxes/bx_23456789" && stall === "resume") {
          res.end(JSON.stringify({ ok: true, box: { id: "bx_23456789", name, state: "archived" } }));
        } else {
          // Accepted, never answered: a relay that stalls.
          held.push(res);
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${(api.address() as { port: number }).port}/api/box/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
    vi.resetModules();
    boat = await import("./boat.ts");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const res of held) res.destroy();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it.each(["read", "resume"] as const)("gives up inside its budget when a %s stalls", async (where) => {
    stall = where;
    const started = Date.now();
    await expect(boat.readyBoat({ box: { token: "box_test" } } as never, botId, 600)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
