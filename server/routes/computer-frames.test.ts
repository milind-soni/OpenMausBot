import { describe, expect, it } from "vitest";
import { createComputerFrames } from "../computer-frames.ts";
import { createComputerFramesRoutes, frameForCaller, mapComputers, parseHave } from "./computer-frames.ts";
import { PASS } from "./table.ts";

const bots = [
  { id: "ada", name: "Ada", section: "Research", computer: "cloud" as const },
  { id: "ben", name: "Ben", section: "Research" },
  { id: "cy", name: "Cy", section: "Design" },
  { id: "dee", name: "Dee", section: "Design", computer: "cloud" as const, cloudBackend: "vps" as const },
  { id: "eve", name: "Eve", section: "Design", computer: "cloud" as const, hidden: true },
  { id: "fay", name: "Fay", section: "Ops" },
  { id: "gus", name: "Gus", section: "Ops", computer: "off" as const },
];
const teamComputers = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Design desktop", section: "Design" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Spare", section: null },
];

describe("map computers", () => {
  it("draws a bot's own cloud computer and one shared node per team computer", () => {
    const machines = new Map([["gus", { owner: "gus", boxId: "bx_g", state: "archived" }]]);
    const nodes = mapComputers({ bots, teamComputers, machine: (owner) => machines.get(owner), working: () => false });
    expect(nodes).toEqual([
      { id: "ada", kind: "bot", name: "Ada", botIds: ["ada"], state: "off" },
      { id: "gus", kind: "bot", name: "Gus", botIds: ["gus"], state: "asleep" },
      { id: "computer_11111111-1111-4111-8111-111111111111", kind: "team", name: "Design desktop", section: "Design", botIds: ["cy"], state: "off" },
    ]);
  });

  it("reads the have list and sends a turn frame only to a caller without any frame", () => {
    expect([...parseHave("ada:map-5,computer_x:turn-9,bad")]).toEqual([["ada", "map-5"], ["computer_x", "turn-9"]]);
    const turn = { data: "big", mime: "image/jpeg", at: 9, source: "turn" as const, version: "turn-9" };
    const map = { data: "small", mime: "image/jpeg", at: 10, source: "map" as const, version: "map-10" };
    expect(frameForCaller(turn, undefined).data).toBe("big");
    expect(frameForCaller(turn, "map-3").data).toBeUndefined();
    expect(frameForCaller(map, "turn-9").data).toBe("small");
    expect(frameForCaller(map, "map-10").data).toBeUndefined();
  });
});

describe("GET /api/computers/frames", () => {
  const request = async (handler: ReturnType<typeof createComputerFramesRoutes>, path = "/api/computers/frames", have = "") => {
    let body: any;
    const res = { setHeader: () => {} } as any;
    const out = await handler({
      res, url: new URL(`http://127.0.0.1${path}?have=${encodeURIComponent(have)}`), path, method: "GET",
      json: ((_res: unknown, _status: number, value: unknown) => { body = value; }) as any,
    } as any);
    return { out, body };
  };

  it("lists computers without asking the provider when no Boat account is connected", async () => {
    let lists = 0;
    const frames = createComputerFrames({
      listMachines: async () => { lists += 1; return []; },
      capture: async () => ({ data: "", mime: "image/jpeg" }), turnFrame: () => undefined,
      working: () => false, held: () => false, tickMs: 1e9,
    });
    const handler = createComputerFramesRoutes({
      cfg: {} as any, store: { bots } as any, teamComputers: { list: () => teamComputers as any },
      computerControl: { snapshot: () => ({ held: false }) } as any, computerProviderConfigTransitions: new Set(),
      managedBoatOwners: () => [], botHasActiveTurn: () => false, teamComputerInUse: () => false,
    }, frames);
    expect((await request(handler, "/api/other")).out).toBe(PASS);
    const { body } = await request(handler);
    expect(body.configured).toBe(false);
    expect(body.computers.map((computer: { id: string }) => computer.id)).toEqual(["ada", "computer_11111111-1111-4111-8111-111111111111"]);
    expect(lists).toBe(0);
    expect(frames.watching()).toBe(false);
  });
});
