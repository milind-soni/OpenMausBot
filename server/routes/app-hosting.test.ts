import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AppPublisher } from "../host/app-publisher.ts";
import { outsideRouteRefused } from "../host/outside-fence.ts";
import { createAppHostingInternalRoutes, type AppHostingContext } from "./app-hosting.ts";
import { PASS } from "./table.ts";

function fakePublisher() {
  return {
    publish: vi.fn(async () => ({ status: 200 as const, body: { ok: true, url: "https://mb-1.netlify.app/", live: true } })),
    status: vi.fn(async () => ({ status: 200 as const, body: { ok: true, apps: "3 of 10" } })),
    remove: vi.fn(async () => ({ status: 409 as const, body: { error: "Nothing is published from this folder on the plan's included hosting.", code: "not_found" } })),
    removeByKey: vi.fn(async () => {}),
  } satisfies AppPublisher;
}

async function call(publisher: AppPublisher, input: { path?: string; method?: string; body?: unknown; vmWorkspace?: string | null } = {}) {
  const sent: { status?: number; body?: any } = {};
  const json = ((_res: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as AppHostingContext["json"];
  const out = await createAppHostingInternalRoutes(publisher)({ method: input.method ?? "POST", path: input.path ?? "/api/internal/apps/publish", res: {} as AppHostingContext["res"], json, botId: "bot-1",
    readBody: async () => input.body ?? {}, folders: async () => ({ roots: ["/work/bot-1"], vmWorkspace: input.vmWorkspace ?? null }) });
  return { out, ...sent };
}

describe("publish_app's internal route", () => {
  it("passes requests that are not its own", async () => {
    expect((await call(fakePublisher(), { path: "/api/internal/pages/publish" })).out).toBe(PASS);
    expect((await call(fakePublisher(), { method: "GET" })).out).toBe(PASS);
  });

  it("publishes as the capability's own bot from its own folders, whatever the body says", async () => {
    const publisher = fakePublisher();
    const answer = await call(publisher, { body: { path: "shop/dist", project: "shop", title: "Shop", botId: "someone-else", roots: ["/"] } });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, live: true } });
    expect(publisher.publish).toHaveBeenCalledWith({ botId: "bot-1", roots: ["/work/bot-1"], path: "shop/dist", project: "shop", title: "Shop" });
  });

  it("answers status with or without a folder, and delete only with one", async () => {
    const publisher = fakePublisher();
    expect((await call(publisher, { body: { action: "status" } })).body).toEqual({ ok: true, apps: "3 of 10" });
    expect(publisher.status).toHaveBeenLastCalledWith({ botId: "bot-1", roots: ["/work/bot-1"] });
    await call(publisher, { body: { action: "status", path: "shop" } });
    expect(publisher.status).toHaveBeenLastCalledWith({ botId: "bot-1", roots: ["/work/bot-1"], path: "shop" });
    expect(await call(publisher, { body: { action: "delete", path: "shop" } })).toMatchObject({ status: 409, body: { code: "not_found" } });
    expect(publisher.remove).toHaveBeenCalledWith({ botId: "bot-1", roots: ["/work/bot-1"], path: "shop" });
    for (const body of [{ action: "delete" }, {}, { action: "publish", path: "  " }]) {
      expect((await call(publisher, { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(publisher.remove).toHaveBeenCalledTimes(1);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("refuses a body that is not the tool's, before anything is read", async () => {
    const publisher = fakePublisher();
    for (const body of [{ action: "make-public", path: "shop" }, { path: 5 }, { path: "x".repeat(5000) }, { path: "shop", title: ["a"] }]) {
      expect(await call(publisher, { body }), JSON.stringify(body).slice(0, 60)).toMatchObject({ status: 400, body: { error: "publish_app takes action (publish or delete), path, project and title, all text." } });
    }
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("reads a path in the bot's Local VM workspace as the same folder on this computer", async () => {
    const publisher = fakePublisher(), vmWorkspace = join("/data", "vm", "bot-1");
    await call(publisher, { body: { path: "/home/cua/workspace/shop", title: "Shop" }, vmWorkspace });
    expect(publisher.publish).toHaveBeenCalledWith({ botId: "bot-1", roots: [vmWorkspace, "/work/bot-1"], path: join(vmWorkspace, "shop"), title: "Shop" });
  });

  it("is closed to a turn that came in from outside", () => {
    expect(outsideRouteRefused("POST", "/api/internal/apps/publish")).toBe(true);
  });
});
