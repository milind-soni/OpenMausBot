import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { routeGraphRuntimeEvent, routeStalledTurn } from "./agent-graph-lifecycle.ts";

function permissionEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    eventId: "event-1",
    provider: "claudeAgent",
    providerInstanceId: "claude",
    threadId: "graph-thread",
    turnId: "turn-1",
    turnToken: "token-1",
    createdAt: new Date(0).toISOString(),
    type: "request.opened",
    requestType: "permission",
    requestId: "request-1",
    tool: "filesystem_read",
    summary: "Read the approved workspace",
    ...overrides,
  } as RuntimeEvent;
}

describe("agent graph lifecycle routing", () => {
  it("requires the event token and exact graph-manager acceptance before permission response and projection", () => {
    const order: string[] = [];
    const graphOwner = { id: "graph-1" };
    const graphAcceptance = { id: "graph-1", revision: 4 };
    const event = permissionEvent();

    const routed = routeGraphRuntimeEvent(event, {
      graphOwner,
      eventTokenMatches: () => {
        order.push("token");
        return true;
      },
      acceptGraphRuntimeEvent: () => {
        order.push("manager");
        return graphAcceptance;
      },
      respondToPermission: (_permission, context) => {
        order.push("permission");
        expect(context.graphAcceptance).toBe(graphAcceptance);
      },
      foldProjection: (_runtimeEvent, context) => {
        order.push("projection");
        expect(context.graphAcceptance).toBe(graphAcceptance);
      },
    });

    expect(routed).toEqual({
      routed: true,
      reason: null,
      graphOwner,
      graphAcceptance,
    });
    expect(order).toEqual(["token", "manager", "permission", "projection"]);

    for (const rejected of [
      { token: false, manager: graphAcceptance, reason: "turn-token-rejected" },
      { token: true, manager: null, reason: "graph-manager-rejected" },
    ] as const) {
      const rejectedOrder: string[] = [];
      const result = routeGraphRuntimeEvent(event, {
        graphOwner,
        eventTokenMatches: () => {
          rejectedOrder.push("token");
          return rejected.token;
        },
        acceptGraphRuntimeEvent: () => {
          rejectedOrder.push("manager");
          return rejected.manager;
        },
        respondToPermission: () => rejectedOrder.push("permission"),
        foldProjection: () => rejectedOrder.push("projection"),
      });
      expect(result).toMatchObject({ routed: false, reason: rejected.reason, graphAcceptance: null });
      expect(rejectedOrder).toEqual(rejected.token ? ["token", "manager"] : ["token"]);
    }

    const ordinaryOrder: string[] = [];
    const ordinary = routeGraphRuntimeEvent(permissionEvent({ threadId: "ordinary-thread", turnToken: undefined }), {
      graphOwner: null as { id: string } | null,
      eventTokenMatches: () => {
        ordinaryOrder.push("token");
        return false;
      },
      acceptGraphRuntimeEvent: () => {
        ordinaryOrder.push("manager");
        return graphAcceptance;
      },
      respondToPermission: () => ordinaryOrder.push("permission"),
      foldProjection: () => ordinaryOrder.push("projection"),
    });
    expect(ordinary).toMatchObject({ routed: true, graphOwner: null, graphAcceptance: null });
    expect(ordinaryOrder).toEqual(["permission", "projection"]);
  });

  it("cancels graph-owned stalls and ordinary-interrupts only non-graph stalls", async () => {
    const graph = { id: "graph-1" };
    const cancelGraph = vi.fn(async () => {});
    const interruptOrdinaryTurn = vi.fn(async () => {});

    await expect(routeStalledTurn(
      { botId: "bot-1", threadId: "graph-thread" },
      {
        graphOwnerForThread: () => graph,
        cancelGraph,
        interruptOrdinaryTurn,
      },
    )).resolves.toEqual({ route: "graph-cancel", graphOwner: graph });
    expect(cancelGraph).toHaveBeenCalledOnce();
    expect(cancelGraph).toHaveBeenCalledWith(graph, { botId: "bot-1", threadId: "graph-thread" });
    expect(interruptOrdinaryTurn).not.toHaveBeenCalled();

    cancelGraph.mockClear();
    await expect(routeStalledTurn(
      { botId: "bot-2", threadId: "ordinary-thread" },
      {
        graphOwnerForThread: () => null,
        cancelGraph,
        interruptOrdinaryTurn,
      },
    )).resolves.toEqual({ route: "ordinary-interrupt", graphOwner: null });
    expect(cancelGraph).not.toHaveBeenCalled();
    expect(interruptOrdinaryTurn).toHaveBeenCalledOnce();
    expect(interruptOrdinaryTurn).toHaveBeenCalledWith({ botId: "bot-2", threadId: "ordinary-thread" });
  });
});
