import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createBurstProposalRoutes, createBurstRoutes, type BurstProposalDeps, type BurstRoutesDeps } from "./burst.ts";
import { PASS, type RouteContext } from "./table.ts";

const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;

function ctx(path: string, method: string, body?: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const context = { req: {} as RouteContext["req"], res: {} as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
    readBody: (async () => body) as unknown as RouteContext["readBody"] } as RouteContext;
  return { context, sent };
}

function deps(over: Partial<BurstRoutesDeps> = {}): BurstRoutesDeps {
  const card = { burstId: "b1" } as never;
  return { owner: () => ({ botId: "bot", threadId: "t" }), sees: () => true, refusal: () => null, view: () => ({ burstId: "b1" }), run: () => card, cancel: () => card, retry: () => card, edit: () => card, ...over };
}

describe("burst card routes", () => {
  it("passes other paths", async () => {
    const { context } = ctx("/api/bots", "GET");
    expect(await createBurstRoutes(deps())(context)).toBe(PASS);
  });

  it("answers 404 to someone who can't see the chat", async () => {
    const { context, sent } = ctx("/api/bursts/b1/run", "POST");
    await createBurstRoutes(deps({ sees: () => false, run: () => { throw new Error("must not run"); } }))(context);
    expect(sent.status).toBe(404);
  });

  it("refuses a press from someone who may not answer this chat's cards", async () => {
    const { context, sent } = ctx("/api/bursts/b1/run", "POST");
    await createBurstRoutes(deps({ refusal: () => "Only the owner of this Cloud can answer this card.", run: () => { throw new Error("must not run"); } }))(context);
    expect(sent).toEqual({ status: 403, body: { error: "Only the owner of this Cloud can answer this card." } });
  });

  it("runs, cancels and retries on a press", async () => {
    const pressed: string[] = [];
    const routes = createBurstRoutes(deps({ run: () => { pressed.push("run"); return {} as never; }, cancel: () => { pressed.push("cancel"); return {} as never; }, retry: () => { pressed.push("retry"); return {} as never; } }));
    for (const action of ["run", "cancel", "retry"]) await routes(ctx(`/api/bursts/b1/${action}`, "POST").context);
    expect(pressed).toEqual(["run", "cancel", "retry"]);
  });

  it("sends a refusal back as a conflict", async () => {
    const { context, sent } = ctx("/api/bursts/b1/run", "POST");
    await createBurstRoutes(deps({ run: () => ({ refused: "This burst has already started." }) }))(context);
    expect(sent).toEqual({ status: 409, body: { error: "This burst has already started." } });
  });

  it("validates an edit", async () => {
    const edits: unknown[] = [];
    const routes = createBurstRoutes(deps({ edit: (_id, plan) => { edits.push(plan); return {} as never; } }));
    const good = ctx("/api/bursts/b1/edit", "POST", { items: ["a", "b"], instructions: "x" });
    await routes(good.context);
    expect(edits).toEqual([{ items: ["a", "b"], instructions: "x" }]);
    const bad = ctx("/api/bursts/b1/edit", "POST", { items: [""] });
    await routes(bad.context);
    expect(bad.sent.status).toBe(400);
  });

  it("reads the rows for the card", async () => {
    const { context, sent } = ctx("/api/bursts/b1", "GET");
    await createBurstRoutes(deps())(context);
    expect(sent.body).toEqual({ burstId: "b1" });
  });
});

describe("the burst tool's route", () => {
  const base: BurstProposalDeps = {
    requireActive: () => {}, refusal: () => null, readBody: async () => ({ task: "t", instructions: "i", items: ["a", "b"] }),
    model: () => ({ selection: { instanceId: "i", model: "m" }, name: "m" }), propose: () => ({ burstId: "b1" }) as never,
  };

  it("shows a preview and nothing else: it can't start a burst", async () => {
    const { context, sent } = ctx("/api/internal/bursts", "POST");
    await createBurstProposalRoutes(base)(context);
    expect(sent).toEqual({ status: 201, body: { burstId: "b1" } });
  });

  it("refuses a room or a hand-off", async () => {
    const { context, sent } = ctx("/api/internal/bursts", "POST");
    await createBurstProposalRoutes({ ...base, refusal: () => "A burst runs from a bot's own chat, not a room." })(context);
    expect(sent.status).toBe(403);
  });

  it("refuses a malformed proposal", async () => {
    const { context, sent } = ctx("/api/internal/bursts", "POST");
    await createBurstProposalRoutes({ ...base, readBody: async () => ({ task: "t" }) })(context);
    expect(sent.status).toBe(400);
  });
});
