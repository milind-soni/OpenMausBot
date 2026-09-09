import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ProviderBox = Record<string, unknown> & { id: string; name: string; state: string };
type RequestRecord = { method: string; path: string; search: string; headers: IncomingMessage["headers"] };
type PageResponse = { boxes: ProviderBox[]; nextCursor: string | null };
type DeletionStatus = "pending" | "processing" | "blocked" | "completed";

const DELETION_OPERATION_ID = "bdop_0123456789abcdef0123456789abcdef";

const legacyNameFor = (botId: string) => {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return `ogb-${prefix}-${hash}`;
};

describe("OpenMaus-managed Box inventory", () => {
  let api: Server;
  let boxes: ProviderBox[] = [];
  let listStatus = 200;
  let listBody: Record<string, unknown> | null = null;
  let pageResponses: Map<string, PageResponse> | null = null;
  let stopStatus = 200;
  let deleteStatus = 202;
  let deletionStatuses: DeletionStatus[] = ["completed"];
  let lastDeletionStatus: DeletionStatus = "completed";
  let deletionTargetId = "";
  const requests: RequestRecord[] = [];
  let box: typeof import("./box.ts");
  let journal: typeof import("./box-create-idempotency.ts");
  const cfg = { box: { token: "box_test" } } as any;

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      requests.push({ method: req.method ?? "GET", path: url.pathname, search: url.search, headers: req.headers });
      res.setHeader("content-type", "application/json");

      if (url.pathname === "/api/box/v1/boxes" && req.method === "GET") {
        const page = pageResponses?.get(url.searchParams.get("cursor") ?? "");
        res.writeHead(listStatus).end(JSON.stringify(listBody ?? {
          ok: listStatus < 400,
          boxes: page?.boxes ?? boxes,
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
        res.writeHead(200).end(JSON.stringify({
          ok: true,
          type: "deletion.operation",
          operation: {
            id: DELETION_OPERATION_ID,
            kind: "box",
            targetId: deletionTargetId,
            status: lastDeletionStatus,
          },
        }));
        return;
      }
      if (req.method === "DELETE") {
        const boxId = url.pathname.split("/").at(-1) ?? "";
        deletionTargetId = boxId;
        lastDeletionStatus = deletionStatuses.shift() ?? "completed";
        if (deleteStatus < 400) boxes = boxes.filter((candidate) => candidate.id !== boxId);
        res.writeHead(deleteStatus).end(JSON.stringify(
          deleteStatus < 400
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
            : { ok: false, message: "delete refused" },
        ));
        return;
      }
      const direct = boxes.find((candidate) => url.pathname.endsWith(`/boxes/${candidate.id}`));
      if (direct && req.method === "GET") {
        res.writeHead(200).end(JSON.stringify({ ok: true, box: direct }));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ ok: false, message: "not found" }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as { port: number }).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    box = await import("./box.ts");
    journal = await import("./box-create-idempotency.ts");
  });

  beforeEach(() => {
    boxes = [];
    listStatus = 200;
    listBody = null;
    pageResponses = null;
    stopStatus = 200;
    deleteStatus = 202;
    deletionStatuses = ["completed"];
    lastDeletionStatus = "completed";
    deletionTargetId = "";
    requests.length = 0;
    for (const record of journal.boxCreateRecoverySnapshot()) {
      if (record.boxId) journal.retireDeletedBoxCreate(record.boxId);
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("lists only sanitized managed boxes and keeps an owned legacy Box discoverable", async () => {
    const botId = "current-bot-123";
    boxes = [
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

    const inventory = await box.listManagedBoxes(cfg, [{ botId, name: "Research", inUse: true }]);

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

  it("durably adopts an observed legacy Box before a later listing can omit it", async () => {
    const botId = "legacy-adoption";
    const boxId = "bx_3456789a";
    boxes = [{ id: boxId, name: legacyNameFor(botId), state: "ready" }];

    expect((await box.listManagedBoxes(cfg, [{ botId, name: "Legacy", inUse: false }])).available).toBe(true);
    // Refreshing the same provider row must not grow the ownership journal.
    expect((await box.listManagedBoxes(cfg, [{ botId, name: "Legacy", inUse: false }])).available).toBe(true);
    expect(journal.boxCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
      { botId, boxId, resolved: true },
    ]);

    boxes = [];
    expect((await box.listManagedBoxes(cfg, [{ botId, name: "Legacy", inUse: false }])).instances).toEqual([]);
    expect(journal.boxCreateRecoverySnapshot().filter((record) => record.botId === botId)).toEqual([
      { botId, boxId, resolved: true },
    ]);
  });

  it("can compare a replacement account without adopting its legacy identities", async () => {
    const botId = "replacement-probe";
    boxes = [{ id: "bx_789abcde", name: legacyNameFor(botId), state: "ready" }];

    const inventory = await box.listManagedBoxes(
      cfg,
      [{ botId, name: "Replacement", inUse: false }],
      { adoptLegacy: false },
    );

    expect(inventory.available).toBe(true);
    expect(inventory.instances).toEqual([
      expect.objectContaining({ boxId: "bx_789abcde", ownerBotId: botId }),
    ]);
    expect(journal.boxCreateRecoverySnapshot().some((record) => record.botId === botId)).toBe(false);
  });

  it("recognizes adopted legacy names when restoring their account credential", async () => {
    const botId = "legacy-credential";
    expect(await box.boxNameMatchesBot(botId, await box.boxNameFor(botId))).toBe(true);
    expect(await box.boxNameMatchesBot(botId, legacyNameFor(botId))).toBe(true);
    expect(await box.boxNameMatchesBot(botId, "provider-owned-box")).toBe(false);
  });

  it("fails closed for malformed or conflicting identities that name this installation", async () => {
    const botId = "invalid-owned";
    const currentName = await box.boxNameFor(botId);
    boxes = [{ id: "bad/id", name: currentName, state: "ready" }];

    const malformed = await box.listManagedBoxes(cfg, [{ botId, name: "Invalid", inUse: false }]);
    expect(malformed).toMatchObject({ configured: true, available: false, instances: [] });
    expect(malformed.problem).toMatch(/invalid id/i);

    boxes = [
      { id: "bx_456789ab", name: currentName, state: "ready" },
      { id: "bx_456789ab", name: "provider-duplicate", state: "ready" },
    ];
    const conflicting = await box.listManagedBoxes(cfg, [{ botId, name: "Invalid", inUse: false }]);
    expect(conflicting).toMatchObject({ configured: true, available: false, instances: [] });
    expect(conflicting.problem).toMatch(/conflicting id/i);
  });

  it("does not cache or use a malformed exact-name Box identity", async () => {
    const botId = "invalid-find";
    boxes = [{ id: "not-a-box", name: await box.boxNameFor(botId), state: "ready" }];

    await expect(box.findBox(cfg, botId)).rejects.toThrow(/invalid cloud computer identity/i);
  });

  it("shows current-install orphans but hides foreign and ownerless legacy Boxes", async () => {
    const currentBotId = "scoped-owner";
    const legacyBotId = "legacy-owner";
    const currentName = await box.boxNameFor(currentBotId);
    const orphanName = await box.boxNameFor("deleted-local-bot");
    const currentScope = currentName.match(/^ogb-([a-f0-9]{12})-/)?.[1];
    expect(currentScope).toBeTruthy();
    const foreignScope = currentScope === "000000000000" ? "111111111111" : "000000000000";
    const foreignName = currentName.replace(/^ogb-[a-f0-9]{12}-/, `ogb-${foreignScope}-`);
    const ownerlessLegacyName = "ogb-orphaned-abcdef";
    boxes = [
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

    const inventory = await box.listManagedBoxes(cfg, owners);

    expect(inventory.instances).toHaveLength(3);
    expect(inventory.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ boxId: "bx_23456789", ownerBotId: currentBotId, orphaned: false }),
      expect.objectContaining({ boxId: "bx_abcdefgh", ownerBotId: legacyBotId, orphaned: false }),
      expect.objectContaining({ boxId: "bx_jkmnpqrs", ownerBotId: null, orphaned: true }),
    ]));
    expect(inventory.instances.some((instance) => instance.name === foreignName)).toBe(false);
    expect(inventory.instances.some((instance) => instance.name === ownerlessLegacyName)).toBe(false);

    requests.length = 0;
    await expect(box.deleteManagedBox(cfg, owners, "bx_mnpqrstu", foreignName)).rejects.toThrow(/no longer exists/);
    await expect(
      box.deleteManagedBox(cfg, owners, "bx_npqrstuv", ownerlessLegacyName),
    ).rejects.toThrow(/no longer exists/);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("walks cursor pages once and refuses a repeated cursor instead of looping", async () => {
    const botId = "second-page-owner";
    pageResponses = new Map([
      ["", { boxes: [{ id: "foreign", name: "unmanaged", state: "ready" }], nextCursor: "page two/?=" }],
      ["page two/?=", { boxes: [{ id: "bx_mnpqrstu", name: legacyNameFor(botId), state: "idle" }], nextCursor: null }],
    ]);

    const inventory = await box.listManagedBoxes(cfg, [{ botId, name: "Page two", inUse: false }]);
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
    const loop = await box.listManagedBoxes(cfg, []);
    expect(loop).toMatchObject({ configured: true, available: false, instances: [] });
    expect(loop.problem).toMatch(/repeated.*cursor/i);
    expect(requests).toHaveLength(2);
  });

  it("distinguishes not configured and provider failure from an empty account", async () => {
    const unconfigured = await box.listManagedBoxes({} as any, []);
    expect(unconfigured).toEqual({ configured: false, available: false, problem: null, instances: [] });
    expect(requests).toHaveLength(0);

    listStatus = 503;
    listBody = { ok: false, message: "maintenance" };
    const unavailable = await box.listManagedBoxes(cfg, []);
    expect(unavailable).toMatchObject({ configured: true, available: false, instances: [] });
    expect(unavailable.problem).toMatch(/maintenance/);

    listStatus = 200;
    listBody = { ok: true, boxes: [] };
    expect(await box.listManagedBoxes(cfg, [])).toMatchObject({ configured: true, available: true, instances: [] });
  });

  it("revalidates ownership before sleep and surfaces a provider refusal", async () => {
    const botId = "sleeping-owner";
    boxes = [{ id: "bx_tuvwxyz2", name: legacyNameFor(botId), state: "ready" }];
    const owners = [{ botId, name: "Sleeper", inUse: false }];

    await box.sleepManagedBox(cfg, owners, "bx_tuvwxyz2");
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/box/v1/boxes",
      "POST /api/box/v1/boxes/bx_tuvwxyz2/commands",
      "POST /api/box/v1/boxes/bx_tuvwxyz2/stop",
    ]);

    requests.length = 0;
    stopStatus = 500;
    await expect(box.sleepManagedBox(cfg, owners, "bx_tuvwxyz2")).rejects.toThrow(/box sleep failed: stop refused/);
    expect(requests.some((request) => request.path.endsWith("/resume"))).toBe(false);
    expect(requests.some((request) => request.path.endsWith("/desktop"))).toBe(false);

    boxes = [{ id: "bx_tuvwxyz2", name: legacyNameFor(botId), state: "provisioning" }];
    requests.length = 0;
    await expect(box.sleepManagedBox(cfg, owners, "bx_tuvwxyz2")).rejects.toThrow(/cannot sleep while it is provisioning/);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("requires fresh exact confirmation for deletion and clears a cached owner id", async () => {
    const botId = "delete-owner";
    const managedName = legacyNameFor(botId);
    boxes = [{ id: "bx_3456789a", name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Disposable", inUse: false }];
    const journal = await import("./box-create-idempotency.ts");
    const attempt = journal.beginBoxCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoxCreate(journal.rememberCreatedBox(attempt.request, "bx_3456789a"));

    await box.findBox(cfg, botId);
    requests.length = 0;
    await expect(box.deleteManagedBox(cfg, owners, "bx_3456789a", "stale-name")).rejects.toThrow(
      /confirmation no longer matches/,
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(journal.boxCreateRecoverySnapshot()).toContainEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: true,
    });

    deleteStatus = 503;
    await expect(box.deleteManagedBox(cfg, owners, "bx_3456789a", managedName)).rejects.toThrow(/delete refused/);
    expect(journal.boxCreateRecoverySnapshot()).toContainEqual({
      botId,
      boxId: "bx_3456789a",
      resolved: true,
    });
    deleteStatus = 202;

    requests.length = 0;
    deletionStatuses = ["pending", "processing", "completed"];
    await box.deleteManagedBox(cfg, owners, "bx_3456789a", managedName);
    const removal = requests.find((request) => request.method === "DELETE");
    expect(removal?.path).toBe("/api/box/v1/boxes/bx_3456789a");
    expect(removal?.headers["x-ascii-confirm-delete"]).toBe("bx_3456789a");
    expect(requests.filter((request) => request.path.includes("/deletion-operations/"))).toHaveLength(2);
    expect(journal.boxCreateRecoverySnapshot().find((record) => record.botId === botId)).toBeUndefined();

    boxes = [];
    requests.length = 0;
    expect(await box.findBox(cfg, botId)).toBeNull();
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/api/box/v1/boxes",
      search: "?limit=200",
    });
  });

  it("keeps the durable Box receipt when background deletion becomes blocked", async () => {
    const botId = "blocked-delete-owner";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_456789ab";
    boxes = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Blocked", inUse: false }];
    const journal = await import("./box-create-idempotency.ts");
    const attempt = journal.beginBoxCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoxCreate(journal.rememberCreatedBox(attempt.request, boxId));
    deletionStatuses = ["pending", "blocked"];

    await expect(box.deleteManagedBox(cfg, owners, boxId, managedName)).rejects.toThrow(/deletion operation is blocked/i);
    expect(journal.boxCreateRecoverySnapshot()).toContainEqual({ botId, boxId, resolved: true });
  });

  it("retires the exact receipt when the Box disappears between revalidation and DELETE", async () => {
    const botId = "already-gone-owner";
    const managedName = legacyNameFor(botId);
    const boxId = "bx_56789abc";
    boxes = [{ id: boxId, name: managedName, state: "archived" }];
    const owners = [{ botId, name: "Gone", inUse: false }];
    const journal = await import("./box-create-idempotency.ts");
    const attempt = journal.beginBoxCreate(botId, JSON.stringify({ ttlSeconds: 7_200, noEnv: true }));
    journal.resolveBoxCreate(journal.rememberCreatedBox(attempt.request, boxId));
    deleteStatus = 404;

    await expect(box.deleteManagedBox(cfg, owners, boxId, managedName)).resolves.toEqual({ ok: true });
    expect(journal.boxCreateRecoverySnapshot().some((entry) => entry.botId === botId)).toBe(false);
  });

  it("finds an existing box on a later page and fails closed when listing is unavailable", async () => {
    const secondPageBot = "existing-second-page";
    pageResponses = new Map([
      ["", { boxes: [], nextCursor: "next" }],
      ["next", {
        boxes: [{ id: "bx_npqrstuv", name: legacyNameFor(secondPageBot), state: "ready" }],
        nextCursor: null,
      }],
    ]);

    await expect(box.findBox(cfg, secondPageBot)).resolves.toMatchObject({ id: "bx_npqrstuv" });
    expect(requests.map((request) => request.search)).toEqual([
      "?limit=200",
      "?limit=200&cursor=next",
    ]);
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes"))).toBe(false);

    requests.length = 0;
    pageResponses = null;
    listStatus = 503;
    listBody = { ok: false, message: "maintenance" };
    await expect(box.provisionBox(cfg, "provider-down-bot", "Offline")).rejects.toThrow(/maintenance/);
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/boxes"))).toBe(false);
  });

  it("does not mutate a missing or busy managed box and reports delete failures", async () => {
    const botId = "busy-owner";
    const managedName = legacyNameFor(botId);
    const owners = [{ botId, name: "Busy", inUse: true }];

    await expect(box.deleteManagedBox(cfg, owners, "bx_456789ab", managedName)).rejects.toThrow(/no longer exists/);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    boxes = [{ id: "bx_56789abc", name: managedName, state: "running" }];
    requests.length = 0;
    await expect(box.sleepManagedBox(cfg, owners, "bx_56789abc")).rejects.toThrow(/in use/);
    expect(requests.every((request) => request.method === "GET")).toBe(true);

    requests.length = 0;
    deleteStatus = 500;
    await expect(box.deleteManagedBox(cfg, [{ ...owners[0], inUse: false }], "bx_56789abc", managedName)).rejects.toThrow(
      /box delete failed: delete refused/,
    );
  });
});
