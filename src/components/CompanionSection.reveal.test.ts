import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// Connect your phone on this computer: the phone flow reveals itself once the
// companion's state is read, once per request. React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], revealed: [] as unknown[], state: null as object | null }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("../lib/phone-pairing", () => ({ revealPhonePairing: (root: unknown) => { if (!root) return false; f.revealed.push(root); return true; } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({
  companionBridge: () => ({}),
  usePhoneSetupController: () => ({ state: f.state, busy: false, accountBusy: false, account: null, accountError: null, error: null, localFallback: false, tailscaleFallback: false, tailscaleAvailable: false, hostedReady: false }),
  PhoneSetupFlowView: () => null,
  companionAccountActionError: () => null,
  loadCompanionBridgeState: () => null,
  shouldHydrateCompanionEmail: () => false,
}));
import { CompanionSection } from "./CompanionSection";

function render(focusRequest: number) {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => CompanionSection({ focusRequest })));
  f.effects[0]!();
}
const flow = () => f.values[0] as { current: unknown };

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; f.revealed = []; f.state = null; });

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

it("keeps browser access separately off until granted, including old sidecar snapshots", () => {
  for (const browserControlAccess of [undefined, false, true]) {
    f.state = { enabled: true, devices: [{ id: "phone-1", name: "Ada", lastSeenAt: Date.now(), cloudDesktopAccess: true, browserControlAccess }], port: 8810 };
    const markup = renderToStaticMarkup(createElement(() => CompanionSection({})));
    const browser = markup.match(/<button[^>]*aria-label="Browser control access for Ada"[^>]*>/)?.[0];
    const computer = markup.match(/<button[^>]*aria-label="Computer view access for Ada"[^>]*>/)?.[0];
    expect(browser).toContain(`aria-checked="${browserControlAccess === true}"`);
    expect(computer).toContain('aria-checked="true"');
  }
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
