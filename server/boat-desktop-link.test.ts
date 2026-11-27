// The person waits on a desktop link while the bot waits on the person, so a Boat that never answers must not hold either.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const botId = "desktop-link-test";
const boxId = "bx_23456789";
const machineName = `ogb-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;
const asked: string[] = [];
let api: Server;
let boat: typeof import("./boat.ts");

beforeAll(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://boat.test");
    req.resume();
    asked.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v1/sandboxes") return send({ ok: true, sandboxes: [{ id: boxId, name: machineName, state: "ready" }] });
    if (url.pathname === `/api/v1/sandboxes/${boxId}`) return send({ ok: true, sandbox: { id: boxId, name: machineName, state: "ready" } });
    // The desktop link never comes: neither the VNC path nor the fallback answers.
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v1`);
  boat = await import("./boat.ts");
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  vi.unstubAllEnvs();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

it("gives up on a desktop link the provider never sends, so the bot is not left waiting", async () => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const bounds: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    bounds.push(ms);
    return realTimeout(ms === 30_000 ? 50 : ms);
  });
  const started = Date.now();
  await expect(boat.joinReadyBoat({ box: { token: "box_own" } }, botId)).rejects.toThrow(/time|abort/i);
  expect(Date.now() - started, "the join returned instead of hanging").toBeLessThan(5_000);
  expect(bounds, "each desktop-link request is bounded").toContain(30_000);
  expect(asked).toContain(`POST /api/v1/sandboxes/${boxId}/desktop?vnc=1`);
}, 10_000);
