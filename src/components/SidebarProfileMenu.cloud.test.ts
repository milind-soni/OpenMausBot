import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";

// On this computer the menu reads the person's Cloud from the native
// snapshot. React's hooks are replayed by hand.
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { useCloudPhoneDestination } from "./SidebarProfileMenu";

const readyCloud: CloudAccountState = { status: "connected", entitlement: { plan: "pro", tier: "max", status: "active", expiresAt: null, version: 1 }, machine: { status: "ready", origin: "https://home-7f3k2.fly.dev" } };
let bridge: CloudAccountBridge, push: (state: CloudAccountState) => void;
let result: ReturnType<typeof useCloudPhoneDestination>;
function render(enabled: boolean) {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => { result = useCloudPhoneDestination(enabled); return null; }));
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  f.values = []; f.index = 0; f.effects = []; push = () => {};
  bridge = { state: vi.fn().mockResolvedValue(readyCloud), onState: vi.fn((callback) => { push = callback; return () => {}; }), connectHomeForPhone: vi.fn() } as unknown as CloudAccountBridge;
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge } });
});
afterEach(() => vi.unstubAllGlobals());

it("on this computer, follows the snapshot: a paid, Ready Cloud is offered, and a change is followed", async () => {
  render(true);
  expect(result.cloud).toBeNull();
  f.effects[0]!(); await flush();
  render(true);
  expect(result).toEqual({ cloud: "ready", bridge });
  push({ ...readyCloud, machine: { status: "stopped", origin: "https://home-7f3k2.fly.dev" } });
  render(true);
  expect(result.cloud).toBe("not-ready");
  push({ status: "signed-out" });
  render(true);
  expect(result.cloud).toBeNull();
  // reading it never signs in, refreshes or connects
  expect(bridge.connectHomeForPhone).not.toHaveBeenCalled();
});

it("is not read anywhere but this computer's own window", async () => {
  render(false);
  f.effects[0]!(); await flush();
  render(false);
  expect(result).toEqual({ cloud: null });
  expect(bridge.state).not.toHaveBeenCalled();
  // a desktop that is a remote client of another server
  vi.stubGlobal("window", { ogb: { cloudAccount: bridge, remoteClient: { active: true } } });
  f.values = []; render(true); f.effects[0]!(); await flush(); render(true);
  expect(result).toEqual({ cloud: null });
  expect(bridge.state).not.toHaveBeenCalled();
});
