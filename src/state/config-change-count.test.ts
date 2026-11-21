// @vitest-environment happy-dom
// The real provider and its live stream: how many times a store reader draws when a setting is switched, counting the
// config frame the server broadcasts, the PATCH answer the row dispatches and the engine list read again after the frame.
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

/** What the server says about each setting. */
const settingsOf = (savedSteps: boolean) => ({
  xai: { configured: false }, anthropic: { configured: true, everyClaudeBot: true }, openai: { configured: false },
  composio: { configured: false, mode: "hosted" }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, mcp: { callTimeoutMinutes: 5 }, threads: { maxConcurrentPerBot: 3 },
  localVm: { mode: "shared", maxInstances: 1, idleTimeoutMinutes: 30, preserveInstalledApps: false },
  profile: { name: "Ada", email: "ada@example.com", aboutMe: "" }, language: "", everyBotRules: "",
  features: { skillAuthoring: true, showToolCalls: false, browser: true, savedSteps },
  onboarding: { completedAt: "2026-01-01", version: 1, reelSeen: true, hintsSeen: ["a", "b"] },
  edition: { edition: "community", features: [] }, browserProfiles: [{ id: "work", name: "Work" }],
  budgets: {}, billing: { currency: "USD", prices: {} }, pausedBots: [], heldBots: [],
});
/** What GET and PATCH /api/config answer and a config frame carries: the settings and what it says about the place. */
const answered = (savedSteps: boolean) => ({
  ...settingsOf(savedSteps), computerName: "Studio", newBots: {}, signIn: { admins: [], members: [] },
  membership: { authority: "local", pairingCodes: true }, decisions: { retentionDays: 30 }, safetyFloor: { enabled: true },
});
const INSTANCES = [{ instanceId: "codex", driverKind: "codex", displayName: "Codex", enabled: true, snapshot: { state: "available", authenticated: true, models: [{ id: "m", name: "M" }] } }];

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
let config: unknown = answered(false);
let instanceReads = 0;
const { StoreProvider, useStore } = await import("./store");

let renders = 0;
let seen!: AppState;
let dispatch!: (action: Action) => void;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  renders++;
  return null;
}
let root: Root;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await task(); };
const paints: FrameRequestCallback[] = [];
const paint = async () => {
  for (const callback of paints.splice(0)) callback(performance.now());
  await settle();
};
const stream = () => FixtureEventSource.opened[0]!;
let cursor = 0;
const configFrame = (body: object) => stream().send({ kind: "config", ...body, seq: ++cursor }, `run:${cursor}`);
/** One switch flipped: the frame is broadcast before the PATCH answers, the row dispatches the answer, and the frame
 * has the engine list read again. Returns how many times the reader drew. */
async function flip(frameBody: object, answer: object): Promise<number> {
  const before = renders, reads = instanceReads;
  configFrame(frameBody);
  await paint();
  flushSync(() => dispatch({ type: "configStatus", config: structuredClone(answer) as ConfigStatus }));
  await paint();
  expect(instanceReads, "the frame has the engine list read again").toBe(reads + 1);
  return renders - before;
}

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("fetch", (input: string) => {
    const path = String(input).replace(/\?.*$/, "");
    if (path === "/api/instances") { instanceReads++; return json({ instances: structuredClone(INSTANCES) }); }
    if (path === "/api/config") return json(config);
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
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  await paint();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("a switched setting reaches the store's readers", () => {
  it("starts from the config and the engines the server answered", () => {
    expect(seen.config).toEqual(answered(false));
    expect(seen.instances).toEqual(INSTANCES);
  });

  it("draws nothing for a PATCH answer that says what the store already holds", async () => {
    const before = renders, held = seen;
    flushSync(() => dispatch({ type: "configStatus", config: structuredClone(answered(false)) as unknown as ConfigStatus }));
    await paint();
    expect(renders - before).toBe(0);
    expect(seen).toBe(held);
  });

  it("draws once for a switch: the frame, then nothing for the answer that says the same, nor for the same engine list", async () => {
    config = answered(true);
    const counted = await flip(answered(true), answered(true));
    expect(seen.config).toEqual(answered(true));
    expect(counted).toBe(1);
  });

  it("draws nothing for a frame from an older server that leaves out what it says about the place", async () => {
    const before = renders, held = seen, reads = instanceReads;
    configFrame(settingsOf(true));
    await paint();
    expect(instanceReads).toBe(reads + 1);
    expect(seen.config).toEqual(answered(true));
    expect(renders - before).toBe(0);
    expect(seen).toBe(held);
  });

  it("draws once when the answer comes before the frame", async () => {
    config = answered(false);
    const before = renders;
    flushSync(() => dispatch({ type: "configStatus", config: structuredClone(answered(false)) as unknown as ConfigStatus }));
    await paint();
    configFrame(answered(false));
    await paint();
    expect(seen.config?.features?.savedSteps).toBe(false);
    expect(renders - before).toBe(1);
  });

  it("draws nothing for a config frame that repeats the last one, nor for the engine list read after it", async () => {
    const before = renders, held = seen, reads = instanceReads;
    configFrame(answered(false));
    await paint();
    expect(instanceReads).toBe(reads + 1);
    expect(renders - before).toBe(0);
    expect(seen).toBe(held);
  });

  it("still takes a changed engine list", async () => {
    const before = renders;
    INSTANCES[0]!.snapshot.models.push({ id: "n", name: "N" });
    configFrame(answered(false));
    await paint();
    expect(seen.instances).toEqual(INSTANCES);
    expect(renders - before).toBe(1);
  });
});
