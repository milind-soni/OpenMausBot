// The mocked removal stands in for docker-over-SSH: these tests pin which aliases may reach it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import { createComputerRoutes, type ComputerRouteDeps } from "./computers.ts";
import { PASS, type RouteContext } from "./table.ts";

vi.mock("../vps-computer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vps-computer.ts")>();
  return { ...actual, removeManagedVpsComputer: vi.fn() };
});

const remove = vi.mocked(vps.removeManagedVpsComputer);
const CONTAINER = "openmausbot-vps-test-abc123";

beforeEach(() => {
  remove.mockReset();
  remove.mockResolvedValue({ removed: true, name: CONTAINER });
});

function fixture(bots: BotRecord[], cfg: AppConfig) {
  // Only what the VPS remove endpoint touches; any other dependency is absent, and a route that reached for one would throw.
  const deps = {
    store: { bot: () => null, bots, sections: [] },
    cfg,
    computerProviderConfigTransitions: new Set(),
    managedBoatOwners: () => [],
    claimManagedVpsMutation: () => () => {},
    teamComputers: { list: () => [] },
    routines: () => null,
  } as unknown as ComputerRouteDeps;
  const handler = createComputerRoutes(deps);
  const postRemove = async (body: Record<string, unknown>) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: { "content-type": "application/json" } } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/computers/vps/${CONTAINER}/remove`),
      path: `/api/computers/vps/${CONTAINER}/remove`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { postRemove };
}

const cfgWith = (sshAlias: string): AppConfig => ({ vps: { sshAlias } }) as AppConfig;
const botWith = (vpsAlias?: string): BotRecord => ({ id: "bot-1", vpsAlias }) as BotRecord;

describe("POST /api/computers/vps/:name/remove", () => {
  it("refuses an alias no bot or default uses without touching SSH", async () => {
    const { postRemove } = fixture([botWith("alpha-vps")], cfgWith("production-vps"));

    const refused = await postRemove({ confirmName: CONTAINER, alias: "foreign-vps" });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/default server or a bot's own SSH alias/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("lets a bot's own alias and the default through to removal", async () => {
    const { postRemove } = fixture([botWith("alpha-vps")], cfgWith("production-vps"));

    const perBot = await postRemove({ confirmName: CONTAINER, alias: "alpha-vps" });

    expect(perBot.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({ vps: { sshAlias: "alpha-vps" } }, [], CONTAINER, CONTAINER);

    remove.mockClear();
    const fallback = await postRemove({ confirmName: CONTAINER, alias: "production-vps" });

    expect(fallback.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({ vps: { sshAlias: "production-vps" } }, [], CONTAINER, CONTAINER);
  });

  it("keeps using the default server when no alias is given", async () => {
    const cfg = cfgWith("production-vps");
    const { postRemove } = fixture([botWith("alpha-vps")], cfg);

    const removed = await postRemove({ confirmName: CONTAINER });

    expect(removed.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(cfg, [], CONTAINER, CONTAINER);
  });
});
