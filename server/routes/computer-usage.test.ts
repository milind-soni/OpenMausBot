import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { RemoteComputerProvider } from "./config.ts";
import type { RouteContext } from "./table.ts";

const legacyNameFor = (botId: string) =>
  `ogb-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;

let api: Server;
let listStatus = 200;
let rows: Array<{ id: string; name: string; state: string }> = [];
const requests: string[] = [];
let boat: typeof import("../boat.ts");
let journal: typeof import("../boat-create-idempotency.ts");
let deletions: typeof import("../boat-delete-journal.ts");
let routes: typeof import("./computer-usage.ts");
let requiredScope: typeof import("../request-auth.ts").requiredScope;
let PASS: typeof import("./table.ts").PASS;

beforeAll(async () => {
  api = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/v1/sandboxes")) {
      res.writeHead(listStatus).end(JSON.stringify(listStatus === 200 ? { ok: true, sandboxes: rows } : { ok: false, code: "unauthorized" }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_URL", undefined);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  vi.resetModules();
  boat = await import("../boat.ts");
  journal = await import("../boat-create-idempotency.ts");
  deletions = await import("../boat-delete-journal.ts");
  routes = await import("./computer-usage.ts");
  ({ requiredScope } = await import("../request-auth.ts"));
  ({ PASS } = await import("./table.ts"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  listStatus = 200;
  rows = [];
  requests.length = 0;
});

async function usage(cfg: AppConfig, options: { owners?: Array<{ botId: string; name: string; inUse: boolean }>; teams?: number; changing?: RemoteComputerProvider[] } = {}) {
  const sent: Array<{ status: number; body: unknown; headers: Record<string, string> }> = [];
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as ServerResponse;
  const handler = routes.createComputerUsageRoutes({
    cfg,
    managedBoatOwners: () => options.owners ?? [],
    teamComputers: { list: () => Array.from({ length: options.teams ?? 0 }, (_, index) => ({ id: `team-${index}` })) as never },
    computerProviderConfigTransitions: new Set(options.changing ?? []),
  });
  const out = await handler({
    res, path: "/api/computers/usage", method: "GET",
    json: ((_res: ServerResponse, status: number, body: unknown) => { sent.push({ status, body, headers: { ...headers } }); }) as RouteContext["json"],
  } as RouteContext);
  expect(out).not.toBe(PASS);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe("GET /api/computers/usage", () => {
  it("is an owner route, never a paired device's", () => {
    expect(requiredScope("GET", "/api/computers/usage")).toBe("admin");
  });

  it("answers only its own path", async () => {
    const handler = routes.createComputerUsageRoutes({
      cfg: {}, managedBoatOwners: () => [], teamComputers: { list: () => [] }, computerProviderConfigTransitions: new Set(),
    });
    for (const [method, path] of [["POST", "/api/computers/usage"], ["GET", "/api/computers/boxes"], ["GET", "/api/computers/usage/x"]]) {
      expect(await handler({ method, path } as RouteContext)).toBe(PASS);
    }
  });

  it("counts no cloud computers without a Boat account, and asks no one", async () => {
    const reply = await usage({}, { teams: 2 });
    expect(reply).toEqual({ status: 200, body: { cloudComputers: 0, teamComputers: 2 }, headers: { "cache-control": "private, no-store" } });
    expect(requests).toEqual([]);
  });

  it("counts this installation's managed computers and sends nothing else about them", async () => {
    const botId = "usage-counted-bot";
    rows = [
      { id: "bx_23456789", name: await boat.boatNameFor(botId), state: "ready" },
      { id: "bx_3456789a", name: await boat.boatNameFor("usage-team-computer"), state: "archived" },
      { id: "bx_456789ab", name: "someone-elses-box", state: "running" },
    ];
    const { body } = await usage({ box: { token: "box_usage" } } as AppConfig, {
      owners: [{ botId, name: "Research", inUse: false }, { botId: "usage-team-computer", name: "Team box", inUse: false }],
      teams: 1,
    });
    expect(body).toEqual({ cloudComputers: 2, teamComputers: 1 });
    expect(Object.values(body as object).every((value) => Number.isInteger(value))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/bx_|Research|Team box|ogb-|ready|archived/);
    expect(requests).toEqual(["GET /api/v1/sandboxes?limit=200"]);
  });

  it.each([401, 503])("says it does not know when Boat answers %i", async (status) => {
    listStatus = status;
    expect((await usage({ box: { token: "box_usage" } } as AppConfig, { teams: 1 })).body).toEqual({ cloudComputers: null, teamComputers: 1 });
  });

  it("says it does not know when Boat cannot be reached", async () => {
    vi.stubEnv("OMB_BOAT_API", "http://127.0.0.1:9/api/v1");
    try {
      expect((await usage({ box: { token: "box_usage" } } as AppConfig)).body).toEqual({ cloudComputers: null, teamComputers: 0 });
    } finally {
      vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v1`);
    }
  });

  it("does not list while the Boat account is changing", async () => {
    expect((await usage({ box: { token: "box_usage" } } as AppConfig, { changing: ["box"] })).body).toEqual({ cloudComputers: null, teamComputers: 0 });
    expect(requests).toEqual([]);
  });

  it("never adopts a legacy computer or touches the create and deletion journals", async () => {
    const botId = "usage-legacy-bot";
    rows = [{ id: "bx_56789abc", name: legacyNameFor(botId), state: "ready" }];
    const before = { creates: journal.boatCreateRecoverySnapshot(), deletions: deletions.boatDeletionSnapshot() };
    const { body } = await usage({ box: { token: "box_usage" } } as AppConfig, { owners: [{ botId, name: "Legacy", inUse: false }] });
    expect(body).toEqual({ cloudComputers: 1, teamComputers: 0 });
    expect({ creates: journal.boatCreateRecoverySnapshot(), deletions: deletions.boatDeletionSnapshot() }).toEqual(before);
    expect(before.creates.some((record) => record.botId === botId)).toBe(false);
  });
});
