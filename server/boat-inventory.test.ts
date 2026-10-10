import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ProviderBoat = Record<string, unknown> & { id: string; name: string; state: string };
type RequestRecord = { method: string; path: string; search: string; headers: IncomingMessage["headers"] };
type PageResponse = { boxes: ProviderBoat[]; nextCursor: string | null };
type DeletionStatus = "pending" | "processing" | "blocked" | "completed";

const DELETION_OPERATION_ID = "bdop_0123456789abcdef0123456789abcdef";

const legacyNameFor = (botId: string) => {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return `ogb-${prefix}-${hash}`;
};

describe("OpenMaus-managed Boat inventory", () => {
  let api: Server;
  let boats: ProviderBoat[] = [];
  let listStatus = 200;
  let listBody: Record<string, unknown> | null = null;
  let pageResponses: Map<string, PageResponse> | null = null;
  let stopStatus = 200;
  let deleteStatus = 202;
  let deleteRemovesBoat = true;
  let deleteBody: Record<string, unknown> | null = null;
  let deletionPollStatus = 200;
  let directStatus = 200;
  /** Accept direct Boat reads and never answer them: a stalled relay. */
  let directHangs = false;
  const hung: ServerResponse[] = [];
  let deletionStatuses: DeletionStatus[] = ["completed"];
  let lastDeletionStatus: DeletionStatus = "completed";
  let deletionTargetId = "";
  const requests: RequestRecord[] = [];
  let boat: typeof import("./boat.ts");
  let journal: typeof import("./boat-create-idempotency.ts");
  let deleteJournal: typeof import("./boat-delete-journal.ts");
  const cfg = { box: { token: "box_test" } } as any;

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://boat.test");
      requests.push({ method: req.method ?? "GET", path: url.pathname, search: url.search, headers: req.headers });
      res.setHeader("content-type", "application/json");

      if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
        const page = pageResponses?.get(url.searchParams.get("cursor") ?? "");
        res.writeHead(listStatus).end(JSON.stringify(listBody ?? {
          ok: listStatus < 400,
          boxes: page?.boxes ?? boats,
          ...(page ? { pageInfo: { nextCursor: page.nextCursor } } : {}),
        }));
        return;
      }
      if (url.pathname.endsWith("/commands") && req.method === "POST") {
        res.writeHead(200).end(JSON.stringify({ ok: true, exitCode: 0, stdout: "", stderr: "" }));
        return;
      }
      if (url.pathname.endsWith("/stop") && req.method === "POST") {
        res.writeHead(stopStatus).end(JSON.stringify(
          stopStatus < 400 ? { ok: true } : { ok: false, message: "stop refused" },
        ));
        return;
      }
      if (url.pathname === `/api/box/v1/deletion-operations/${DELETION_OPERATION_ID}` && req.method === "GET") {
        lastDeletionStatus = deletionStatuses.shift() ?? lastDeletionStatus;
        res.writeHead(deletionPollStatus).end(JSON.stringify(
          deletionPollStatus < 400
            ? {
                ok: true,
                type: "deletion.operation",
                operation: {
                  id: DELETION_OPERATION_ID,
                  kind: "box",
                  targetId: deletionTargetId,
                  status: lastDeletionStatus,
                },
              }
            : { ok: false, message: "deletion status unavailable" },
        ));
        return;
      }
      if (req.method === "DELETE") {
        const boxId = url.pathname.split("/").at(-1) ?? "";
        deletionTargetId = boxId;
        lastDeletionStatus = deletionStatuses.shift() ?? "completed";
        if (deleteStatus < 400 && deleteRemovesBoat) {
          boats = boats.filter((candidate) => candidate.id !== boxId);
        }
        res.writeHead(deleteStatus).end(JSON.stringify(
          deleteBody ?? (deleteStatus < 400
            ? {
                ok: true,
                type: "deletion.operation",
                operation: {
                  id: DELETION_OPERATION_ID,
                  kind: "box",
                  targetId: boxId,
                  status: lastDeletionStatus,
                },
              }
            : { ok: false, message: "delete refused" }),
        ));
        return;
      }
      const direct = boats.find((candidate) => url.pathname.endsWith(`/boxes/${candidate.id}`));
      if (direct && req.method === "GET") {
        if (directHangs) { hung.push(res); return; }
        res.writeHead(directStatus).end(JSON.stringify(
          directStatus < 400
            ? { ok: true, box: direct }
            : { ok: false, message: "box lookup unavailable" },
        ));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ ok: false, message: "not found" }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as { port: number }).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    boat = await import("./boat.ts");
    journal = await import("./boat-create-idempotency.ts");
    deleteJournal = await import("./boat-delete-journal.ts");
  });

  beforeEach(() => {
    boats = [];
    listStatus = 200;
    listBody = null;
    pageResponses = null;
    stopStatus = 200;
    deleteStatus = 202;
    deleteRemovesBoat = true;
    deleteBody = null;
    deletionPollStatus = 200;
    directStatus = 200;
    directHangs = false;
    for (const response of hung.splice(0)) response.end("{}");
    deletionStatuses = ["completed"];
    lastDeletionStatus = "completed";
    deletionTargetId = "";
    requests.length = 0;
    for (const record of journal.boatCreateRecoverySnapshot()) {
      if (record.boxId) journal.retireDeletedBoatCreate(record.boxId);
    }
    for (const record of deleteJournal.boatDeletionSnapshot()) {
      deleteJournal.retireBoatDeletion(record.boxId);
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const response of hung.splice(0)) response.end("{}");
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("lists only sanitized managed boats and keeps an owned legacy Boat discoverable", async () => {
    const botId = "current-bot-123";
    boats = [
      {
        id: "bx_23456789",
        name: legacyNameFor(botId),
        state: "READY",
        desktopUrl: "https://secret.example/?token=do-not-leak",
        dedicatedIp: "203.0.113.8",
        env: { PRIVATE_KEY: "do-not-leak" },
      },
      { id: "bx_abcdefgh", name: "ogb-orphaned-abcdef", state: "archived", desktopUrl: "secret" },
      { id: "bx_jkmnpqrs", name: "my-production-box", state: "running" },
      { id: "bad/id", name: "ogb-invalid0-123456", state: "running" },
    ];

    const inventory = await boat.listManagedBoats(cfg, [{ botId, name: "Research", inUse: true }]);

    expect(inventory).toEqual({
      configured: true,
      available: true,
      problem: null,
      instances: [
        {
          boxId: "bx_23456789",
          name: legacyNameFor(botId),
          state: "ready",
          ownerBotId: botId,
          ownerName: "Research",
          orphaned: false,
          inUse: true,
        },
      ],
    });
    expect(JSON.stringify(inventory)).not.toMatch(/desktopUrl|dedicatedIp|PRIVATE_KEY|do-not-leak|foreign-box/);
    expect(requests).toEqual([expect.objectContaining({
      method: "GET",
      path: "/api/box/v1/boxes",
      search: "?limit=200",
    })]);
  });

  it("keeps an adopted Boat visible when an eventually-consistent listing omits it", async () => {
    const botId = "legacy-adoption";
    const boxId = "bx_3456789a";
    boats = [{ id: boxId, name: legacyNameFor(botId), state: "ready" }];

    expect((await boat.listManagedBoats(cfg, [{ botId, name: "Legacy", inUse: false }])).available).toBe(true);
    // Refreshing the same provider row must not grow the ownership journal.
    requests.length = 0;
    expect((await boat.listManagedBoats(cfg, [{ botId, name: "Legacy", inUse: false }])).available).toBe(true);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
    ]);
    expect(journal.boatCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
      { botId, boxId, resolved: true },
    ]);

    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);
    requests.length = 0;
    expect((await boat.listManagedBoats(cfg, [{ botId, name: "Legacy", inUse: false }])).instances).toEqual([
      expect.objectContaining({
        boxId,
        name: legacyNameFor(botId),
        state: "ready",
        ownerBotId: botId,
      }),
    ]);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
      `GET /api/box/v1/boxes/${boxId}`,
    ]);
    expect(journal.boatCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
      { botId, boxId, resolved: true },
    ]);
  });

  it("does not use remembered Boat identities during a replacement-token probe", async () => {
    const botId = "replacement-recovery";
    const boxId = "bx_89abcdef";
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    boats = [{ id: boxId, name: await boat.boatNameFor(botId), state: "ready" }];
    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);

    const inventory = await boat.listManagedBoats(
      cfg,
      [{ botId, name: "Replacement", inUse: false }],
      { adoptLegacy: false },
    );

    expect(inventory.instances).toEqual([]);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
    ]);
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
  });

  it("retires an omitted recovery identity when direct inspection proves the Boat is gone", async () => {
    const botId = "stale-listing";
    const boxId = "bx_9abcdefg";
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);

    const inventory = await boat.listManagedBoats(cfg, [{ botId, name: "Stale", inUse: false }]);

    expect(inventory).toMatchObject({ available: true, instances: [] });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
      `GET /api/box/v1/boxes/${boxId}`,
    ]);
    expect(journal.boatCreateRecoverySnapshot().some((record) => record.boxId === boxId)).toBe(false);
  });

  it("fails closed when LIST gives a remembered Boat id an unexpected name", async () => {
    const botId = "conflicting-name";
    const boxId = "bx_abcdefg2";
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    pageResponses = new Map([["", {
      boxes: [{ id: boxId, name: "provider-renamed-box", state: "ready" }],
      nextCursor: null,
    }]]);

    const inventory = await boat.listManagedBoats(cfg, [{ botId, name: "Conflict", inUse: false }]);

    expect(inventory).toMatchObject({ available: false, instances: [] });
    expect(inventory.problem).toMatch(/no longer has its OpenMausBot owner name/i);
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
    ]);
  });

  it("deletes a remembered Boat even while account LIST still omits it", async () => {
    const botId = "omitted-delete";
    const boxId = "bx_bcdefgh2";
    const managedName = await boat.boatNameFor(botId);
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    boats = [{ id: boxId, name: managedName, state: "ARCHIVED" }];
    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);

    await expect(
      boat.deleteManagedBoat(cfg, [{ botId, name: "Omitted", inUse: false }], boxId, managedName),
    ).resolves.toEqual({ ok: true });

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
      `GET /api/box/v1/boxes/${boxId}`,
      `DELETE /api/box/v1/boxes/${boxId}`,
    ]);
    expect(journal.boatCreateRecoverySnapshot().some((record) => record.boxId === boxId)).toBe(false);
  });

  it("can compare a replacement account without adopting its legacy identities", async () => {
    const botId = "replacement-probe";
    boats = [{ id: "bx_789abcde", name: legacyNameFor(botId), state: "ready" }];

    const inventory = await boat.listManagedBoats(
      cfg,
      [{ botId, name: "Replacement", inUse: false }],
      { adoptLegacy: false },
    );

    expect(inventory.available).toBe(true);
    expect(inventory.instances).toEqual([
      expect.objectContaining({ boxId: "bx_789abcde", ownerBotId: botId }),
    ]);
    expect(journal.boatCreateRecoverySnapshot().some((record) => record.botId === botId)).toBe(false);
  });

  it("recognizes adopted legacy names when restoring their account credential", async () => {
    const botId = "legacy-credential";
    expect(await boat.boatNameMatchesBot(botId, await boat.boatNameFor(botId))).toBe(true);
    expect(await boat.boatNameMatchesBot(botId, legacyNameFor(botId))).toBe(true);
    expect(await boat.boatNameMatchesBot(botId, "provider-owned-boat")).toBe(false);
  });

  it("fails closed for malformed or conflicting identities that name this installation", async () => {
    const botId = "invalid-owned";
    const currentName = await boat.boatNameFor(botId);
    boats = [{ id: "bad/id", name: currentName, state: "ready" }];

    const malformed = await boat.listManagedBoats(cfg, [{ botId, name: "Invalid", inUse: false }]);
    expect(malformed).toMatchObject({ configured: true, available: false, instances: [] });
    expect(malformed.problem).toMatch(/invalid id/i);

    boats = [
      { id: "bx_456789ab", name: currentName, state: "ready" },
      { id: "bx_456789ab", name: "provider-duplicate", state: "ready" },
    ];
    const conflicting = await boat.listManagedBoats(cfg, [{ botId, name: "Invalid", inUse: false }]);
    expect(conflicting).toMatchObject({ configured: true, available: false, instances: [] });
    expect(conflicting.problem).toMatch(/conflicting id/i);
  });

  it("does not cache or use a malformed exact-name Boat identity", async () => {
    const botId = "invalid-find";
    boats = [{ id: "not-a-box", name: await boat.boatNameFor(botId), state: "ready" }];

    await expect(boat.findBoat(cfg, botId)).rejects.toThrow(/invalid cloud computer identity/i);
  });

  it("shows current-install orphans but hides foreign and ownerless legacy Boats", async () => {
    const currentBotId = "scoped-owner";
    const legacyBotId = "legacy-owner";
    const currentName = await boat.boatNameFor(currentBotId);
    const orphanName = await boat.boatNameFor("deleted-local-bot");
    const currentScope = currentName.match(/^ogb-([a-f0-9]{12})-/)?.[1];
    expect(currentScope).toBeTruthy();
    const foreignScope = currentScope === "000000000000" ? "111111111111" : "000000000000";
    const foreignName = currentName.replace(/^ogb-[a-f0-9]{12}-/, `ogb-${foreignScope}-`);
    const ownerlessLegacyName = "ogb-orphaned-abcdef";
    boats = [
      { id: "bx_23456789", name: currentName, state: "ready" },
      { id: "bx_abcdefgh", name: legacyNameFor(legacyBotId), state: "archived" },
      { id: "bx_jkmnpqrs", name: orphanName, state: "idle" },
      { id: "bx_mnpqrstu", name: foreignName, state: "running" },
      { id: "bx_npqrstuv", name: ownerlessLegacyName, state: "archived" },
    ];
    const owners = [
      { botId: currentBotId, name: "Current", inUse: false },
      { botId: legacyBotId, name: "Legacy", inUse: false },
    ];

    const inventory = await boat.listManagedBoats(cfg, owners);

    expect(inventory.instances).toHaveLength(3);
    expect(inventory.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ boxId: "bx_23456789", ownerBotId: currentBotId, orphaned: false }),
      expect.objectContaining({ boxId: "bx_abcdefgh", ownerBotId: legacyBotId, orphaned: false }),
      expect.objectContaining({ boxId: "bx_jkmnpqrs", ownerBotId: null, orphaned: true }),
    ]));
    expect(inventory.instances.some((instance) => instance.name === foreignName)).toBe(false);
    expect(inventory.instances.some((instance) => instance.name === ownerlessLegacyName)).toBe(false);

    requests.length = 0;
    await expect(boat.deleteManagedBoat(cfg, owners, "bx_mnpqrstu", foreignName)).rejects.toThrow(/no longer exists/);
    await expect(
      boat.deleteManagedBoat(cfg, owners, "bx_npqrstuv", ownerlessLegacyName),
    ).rejects.toThrow(/no longer exists/);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("walks cursor pages once and refuses a repeated cursor instead of looping", async () => {
    const botId = "second-page-owner";
    pageResponses = new Map([
      ["", { boxes: [{ id: "foreign", name: "unmanaged", state: "ready" }], nextCursor: "page two/?=" }],
      ["page two/?=", { boxes: [{ id: "bx_mnpqrstu", name: legacyNameFor(botId), state: "idle" }], nextCursor: null }],
    ]);

    const inventory = await boat.listManagedBoats(cfg, [{ botId, name: "Page two", inUse: false }]);
    expect(inventory.instances).toEqual([
      expect.objectContaining({ boxId: "bx_mnpqrstu", ownerBotId: botId, state: "idle" }),
    ]);
    expect(requests.map((request) => request.search)).toEqual([
      "?limit=200",
      "?limit=200&cursor=page%20two%2F%3F%3D",
    ]);

    requests.length = 0;
    pageResponses = new Map([
      ["", { boxes: [], nextCursor: "same" }],
      ["same", { boxes: [], nextCursor: "same" }],
    ]);
    const loop = await boat.listManagedBoats(cfg, []);
    expect(loop).toMatchObject({ configured: true, available: false, instances: [] });
    expect(loop.problem).toMatch(/repeated.*cursor/i);
    expect(requests).toHaveLength(2);
  });

  it("distinguishes not configured and provider failure from an empty account", async () => {
    const unconfigured = await boat.listManagedBoats({} as any, []);
    expect(unconfigured).toEqual({ configured: false, available: false, problem: null, instances: [] });
    expect(requests).toHaveLength(0);

    listStatus = 503;
    listBody = { ok: false, message: "maintenance" };
    const unavailable = await boat.listManagedBoats(cfg, []);
    expect(unavailable).toMatchObject({ configured: true, available: false, instances: [] });
    expect(unavailable.problem).toMatch(/maintenance/);

    listStatus = 200;
    listBody = { ok: true, boxes: [] };
    expect(await boat.listManagedBoats(cfg, [])).toMatchObject({ configured: true, available: true, instances: [] });
  });

  it("revalidates ownership before sleep and surfaces a provider refusal", async () => {
    const botId = "sleeping-owner";
    boats = [{ id: "bx_tuvwxyz2", name: legacyNameFor(botId), state: "ready" }];
    const owners = [{ botId, name: "Sleeper", inUse: false }];

    await boat.sleepManagedBoat(cfg, owners, "bx_tuvwxyz2");
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
      "POST /api/box/v1/boxes/bx_tuvwxyz2/commands",
      "POST /api/box/v1/boxes/bx_tuvwxyz2/stop",
    ]);

    requests.length = 0;
    stopStatus = 500;
    await expect(boat.sleepManagedBoat(cfg, owners, "bx_tuvwxyz2")).rejects.toThrow(/boat sleep failed: stop refused/);
    expect(requests.some((request) => request.path.endsWith("/resume"))).toBe(false);
    expect(requests.some((request) => request.path.endsWith("/desktop"))).toBe(false);

    boats = [{ id: "bx_tuvwxyz2", name: legacyNameFor(botId), state: "provisioning" }];
    requests.length = 0;
    await expect(boat.sleepManagedBoat(cfg, owners, "bx_tuvwxyz2")).rejects.toThrow(/cannot sleep while it is provisioning/);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("requires fresh exact confirmation for deletion and clears a cached owner id", async () => {
    const botId = "delete-owner";
    const managedName = legacyNameFor(botId);
    boats = [{ id: "bx_3456789a", name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Disposable", inUse: false }];
    const journal = await import("./boat-create-idempotency.ts");
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, "bx_3456789a"));

    await boat.findBoat(cfg, botId);
    requests.length = 0;
    await expect(boat.deleteManagedBoat(cfg, owners, "bx_3456789a", "stale-name")).rejects.toThrow(
      /confirmation no longer matches/,
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: true,
    });

    deleteStatus = 503;
    await expect(boat.deleteManagedBoat(cfg, owners, "bx_3456789a", managedName)).rejects.toThrow(/delete refused/);
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: true,
    });
    deleteStatus = 202;

    requests.length = 0;
    deletionStatuses = ["pending", "processing", "completed"];
    await boat.deleteManagedBoat(cfg, owners, "bx_3456789a", managedName);
    const removal = requests.find((request) => request.method === "DELETE");
    expect(removal?.path).toBe("/api/box/v1/boxes/bx_3456789a");
    expect(removal?.headers["x-ascii-confirm-delete"]).toBe("bx_3456789a");
    expect(requests.filter((request) => request.path.includes("/deletion-operations/"))).toHaveLength(2);
    expect(journal.boatCreateRecoverySnapshot().find((record) => record.botId === botId)).toBeUndefined();

    boats = [];
    requests.length = 0;
    expect(await boat.findBoat(cfg, botId)).toBeNull();
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/api/box/v1/boxes",
      search: "?limit=200",
    });
  });

  it("keeps the durable Boat receipt when background deletion becomes blocked", async () => {
    const botId = "blocked-delete-owner";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_456789ab";
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Blocked", inUse: false }];
    const journal = await import("./boat-create-idempotency.ts");
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    deletionStatuses = ["pending", "blocked"];
    deleteRemovesBoat = false;

    await expect(boat.deleteManagedBoat(cfg, owners, boxId, managedName)).rejects.toThrow(/deletion operation is blocked/i);
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
  });

  it("reports an accepted background deletion as pending without discarding recovery", async () => {
    const botId = "pending-delete-owner";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_6789abcd";
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Pending", inUse: false }];
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    deletionStatuses = ["pending"];
    deleteRemovesBoat = false;

    await expect(
      boat.deleteManagedBoat(cfg, owners, boxId, managedName, undefined, { pollDelaysMs: [] }),
    ).resolves.toEqual({ ok: true, pending: true });
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);

    // Once LIST drops the row, direct absence is authoritative and retires
    // the recovery receipt on the next inventory refresh.
    boats = [];
    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);
    await expect(boat.listManagedBoats(cfg, owners)).resolves.toMatchObject({ instances: [] });
    expect(journal.boatCreateRecoverySnapshot().some((record) => record.boxId === boxId)).toBe(false);
  });

  it("keeps an omitted pending deletion visible and fenced without sending DELETE twice", async () => {
    const botId = "pending-list-fence";
    const boxId = "bx_789abcd2";
    const managedName = await boat.boatNameFor(botId);
    const owners = [{ botId, name: "Pending fence", inUse: false }];
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    deletionStatuses = ["pending"];
    deleteRemovesBoat = false;

    await expect(
      boat.deleteManagedBoat(cfg, owners, boxId, managedName, undefined, { pollDelaysMs: [] }),
    ).resolves.toEqual({ ok: true, pending: true });
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);

    // The account LIST is stale, but the exact operation/id record keeps the
    // Settings row honest and blocks all normal use after a restart.
    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);
    await expect(boat.listManagedBoats(cfg, owners)).resolves.toMatchObject({
      available: true,
      instances: [expect.objectContaining({ boxId, state: "removing", ownerBotId: botId })],
    });
    await expect(boat.findBoat(cfg, botId)).rejects.toThrow(/being deleted/i);
    await expect(boat.runCommand(cfg, boxId, "echo nope")).rejects.toThrow(/being deleted/i);

    await expect(
      boat.deleteManagedBoat(cfg, owners, boxId, managedName, undefined, { pollDelaysMs: [] }),
    ).resolves.toEqual({ ok: true, pending: true });
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);

    deletionStatuses = ["completed"];
    await expect(boat.listManagedBoats(cfg, owners)).resolves.toMatchObject({ instances: [] });
    expect(deleteJournal.boatDeletionSnapshot()).toEqual([]);
    expect(journal.boatCreateRecoverySnapshot().some((record) => record.boxId === boxId)).toBe(false);
  });

  it("keeps an orphan deletion recoverable even without a create receipt", async () => {
    const boxId = "bx_89abcdef";
    const managedName = await boat.boatNameFor("deleted-local-owner");
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    deletionStatuses = ["pending"];
    deleteRemovesBoat = false;

    await expect(
      boat.deleteManagedBoat(cfg, [], boxId, managedName, undefined, { pollDelaysMs: [] }),
    ).resolves.toEqual({ ok: true, pending: true });
    pageResponses = new Map([["", { boxes: [], nextCursor: null }]]);

    await expect(boat.listManagedBoats(cfg, [])).resolves.toMatchObject({
      instances: [expect.objectContaining({ boxId, state: "removing", ownerBotId: null, orphaned: true })],
    });
    expect(deleteJournal.boatDeletionSnapshot()).toEqual([
      expect.objectContaining({ boxId, name: managedName, ownerBotId: null, phase: "accepted" }),
    ]);
  });

  it("keeps a valid accepted deletion pending when direct confirmation is unavailable", async () => {
    const botId = "unavailable-delete-check";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_bcdefgh3";
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Unavailable check", inUse: false }];
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    deletionStatuses = ["pending"];
    deleteRemovesBoat = false;
    directStatus = 503;

    await expect(
      boat.deleteManagedBoat(cfg, owners, boxId, managedName, undefined, { pollDelaysMs: [] }),
    ).resolves.toEqual({ ok: true, pending: true });
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
  });

  it("rejects a malformed successful deletion envelope while the Boat still exists", async () => {
    const botId = "invalid-delete-receipt";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_789abcde";
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Invalid receipt", inUse: false }];
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    deleteRemovesBoat = false;
    deleteBody = { ok: true, operation: { status: "pending" } };

    await expect(
      boat.deleteManagedBoat(cfg, owners, boxId, managedName, undefined, { pollDelaysMs: [] }),
    ).rejects.toThrow(/invalid deletion receipt/i);
    expect(journal.boatCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
  });

  it("retires the exact receipt when the Boat disappears between revalidation and DELETE", async () => {
    const botId = "already-gone-owner";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_56789abc";
    boats = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Gone", inUse: false }];
    const journal = await import("./boat-create-idempotency.ts");
    const attempt = journal.beginBoatCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoatCreate(journal.rememberCreatedBoat(attempt.request, boxId));
    deleteStatus = 404;

    await expect(boat.deleteManagedBoat(cfg, owners, boxId, managedName)).resolves.toEqual({ ok: true });
    expect(journal.boatCreateRecoverySnapshot().some((entry) => entry.botId === botId)).toBe(false);
  });

  it("bounds the direct read of a known Boat, so a stalled relay can't hold a turn's setup", async () => {
    const botId = "stalled-direct-read";
    boats = [{ id: "bx_456789ab", name: legacyNameFor(botId), state: "ready" }];
    await expect(boat.findBoat(cfg, botId)).resolves.toMatchObject({ id: "bx_456789ab" }); // caches the id
    directHangs = true;
    requests.length = 0;
    // The direct read's own deadline expires at once instead of after 20 s;
    // the listing behind it keeps its real one. Without a deadline the read
    // waits on the stalled relay and this test times out.
    const deadline = vi.spyOn(AbortSignal, "timeout")
      .mockImplementationOnce(() => AbortSignal.abort(new DOMException("deadline", "TimeoutError")));
    try {
      await expect(boat.findBoat(cfg, botId)).resolves.toMatchObject({ id: "bx_456789ab" });
      expect(deadline).toHaveBeenNthCalledWith(1, 20_000);
      // Gave up on the direct read and answered from the listing.
      expect(requests.map(request => `${request.method} ${request.path}`)).toEqual(["GET /api/box/v1/boxes"]);
    } finally {
      deadline.mockRestore();
    }
  }, 10_000);

  it("finds an existing boat on a later page and fails closed when listing is unavailable", async () => {
    const secondPageBot = "existing-second-page";
    pageResponses = new Map([
      ["", { boxes: [], nextCursor: "next" }],
      ["next", {
        boxes: [{ id: "bx_npqrstuv", name: legacyNameFor(secondPageBot), state: "ready" }],
        nextCursor: null,
      }],
    ]);

    await expect(boat.findBoat(cfg, secondPageBot)).resolves.toMatchObject({ id: "bx_npqrstuv" });
    expect(requests.map((request) => request.search)).toEqual([
      "?limit=200",
      "?limit=200&cursor=next",
    ]);
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes"))).toBe(false);

    requests.length = 0;
    pageResponses = null;
    listStatus = 503;
    listBody = { ok: false, message: "maintenance" };
    await expect(boat.provisionBoat(cfg, "provider-down-bot", "Offline")).rejects.toThrow(/maintenance/);
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes"))).toBe(false);
  });

  it("does not mutate a missing or busy managed boat and reports delete failures", async () => {
    const botId = "busy-owner";
    const managedName = legacyNameFor(botId);
    const owners = [{ botId, name: "Busy", inUse: true }];

    await expect(boat.deleteManagedBoat(cfg, owners, "bx_456789ab", managedName)).rejects.toThrow(/no longer exists/);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    boats = [{ id: "bx_56789abc", name: managedName, state: "running" }];
    requests.length = 0;
    await expect(boat.sleepManagedBoat(cfg, owners, "bx_56789abc")).rejects.toThrow(/in use/);
    expect(requests.every((request) => request.method === "GET")).toBe(true);

    requests.length = 0;
    deleteStatus = 500;
    await expect(boat.deleteManagedBoat(cfg, [{ ...owners[0], inUse: false }], "bx_56789abc", managedName)).rejects.toThrow(
      /boat delete failed: delete refused/,
    );
  });
});
