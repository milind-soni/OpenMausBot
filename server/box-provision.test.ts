import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type RequestRecord = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };

describe("cloud computer provisioning cleanup", () => {
  const deletionOperationId = "bdop_0123456789abcdef0123456789abcdef";
  let api: Server;
  let provisionBox: typeof import("./box.ts").provisionBox;
  let scenario: "rename-failure" | "rename-failure-delete-gone" | "existing-desktop-failure" = "rename-failure";
  let mutateConfigAfterCreate: (() => void) | null = null;
  const requests: RequestRecord[] = [];

  const nameFor = (botId: string) => {
    const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
    const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
    return `ogb-${prefix}-${hash}`;
  };

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });
        res.setHeader("content-type", "application/json");

        if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
          const boxes =
            scenario === "existing-desktop-failure"
              ? [{ id: "bx_456789ab", name: nameFor("existing-bot"), state: "ready" }]
              : [];
          res.writeHead(200).end(JSON.stringify({ ok: true, boxes }));
        } else if (url.pathname === "/api/box/v1/boxes" && req.method === "POST") {
          mutateConfigAfterCreate?.();
          res.writeHead(201).end(JSON.stringify({ ok: true, box: { id: "bx_3456789a", state: "provisioning" } }));
        } else if (url.pathname === "/api/box/v1/boxes/bx_3456789a" && req.method === "PATCH") {
          res.writeHead(500).end(JSON.stringify({ ok: false, message: "rename rejected" }));
        } else if (url.pathname === "/api/box/v1/boxes/bx_3456789a" && req.method === "DELETE") {
          if (scenario === "rename-failure-delete-gone") {
            res.writeHead(404).end(JSON.stringify({ ok: false, message: "not found" }));
            return;
          }
          res.writeHead(202).end(JSON.stringify({
            ok: true,
            type: "box.deleting",
            operation: {
              id: deletionOperationId,
              kind: "box",
              targetId: "bx_3456789a",
              status: "pending",
            },
          }));
        } else if (url.pathname === `/api/box/v1/deletion-operations/${deletionOperationId}` && req.method === "GET") {
          res.writeHead(200).end(JSON.stringify({
            ok: true,
            type: "deletion.operation",
            operation: {
              id: deletionOperationId,
              kind: "box",
              targetId: "bx_3456789a",
              status: "completed",
            },
          }));
        } else if (url.pathname === "/api/box/v1/boxes/bx_456789ab" && req.method === "GET") {
          res.writeHead(200).end(
            JSON.stringify({ ok: true, box: { id: "bx_456789ab", name: nameFor("existing-bot"), state: "ready" } }),
          );
        } else if (url.pathname.endsWith("/commands")) {
          res.writeHead(200).end(JSON.stringify({ ok: true, exitCode: 0, stdout: "bootstrapped", stderr: "" }));
        } else if (url.pathname.endsWith("/desktop")) {
          res.writeHead(500).end(JSON.stringify({ ok: false, message: "desktop unavailable" }));
        } else {
          res.writeHead(404).end(JSON.stringify({ ok: false, message: `unexpected ${req.method} ${url.pathname}` }));
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ provisionBox } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("permanently deletes a newly created box when naming fails", async () => {
    scenario = "rename-failure";
    requests.length = 0;

    await expect(provisionBox({ box: { token: "box_test" } } as any, "new-bot", "New Bot")).rejects.toThrow(
      /box naming failed: rename rejected/,
    );

    const removal = requests.find((request) => request.method === "DELETE");
    const creation = requests.find((request) => request.method === "POST" && request.path.endsWith("/boxes"));
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({ noEnv: true });
    expect(removal?.path).toBe("/api/box/v1/boxes/bx_3456789a");
    expect(removal?.headers["x-ascii-confirm-delete"]).toBe("bx_3456789a");
    expect(requests).toContainEqual(expect.objectContaining({
      method: "GET",
      path: `/api/box/v1/deletion-operations/${deletionOperationId}`,
    }));
  });

  it("never deletes a pre-existing box when a later step fails", async () => {
    scenario = "existing-desktop-failure";
    requests.length = 0;

    await expect(
      provisionBox({ box: { token: "box_test" } } as any, "existing-bot", "Existing Bot"),
    ).rejects.toThrow(/desktop link could not be created/);

    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("retires a new-Box create receipt when cleanup DELETE proves it already gone", async () => {
    scenario = "rename-failure-delete-gone";
    requests.length = 0;
    const botId = "gone-during-cleanup";

    await expect(provisionBox({ box: { token: "box_test" } } as any, botId, "Gone Cleanup")).rejects.toThrow(
      /box naming failed: rename rejected/,
    );

    const journal = await import("./box-create-idempotency.ts");
    expect(journal.boxCreateRecoverySnapshot().some((entry) => entry.botId === botId)).toBe(false);
  });

  it("keeps create, rename, and cleanup on the token captured at operation start", async () => {
    scenario = "rename-failure";
    requests.length = 0;
    const config = { box: { token: "box_original" } };
    mutateConfigAfterCreate = () => {
      config.box.token = "box_replacement";
    };
    try {
      await expect(provisionBox(config, "token-race-bot", "Token Race Bot")).rejects.toThrow(/box naming failed/);
    } finally {
      mutateConfigAfterCreate = null;
    }

    const providerRequests = requests.filter((request) => request.path.includes("/boxes"));
    expect(providerRequests.some((request) => request.method === "PATCH")).toBe(true);
    expect(providerRequests.some((request) => request.method === "DELETE")).toBe(true);
    expect(providerRequests.every((request) => request.headers.authorization === "Bearer box_original")).toBe(true);
  });
});
