import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RequestRecord = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };

describe("cloud computer provisioning cleanup", () => {
  const deletionOperationId = "bdop_0123456789abcdef0123456789abcdef";
  let api: Server;
  let provisionBoat: typeof import("./boat.ts").provisionBoat;
  let scenario:
    | "rename-failure"
    | "rename-failure-delete-gone"
    | "existing-desktop-failure"
    | "desktop-failure-delete-pending"
    | "cancelled-create" = "rename-failure";
  let mutateConfigAfterCreate: (() => void) | null = null;
  let createdName = "";
  const requests: RequestRecord[] = [];

  const nameFor = (botId: string) => {
    const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
    const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
    return `ogb-${prefix}-${hash}`;
  };

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://boat.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });
        res.setHeader("content-type", "application/json");

        if (url.pathname === "/api/v1/sandboxes" && req.method === "GET") {
          const boats =
            scenario === "existing-desktop-failure"
              ? [{ id: "bx_456789ab", name: nameFor("existing-bot"), state: "ready" }]
              : [];
          res.writeHead(200).end(JSON.stringify({ ok: true, type: "sandbox.list", sandboxes: boats, pageInfo: { nextCursor: null } }));
        } else if (url.pathname === "/api/v1/sandboxes" && req.method === "POST") {
          mutateConfigAfterCreate?.();
          createdName = "provider-created";
          res.writeHead(202).end(JSON.stringify({ ok: true, type: "sandbox.created", sandbox: { id: "bx_3456789a", state: "provisioning" } }));
        } else if (url.pathname === "/api/v1/sandboxes/bx_3456789a" && req.method === "PATCH") {
          if (scenario === "desktop-failure-delete-pending" || scenario === "cancelled-create") {
            createdName = JSON.parse(body).name;
            res.writeHead(200).end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(500).end(JSON.stringify({ ok: false, message: "rename rejected" }));
          }
        } else if (url.pathname === "/api/v1/sandboxes/bx_3456789a" && req.method === "DELETE") {
          if (scenario === "rename-failure-delete-gone") {
            res.writeHead(404).end(JSON.stringify({ ok: false, message: "not found" }));
            return;
          }
          res.writeHead(202).end(JSON.stringify({
            ok: true,
            type: "sandbox.deleting",
            operation: {
              id: deletionOperationId,
              kind: "sandbox",
              targetId: "bx_3456789a",
              status: "pending",
            },
          }));
        } else if (url.pathname === `/api/v1/deletion-operations/${deletionOperationId}` && req.method === "GET") {
          if (scenario === "desktop-failure-delete-pending") {
            res.writeHead(503).end(JSON.stringify({ ok: false, message: "deletion status unavailable" }));
          } else {
            res.writeHead(200).end(JSON.stringify({
              ok: true,
              type: "deletion.operation",
              operation: {
                id: deletionOperationId,
                kind: "sandbox",
                targetId: "bx_3456789a",
                status: "completed",
              },
            }));
          }
        } else if (url.pathname === "/api/v1/sandboxes/bx_3456789a" && req.method === "GET" && scenario === "cancelled-create") {
          // Boat reports a create that got no machine once, nameless, then answers 404.
          res.writeHead(200).end(JSON.stringify({ ok: true, sandbox: { id: "bx_3456789a", state: "cancelled", error: "No machine was ready" } }));
        } else if (url.pathname === "/api/v1/sandboxes/bx_3456789a" && req.method === "GET") {
          res.writeHead(200).end(JSON.stringify({
            ok: true,
            sandbox: { id: "bx_3456789a", name: createdName, state: "ready" },
          }));
        } else if (url.pathname === "/api/v1/sandboxes/bx_456789ab" && req.method === "GET") {
          res.writeHead(200).end(
            JSON.stringify({ ok: true, sandbox: { id: "bx_456789ab", name: nameFor("existing-bot"), state: "ready" } }),
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
    vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${port}/api/v1`);
    vi.resetModules();
    ({ provisionBoat } = await import("./boat.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  beforeEach(async () => {
    const deletionJournal = await import("./boat-delete-journal.ts");
    for (const record of deletionJournal.boatDeletionSnapshot()) {
      deletionJournal.retireBoatDeletion(record.boxId);
    }
  });

  it("permanently deletes a newly created sandbox when naming fails", async () => {
    scenario = "rename-failure";
    requests.length = 0;

    await expect(provisionBoat({ box: { token: "box_test" } } as any, "new-bot", "New Bot")).rejects.toThrow(
      /naming the cloud computer failed: rename rejected/,
    );

    const removal = requests.find((request) => request.method === "DELETE");
    const creation = requests.find((request) => request.method === "POST" && request.path.endsWith("/sandboxes"));
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({ noEnv: true });
    expect(removal?.path).toBe("/api/v1/sandboxes/bx_3456789a");
    expect(removal?.headers["x-ascii-confirm-delete"]).toBe("bx_3456789a");
    expect(requests).toContainEqual(expect.objectContaining({
      method: "GET",
      path: `/api/v1/deletion-operations/${deletionOperationId}`,
    }));
  });

  it("never deletes a pre-existing sandbox when a later step fails", async () => {
    scenario = "existing-desktop-failure";
    requests.length = 0;

    await expect(
      provisionBoat({ box: { token: "box_test" } } as any, "existing-bot", "Existing Bot"),
    ).rejects.toThrow(/desktop link could not be created/);

    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("keeps a newly named Boat recoverable while failed-provisioning cleanup is pending", async () => {
    scenario = "desktop-failure-delete-pending";
    requests.length = 0;
    createdName = "";
    const botId = "pending-cleanup-bot";

    await expect(provisionBoat({ box: { token: "box_test" } } as any, botId, "Pending Cleanup")).rejects.toThrow(
      /cloud computer's desktop link could not be created.*accepted deletion.*still pending.*recovery record was kept/i,
    );

    const journal = await import("./boat-create-idempotency.ts");
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: true,
    });
    const deletionIndex = requests.findIndex((request) => request.method === "DELETE");
    expect(deletionIndex).toBeGreaterThan(-1);
    expect(requests.slice(deletionIndex + 1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: `/api/v1/deletion-operations/${deletionOperationId}` }),
      expect.objectContaining({ method: "GET", path: "/api/v1/sandboxes/bx_3456789a" }),
    ]));

    journal.retireDeletedBoatCreate("bx_3456789a");
  });

  it("gives up at once on a create Boat cancelled for want of a machine, and deletes nothing", async () => {
    scenario = "cancelled-create";
    requests.length = 0;
    const botId = "cancelled-create-bot";

    await expect(provisionBoat({ box: { token: "box_test" } } as any, botId, "Cancelled")).rejects.toThrow(/did not become ready/);

    expect(requests.filter((request) => request.method === "GET" && request.path === "/api/v1/sandboxes/bx_3456789a")).toHaveLength(2);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    const journal = await import("./boat-create-idempotency.ts");
    expect(journal.boatCreateRecoverySnapshot().some((entry) => entry.botId === botId)).toBe(false);
  });

  it("retires a new-Boat create receipt when cleanup DELETE proves it already gone", async () => {
    scenario = "rename-failure-delete-gone";
    requests.length = 0;
    const botId = "gone-during-cleanup";

    await expect(provisionBoat({ box: { token: "box_test" } } as any, botId, "Gone Cleanup")).rejects.toThrow(
      /naming the cloud computer failed: rename rejected/,
    );

    const journal = await import("./boat-create-idempotency.ts");
    expect(journal.boatCreateRecoverySnapshot().some((entry) => entry.botId === botId)).toBe(false);
  });

  it("keeps create, rename, and cleanup on the token captured at operation start", async () => {
    scenario = "rename-failure";
    requests.length = 0;
    const config = { box: { token: "box_original" } };
    mutateConfigAfterCreate = () => {
      config.box.token = "box_replacement";
    };
    try {
      await expect(provisionBoat(config, "token-race-bot", "Token Race Bot")).rejects.toThrow(/naming the cloud computer failed/);
    } finally {
      mutateConfigAfterCreate = null;
    }

    const providerRequests = requests.filter((request) => request.path.includes("/sandboxes"));
    expect(providerRequests.some((request) => request.method === "PATCH")).toBe(true);
    expect(providerRequests.some((request) => request.method === "DELETE")).toBe(true);
    expect(providerRequests.every((request) => request.headers.authorization === "Bearer box_original")).toBe(true);
  });
});
