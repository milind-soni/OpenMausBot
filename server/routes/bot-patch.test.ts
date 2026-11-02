// The relocation guard's scan is the only VPS call this route makes; the mocked scan stands in for SSH
// and lets each test mutate the store mid-scan deterministically.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WireBot } from "../../shared/wire.ts";
import { VPS_BOT_ALIAS_CHANGE_ERROR, VPS_BOT_ALIAS_LIFECYCLE_ERROR, VPS_BOT_ALIAS_RESOURCES_ERROR } from "../cloud-backend.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import type { ManagedVpsInventory } from "../vps-computer.ts";
import { createBotPatchRoutes, type BotPatchRouteDeps } from "./bot-patch.ts";
import { PASS, type RouteContext } from "./table.ts";

vi.mock("../vps-computer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vps-computer.ts")>();
  return { ...actual, listManagedVpsComputers: vi.fn(), vpsLifecycleBusy: vi.fn() };
});

const scan = vi.mocked(vps.listManagedVpsComputers);
const lifecycleBusy = vi.mocked(vps.vpsLifecycleBusy);
const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };

const emptyInventory = (): ManagedVpsInventory => ({
  configured: true,
  available: true,
  vpsAliases: ["production-vps"],
  problem: null,
  instances: [],
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  scan.mockReset();
  scan.mockResolvedValue(emptyInventory());
  lifecycleBusy.mockReset();
  lifecycleBusy.mockReturnValue(false);
});

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" });
  const cfg = { vps: { sshAlias: "production-vps" } } as AppConfig;
  const activeVpsThreads = new Set<string>();
  // Only what a vpsAlias patch touches; any other dependency is absent, and a route that reached for one would throw.
  const deps = {
    store,
    cfg,
    requestedTaskBot: () => null,
    activeVpsThreads,
    wireBot: (record: BotRecord) => record as unknown as WireBot,
    broadcast: () => {},
    audienceChanged: () => {},
    assertTeamComputerChangeIdle: () => {},
    routines: () => null,
    // A member's session may chat with this bot: the level that still can't move it or change what it may do.
    levelOf: () => "chat",
  } as unknown as BotPatchRouteDeps;
  const handler = createBotPatchRoutes(deps);
  const patch = async (botId: string, body: Record<string, unknown>, as: { auth?: RequestAuth; headers?: Record<string, string> } = {}) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: as.headers ?? {} } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/bots/${botId}`),
      path: `/api/bots/${botId}`,
      method: "PATCH",
      auth: as.auth ?? ({ kind: "loopback", scopes: ["admin"] } as RequestAuth),
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { store, bot, activeVpsThreads, patch };
}

describe("PATCH /api/bots/:id vpsAlias relocation guard", () => {
  it("skips the guard when pinning a bot to the host it already uses", async () => {
    const { bot, patch } = fixture();

    const pinned = await patch(bot.id, { vpsAlias: "production-vps" });

    expect(pinned.status).toBe(200);
    expect(pinned.body.bot.vpsAlias).toBe("production-vps");
    expect(scan).not.toHaveBeenCalled();
  });

  it("skips the guard when clearing an override equal to the default", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { vpsAlias: "production-vps" });

    const cleared = await patch(bot.id, { vpsAlias: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.vpsAlias).toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
  });

  it("still scans a real move and refuses a busy bot before scanning", async () => {
    const { store, bot, patch } = fixture();

    const moved = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(moved.status).toBe(200);
    expect(moved.body.bot.vpsAlias).toBe("gamma-vps");
    expect(moved.body.notice).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0]?.[0]).toEqual({ vps: { sshAlias: "production-vps" } });

    store.patchBot(bot.id, { busy: true });
    const refused = await patch(bot.id, { vpsAlias: "delta-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("moves a bot off a server that cannot be reached, and says what may be left there", async () => {
    const { store, bot, patch } = fixture();
    scan.mockResolvedValue({
      ...emptyInventory(),
      available: false,
      problem: "Docker over SSH could not list managed computers on production-vps: ssh: Could not resolve hostname production-vps",
    });

    const moved = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
    expect(moved.body.notice).toContain("production-vps could not be reached");
    expect(moved.body.notice).toContain(`docker -H ssh://production-vps rm -f ${vps.vpsContainerName(bot.id)}`);
  });

  it("never lets a member's session or a paired phone choose a bot's server", async () => {
    const { store, bot, patch } = fixture();
    const member = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s", label: "Laptop", scopes: ["client"] } } as unknown as RequestAuth;

    const fromMember = await patch(bot.id, { vpsAlias: "gamma-vps" }, { auth: member });
    const fromPhone = await patch(bot.id, { vpsAlias: "gamma-vps" }, { headers: { "x-openmausbot-companion": "1" } });

    expect(fromMember.status).toBe(403);
    expect(fromMember.body.error).toMatch(/not "vpsAlias"/);
    expect(fromPhone.status).toBe(403);
    expect(fromPhone.body.error).toMatch(/not "vpsAlias"/);
    expect(scan).not.toHaveBeenCalled();
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("still refuses the move while the bot's computer lives on the old server", async () => {
    const { bot, patch } = fixture();
    scan.mockResolvedValue({
      ...emptyInventory(),
      instances: [{
        name: vps.vpsContainerName(bot.id),
        state: "running",
        vpsAlias: "production-vps",
        ownerBotId: bot.id,
        ownerName: bot.name,
        orphaned: false,
        inUse: false,
      }],
    });

    const blocked = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe(VPS_BOT_ALIAS_RESOURCES_ERROR);
  });

  it("refuses while a VPS computer action is still running, before or during the scan", async () => {
    const { store, bot, patch } = fixture();
    lifecycleBusy.mockReturnValue(true);

    const before = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(before.status).toBe(409);
    expect(before.body.error).toBe(VPS_BOT_ALIAS_LIFECYCLE_ERROR);
    expect(scan).not.toHaveBeenCalled();

    lifecycleBusy.mockReturnValue(false);
    scan.mockImplementation(async () => {
      lifecycleBusy.mockReturnValue(true);
      return emptyInventory();
    });
    const during = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(during.status).toBe(409);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("rescans when the stored alias changes mid-scan", async () => {
    const { store, bot, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { vpsAlias: "delta-vps" });
      return emptyInventory();
    });

    const moved = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(moved.status).toBe(200);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(store.bot(bot.id)?.vpsAlias).toBe("gamma-vps");
  });

  it("refuses when a turn starts mid-scan and keeps the stored alias", async () => {
    const { store, bot, activeVpsThreads, patch } = fixture();
    scan.mockImplementationOnce(async () => {
      store.patchBot(bot.id, { busy: true });
      activeVpsThreads.add(bot.id);
      return emptyInventory();
    });

    const refused = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(store.bot(bot.id)?.vpsAlias).toBeUndefined();
  });

  it("gives up after three unstable attempts", async () => {
    const { store, bot, patch } = fixture();
    let flip = false;
    scan.mockImplementation(async () => {
      flip = !flip;
      store.patchBot(bot.id, { vpsAlias: flip ? "delta-vps" : "epsilon-vps" });
      return emptyInventory();
    });

    const refused = await patch(bot.id, { vpsAlias: "gamma-vps" });

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
    expect(scan).toHaveBeenCalledTimes(3);
  });
});

