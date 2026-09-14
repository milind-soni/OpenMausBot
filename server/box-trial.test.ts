import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("Box trial provisioning", () => {
  let api: Server;
  let provisionBox: typeof import("./box.ts").provisionBox;
  const createBodies: Array<{ ttlSeconds: number; noEnv: boolean }> = [];
  const createKeys: string[] = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, boxes: [] }));
        }
        if (url.pathname === "/api/box/v1/boxes" && req.method === "POST") {
          const body = JSON.parse(raw);
          createBodies.push(body);
          createKeys.push(String(req.headers["idempotency-key"] ?? ""));
          if (createBodies.length === 1) {
            res.writeHead(400);
            return res.end(JSON.stringify({
              ok: false,
              error: { code: "trial_auto_stop_required", details: { maxTtlSeconds: 7200 } },
            }));
          }
          res.writeHead(201);
          return res.end(JSON.stringify({ ok: true, box: { id: "bx_23456789", state: "ready" } }));
        }
        if (url.pathname === "/api/box/v1/boxes/bx_23456789" && req.method === "PATCH") {
          return res.end(JSON.stringify({ ok: true }));
        }
        if (url.pathname === "/api/box/v1/boxes/bx_23456789" && req.method === "GET") {
          return res.end(JSON.stringify({ ok: true, box: { id: "bx_23456789", state: "ready" } }));
        }
        if (url.pathname.endsWith("/commands")) {
          return res.end(JSON.stringify({ ok: true, exitCode: 0, stdout: "", stderr: "" }));
        }
        if (url.pathname.endsWith("/desktop")) {
          return res.end(JSON.stringify({ ok: true, desktopUrl: "https://desktop.example/vnc" }));
        }
        res.writeHead(404).end(JSON.stringify({ ok: false, message: "unexpected request" }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    // SAFETY: the test server was bound as TCP above, not to a Unix socket.
    const port = (api.address() as AddressInfo).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("retries the structured trial TTL refusal exactly once at the allowed ceiling", async () => {
    // SAFETY: AppConfig's remaining sections are optional; this test supplies
    // the only credential the Box path reads.
    const result = await provisionBox({ box: { token: "box_trial" } } as any, "trial-bot", "Trial Bot");
    expect(result.boxId).toBe("bx_23456789");
    expect(createBodies).toEqual([
      { ttlSeconds: 8 * 60 * 60, noEnv: true },
      { ttlSeconds: 2 * 60 * 60, noEnv: true },
    ]);
    expect(createKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(createKeys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(createKeys[1]).not.toBe(createKeys[0]);
  });
});
