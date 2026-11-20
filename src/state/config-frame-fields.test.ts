// @vitest-environment happy-dom
// The real provider and its live stream: a config frame leaves the store holding what the server last said about each
// setting, whichever of GET, a PATCH answer or the frame said it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Action, AppState, ConfigStatus } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const settings = {
  xai: { configured: false }, anthropic: { configured: true }, composio: { configured: false }, box: { configured: false },
  vps: { configured: false, sshAlias: "" }, rooms: { turnTimeoutMinutes: 10 }, mcp: { callTimeoutMinutes: 5 }, threads: { maxConcurrentPerBot: 1 },
  localVm: { mode: "shared", maxInstances: 1 }, profile: { name: "Ada", email: "ada@example.com", aboutMe: "" }, language: "",
  features: { showToolCalls: false }, edition: { edition: "community", features: [] }, browserProfiles: [], budgets: {},
  billing: { currency: "USD", prices: {} }, pausedBots: [], heldBots: [],
};
/** What the server says about the place itself; GET /api/config, a PATCH answer and a config frame all carry it. */
const place = {
  computerName: "Studio", newBots: { effort: "high" }, signIn: { admins: ["ada@example.com"], members: [] },
  membership: { authority: "local", pairingCodes: true }, cloudStarter: true, waitingForRoom: true,
  planTurns: { running: 1, waiting: 2, refusedAt: 5, refused: "tasks" }, decisions: { retentionDays: 30 }, safetyFloor: { enabled: true },
  routinesUnreadable: true, botLimit: 3,
};
const FIELDS = Object.keys(place) as Array<keyof typeof place>;

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const { StoreProvider, useStore } = await import("./store");

let seen!: AppState;
let dispatch!: (action: Action) => void;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  return null;
}
let root: Root;
let cursor = 0;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await task(); };
const paints: FrameRequestCallback[] = [];
const paint = async () => {
  for (const callback of paints.splice(0)) callback(performance.now());
  await settle();
};
const configFrame = async (body: object) => {
  FixtureEventSource.opened[0]!.send({ kind: "config", ...body, seq: ++cursor }, `run:${cursor}`);
  await paint();
};
const held = () => Object.fromEntries(FIELDS.map((field) => [field, (seen.config as Record<string, unknown> | null)?.[field]]));

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("fetch", (input: string) => {
    const path = String(input).replace(/\?.*$/, "");
    if (path === "/api/config") return json({ ...settings, ...place });
    if (path === "/api/bots") return json({ bots: [], groups: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    return json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  await paint();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("a config frame", () => {
  it("starts from what GET /api/config answered", () => {
    expect(held()).toEqual(place);
  });

  it("keeps each of them when the frame says the same, as the server's frames do", async () => {
    await configFrame({ ...settings, ...place });
    expect(held()).toEqual(place);
  });

  it("takes a new value the frame carries", async () => {
    await configFrame({ ...settings, ...place, computerName: "Desk", waitingForRoom: false, newBots: {} });
    expect(held()).toEqual({ ...place, computerName: "Desk", waitingForRoom: false, newBots: {} });
  });

  it("keeps what the last answer said when a frame carries none of them, as an older server's do", async () => {
    flushSync(() => dispatch({ type: "configStatus", config: { ...settings, ...place } as unknown as ConfigStatus }));
    await configFrame(settings);
    expect(held()).toEqual(place);
  });

  it("drops the routines alert once a frame no longer carries it, as GET would", async () => {
    flushSync(() => dispatch({ type: "configStatus", config: { ...settings, ...place } as unknown as ConfigStatus }));
    const { routinesUnreadable: _unreadable, ...readable } = place;
    await configFrame({ ...settings, ...readable });
    expect(seen.config?.routinesUnreadable).toBeUndefined();
    expect(seen.config?.botLimit).toBe(3);
  });

  it("drops the Starter turns once a frame no longer carries them, as GET would", async () => {
    flushSync(() => dispatch({ type: "configStatus", config: { ...settings, ...place } as unknown as ConfigStatus }));
    const { planTurns: _planTurns, ...offStarter } = place;
    await configFrame({ ...settings, ...offStarter, cloudStarter: false });
    expect(seen.config?.planTurns).toBeUndefined();
    expect(seen.config?.cloudStarter).toBe(false);
  });
});
