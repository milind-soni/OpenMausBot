import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createBotOrderRoutes } from "./bot-order.ts";
import { callRoute } from "./call-route.ts";
import { PASS, type RouteHandler } from "./table.ts";

const auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

describe("callRoute", () => {
  it("runs a real route with the given body and returns what it wrote", async () => {
    const bots = [{ id: "a" }, { id: "b" }];
    const route = createBotOrderRoutes({
      store: { bot: (id) => bots.find((bot) => bot.id === id) as never, bots: bots as never, reorderBots: (ids) => { bots.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); return bots as never; } },
      visibleFor: () => ({ bot: () => true }) as never,
    });
    expect(await callRoute(route, { method: "PUT", path: "/api/bots/order", body: { botIds: ["b", "a"] }, auth })).toEqual({ status: 200, body: { botIds: ["b", "a"] } });
    expect(bots.map((bot) => bot.id)).toEqual(["b", "a"]);
    expect(await callRoute(route, { method: "PUT", path: "/api/bots/order", body: { botIds: [] }, auth })).toMatchObject({ status: 400 });
  });

  it("reports a route that declines or answers nothing", async () => {
    const declines: RouteHandler = async () => PASS;
    expect(await callRoute(declines, { method: "GET", path: "/api/nothing", auth })).toMatchObject({ status: 404 });
    const silent: RouteHandler = async () => undefined;
    expect(await callRoute(silent, { method: "GET", path: "/api/quiet?x=1", auth })).toMatchObject({ status: 500 });
  });
});
