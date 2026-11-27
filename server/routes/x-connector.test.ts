import { describe, expect, it, vi } from "vitest";
import type { XIncludedUsage } from "../../shared/x-connector.ts";
import type { ServiceCredential } from "../included-services.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createXConnectorRoutes, type XConnectorDeps } from "./x-connector.ts";

const PLAN: ServiceCredential = { token: "omb_xd_plan_token", api: "https://cloud.example.test/api/cloud/services/x", included: true };
const OWN: ServiceCredential = { token: "treg_own_key", api: "https://treg.to", included: false };
const USAGE: XIncludedUsage = { calls: 312, max: 5_000, resetsAt: "2026-11-01T00:00:00.000Z" };

async function get(handler: ReturnType<typeof createXConnectorRoutes>, path = "/api/x/status", method = "GET") {
  const sent: { status?: number; body?: any } = {};
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    path: url.pathname, url, method,
    res: { setHeader: vi.fn() },
    json: (_res: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; },
  } as unknown as RouteContext;
  const out = await handler(ctx);
  return { out, ...sent };
}

function routes(own: ServiceCredential | null, plan: ServiceCredential | null, extra: Partial<XConnectorDeps> = {}) {
  const usage = vi.fn(async (_credential: ServiceCredential) => USAGE as XIncludedUsage | null);
  const handler = createXConnectorRoutes({ credential: () => own ?? plan, included: () => plan, unavailable: () => false, usage, ...extra });
  return { handler, usage };
}

describe("GET /api/x/status", () => {
  it("passes every other path and answers only GET", async () => {
    const { handler } = routes(null, PLAN);
    expect((await get(handler, "/api/x/statuses")).out).toBe(PASS);
    expect((await get(handler, "/api/internal/x/search")).out).toBe(PASS);
    expect(await get(handler, "/api/x/status", "POST")).toMatchObject({ status: 405 });
  });

  it("says the plan's included calls are used, with this month's count, when only the plan is held", async () => {
    const { handler, usage } = routes(null, PLAN);
    expect((await get(handler)).body).toEqual({ using: "included", ownKey: false, included: true, usage: USAGE });
    expect(usage).toHaveBeenCalledWith(PLAN);
  });

  it("says the person's own key is used first when both are held, and still reports the plan's month", async () => {
    const { handler } = routes(OWN, PLAN);
    expect((await get(handler)).body).toEqual({ using: "own", ownKey: true, included: true, usage: USAGE });
  });

  it("asks the relay nothing for an own key alone, and says no X with neither", async () => {
    const own = routes(OWN, null);
    expect((await get(own.handler)).body).toEqual({ using: "own", ownKey: true, included: false });
    expect(own.usage).not.toHaveBeenCalled();
    const none = routes(null, null, { unavailable: () => true });
    expect((await get(none.handler)).body).toEqual({ using: null, ownKey: false, included: false, unavailable: true });
    expect(none.usage).not.toHaveBeenCalled();
  });

  it("follows the credentials on every request: removing the own key falls back to the plan", async () => {
    let own: ServiceCredential | null = OWN;
    const handler = createXConnectorRoutes({ credential: () => own ?? PLAN, included: () => PLAN, unavailable: () => false, usage: async () => USAGE });
    expect((await get(handler)).body.using).toBe("own");
    own = null;
    expect((await get(handler)).body).toMatchObject({ using: "included", ownKey: false });
  });

  it("keeps the month's count for half a minute, asks again on refresh or for another token, and leaves it out when the relay can't say", async () => {
    let clock = 1_000_000;
    let plan: ServiceCredential = PLAN;
    const usage = vi.fn(async (): Promise<XIncludedUsage | null> => USAGE);
    const handler = createXConnectorRoutes({ credential: () => plan, included: () => plan, unavailable: () => false, usage, now: () => clock });
    await get(handler);
    clock += 29_000;
    await get(handler);
    expect(usage).toHaveBeenCalledTimes(1);
    await get(handler, "/api/x/status?refresh=1");
    expect(usage).toHaveBeenCalledTimes(2);
    clock += 31_000;
    await get(handler);
    expect(usage).toHaveBeenCalledTimes(3);
    plan = { ...PLAN, token: "omb_xd_new_token" };
    usage.mockResolvedValueOnce(null);
    expect((await get(handler)).body).toEqual({ using: "included", ownKey: false, included: true });
    expect(usage).toHaveBeenCalledTimes(4);
  });

  it("never names a key or a token", async () => {
    const { handler } = routes(OWN, PLAN);
    const text = JSON.stringify((await get(handler)).body);
    expect(text).not.toContain(OWN.token);
    expect(text).not.toContain(PLAN.token);
    expect(text).not.toContain(PLAN.api);
  });
});