describe("PATCH /api/bots/:id phoneApps", () => {
  it("stores phoneApps and clears it with null", async () => {
    const { store, bot, patch } = fixture();

    const stored = await patch(bot.id, { phoneApps: { calendar: "read", location: "write" } });

    expect(stored.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read", location: "write" });

    const cleared = await patch(bot.id, { phoneApps: null });

    expect(cleared.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });

  it("rejects an unknown capability or grant", async () => {
    const { store, bot, patch } = fixture();
    const error = "phoneApps must be { <calendar|reminders|contacts|location|home|messages>: read | write } or null";

    const unknownApp = await patch(bot.id, { phoneApps: { camera: "read" } });
    const unknownGrant = await patch(bot.id, { phoneApps: { calendar: "admin" } });

    expect(unknownApp.status).toBe(400);
    expect(unknownApp.body.error).toBe(error);
    expect(unknownGrant.status).toBe(400);
    expect(unknownGrant.body.error).toBe(error);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });

  it("treats a raised phone grant as loosening", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { phoneApps: { calendar: "read" } });
    store.patchBot(bot.id, { busy: true });

    const raised = await patch(bot.id, { phoneApps: { calendar: "write" } });
    const added = await patch(bot.id, { phoneApps: { calendar: "read", contacts: "read" } });

    expect(raised.status).toBe(409);
    expect(added.status).toBe(409);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read" });

    const narrowed = await patch(bot.id, { phoneApps: {} });

    expect(narrowed.status).toBe(200);
  });

  it("treats clearing a narrower grant as loosening on any bot, since the default is every app", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { phoneApps: { calendar: "read" } });
    store.patchBot(bot.id, { busy: true });

    const cleared = await patch(bot.id, { phoneApps: null });
    store.patchBot(bot.id, { chiefOfStaff: true });
    const clearedOnChief = await patch(bot.id, { phoneApps: null });

    expect(cleared.status).toBe(409);
    expect(clearedOnChief.status).toBe(409);
    expect(store.bot(bot.id)?.phoneApps).toEqual({ calendar: "read" });
  });

  it("treats switching every app off from the default as tightening", async () => {
    const { store, bot, patch } = fixture();
    store.patchBot(bot.id, { busy: true });

    const off = await patch(bot.id, { phoneApps: {} });

    expect(off.status).toBe(200);
    expect(store.bot(bot.id)?.phoneApps).toEqual({});
  });

  it("refuses a client session and a paired device", async () => {
    const { store, bot, patch } = fixture();

    const client = await patch(bot.id, { phoneApps: { calendar: "write" } }, { auth: { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s-member", email: "member@example.com", label: "Front desk" } } as unknown as RequestAuth });
    const paired = await patch(bot.id, { phoneApps: { calendar: "write" } }, { headers: { "x-openmausbot-companion": "1" } });

    expect(client.status).toBe(403);
    expect(paired.status).toBe(403);
    expect(store.bot(bot.id)?.phoneApps).toBeUndefined();
  });
});
