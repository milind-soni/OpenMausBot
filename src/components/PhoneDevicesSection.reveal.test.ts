import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], revealed: [] as unknown[], state: null as object | null, account: null as object | null, bridge: null as object | null, accountAct: (() => undefined) as (call: (remote: never) => unknown) => unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("../lib/phone-pairing", () => ({ revealPhonePairing: (root: unknown) => { if (!root) return false; f.revealed.push(root); return true; } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({
  companionBridge: () => ({}),
  companionAccountBridge: () => f.bridge,
  usePhoneSetupController: () => ({ state: f.state, busy: false, accountBusy: false, account: f.account, accountAct: f.accountAct, accountError: null, error: null, localFallback: false, tailscaleFallback: false, tailscaleAvailable: false, hostedReady: false }),
  PhoneSetupFlowView: () => null,
  companionAccountActionError: () => null,
  loadCompanionBridgeState: () => null,
  shouldHydrateCompanionEmail: () => false,
}));
import { PhoneDevicesSection } from "./PhoneDevicesSection";

function render(focusRequest: number) {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => PhoneDevicesSection({ focusRequest })));
  f.effects[0]!();
}
const flow = () => f.values[0] as { current: unknown };

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; f.revealed = []; f.state = null; f.account = null; f.bridge = null; f.accountAct = () => undefined; });

it("waits for the phone flow to be drawn, then reveals it once per request", () => {
  render(1);
  expect(f.revealed).toEqual([]);
  f.state = { enabled: true, devices: [], port: 8810 };
  const card = { id: "flow" };
  flow().current = card;
  render(1);
  expect(f.revealed).toEqual([card]);
  render(1);
  expect(f.revealed).toEqual([card]);
  render(2);
  expect(f.revealed).toEqual([card, card]);
});

it("a plain visit reveals nothing", () => {
  f.state = { enabled: true, devices: [], port: 8810 };
  render(0);
  f.values[0] = { current: { id: "flow" } };
  render(0);
  expect(f.revealed).toEqual([]);
});

it("reveals again after Settings went elsewhere and came back on a new request", () => {
  f.state = { enabled: true, devices: [], port: 8810 };
  render(1);
  const card = { id: "flow" };
  flow().current = card;
  render(1);
  render(0);
  render(1);
  expect(f.revealed).toEqual([card, card]);
});

const PAUSED_LINE = "Paused after 30 days unused. It reconnects when you open this page.";
const unusedPhone = { id: "phone-1", name: "Ada", lastSeenAt: Date.now() - 40 * 24 * 60 * 60_000, cloudDesktopAccess: false };

function visit() {
  f.index = 0; f.effects = [];
  const markup = renderToStaticMarkup(createElement(() => PhoneDevicesSection({})));
  // PhoneDevicesSection's own effects come first: the reveal, then the resume. Later ones belong to child lists.
  f.effects[1]!();
  return markup;
}

it("brings a paused address back when the page opens, once, and says so under the phone", () => {
  const calls: string[] = [];
  f.bridge = { prepare: () => { calls.push("prepare"); return Promise.resolve({}); }, state: () => { calls.push("state"); return Promise.resolve({}); } };
  f.accountAct = (call) => call(f.bridge as never);
  f.account = { available: true, status: "ready", email: "ada@example.com", paused: true };
  f.state = { enabled: true, devices: [unusedPhone], port: 8810 };

  expect(visit()).toContain(PAUSED_LINE);
  expect(calls).toEqual(["prepare"]);
  visit();
  expect(calls).toEqual(["prepare"]);
});

it("asks for no address, and shows no pause, unless the address is paused with a phone paired and Remote access on", () => {
  for (const [account, state] of [
    [{ available: true, status: "ready" }, { enabled: true, devices: [unusedPhone], port: 8810 }],
    [{ available: true, status: "ready", paused: true }, { enabled: true, devices: [], port: 8810 }],
    [{ available: true, status: "ready", paused: true }, { enabled: false, devices: [unusedPhone], port: 8810 }],
    [{ available: true, status: "ready", paused: true }, { enabled: true, devices: [unusedPhone], port: 8810, error: "down" }],
    [{ available: false, status: "signed-out", paused: true }, { enabled: true, devices: [unusedPhone], port: 8810 }],
  ] as const) {
    f.values = [];
    const calls: string[] = [];
    f.bridge = { prepare: () => { calls.push("prepare"); return Promise.resolve({}); } };
    f.accountAct = (call) => call(f.bridge as never);
    f.account = account;
    f.state = state;
    const markup = visit();
    expect(calls, JSON.stringify([account, state])).toEqual([]);
    if (!("paused" in account)) expect(markup).not.toContain(PAUSED_LINE);
  }
});
