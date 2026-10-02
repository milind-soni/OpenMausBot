import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { withTourFinished, withTourReset } from "@/lib/guided-tour";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, streaming: {} }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: vi.fn() }), useStreaming: () => ({ streaming: f.streaming }), api: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
import { PRO_DISMISSED, ProIntroduction, ProSettingsCard, proOfferAvailable } from "./ProIntroduction";

/** The first card's dismissal id, in browser storage and the workspace hint record. */
const OLD_DISMISSED = "pro-introduction-dismissed";
import { api } from "@/state/store";

let storage: Map<string, string>;
let push: (value: CloudAccountState) => void;
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(ProIntroduction)); };
const signedOut = { status: "signed-out" } as const;
beforeEach(async () => {
  vi.clearAllMocks(); storage = new Map(); f.index = 0; f.values = []; f.updater = null; f.streaming = {};
  f.state = { connected: true, bots: [], groups: [], config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("window", { ogb: { cloudAccount: { state: () => Promise.resolve(signedOut), onState: (cb: typeof push) => { push = cb; return () => {}; } } } });
  render(); f.effects.forEach(effect => effect()); await Promise.resolve();
});
afterEach(() => vi.unstubAllGlobals());

it("shows the live benefits without enrolling, charging or refreshing an account", () => {
  const html = render();
  for (const text of ["Get Pro", "New features first and priority support", "always-on", "Cloud computers and voice", "scheduled tasks", "Don’t show again"]) expect(html).toContain(text);
  expect(html).not.toContain("Slack");
  expect(html.indexOf("New features first")).toBeLessThan(html.indexOf("always-on"));
  expect(html).not.toContain("bg-gradient"); expect(html).not.toContain("amber-");
  expect(html).not.toContain("Coming soon"); expect(api).not.toHaveBeenCalled();
  expect(html).not.toContain('aria-modal="true"');
});
it("states the $49 launch price and the later $89 as plain text, never as a former price", () => {
  const html = render();
  expect(html).toContain('<p class="mb-3 text-[12.5px]">$49/month — launch price for the first 100 users, then $89/month</p>');
  // No struck-through or "was" reference price (FTC 16 CFR 233.1, EU 30-day prior-price rule).
  for (const markup of ["<s>", "<s ", "<del", "<strike", "line-through", 'role="img"']) expect(html).not.toContain(markup);
  expect(html).not.toMatch(/\bwas\b/i);
  // Below the benefits, above Get Pro.
  expect(html.indexOf("Cloud scheduled tasks")).toBeLessThan(html.indexOf("$49/month"));
  expect(html.indexOf("$49/month")).toBeLessThan(html.indexOf("Get Pro"));
  // The wording change must not re-show the card to anyone who dismissed it.
  expect(PRO_DISMISSED).toBe("pro-introduction-dismissed-v2");
});
it("shows once more to someone who dismissed the first card, then stays dismissed", async () => {
  storage.set(OLD_DISMISSED, "1");
  f.state.config.onboarding.hintsSeen.push(OLD_DISMISSED);
  expect(PRO_DISMISSED).not.toBe(OLD_DISMISSED);
  expect(render()).toContain("$49/month");
  f.index = 0;
  ProIntroduction({})!.props.onDismiss(); await Promise.resolve();
  expect(storage.get(PRO_DISMISSED)).toBe("1");
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [...f.state.config.onboarding.hintsSeen, PRO_DISMISSED] } }) });
  expect(render()).toBe("");
  // A new mount (the signed-out account kept, the dismissed flag re-read) stays hidden.
  f.values = [signedOut];
  expect(render()).toBe("");
  // Browser storage gone and only the old workspace hint left: it would show again...
  storage.clear(); f.values = [signedOut];
  expect(render()).toContain("$49/month");
  // ...so the workspace record carries the new dismissal too.
  f.state.config.onboarding.hintsSeen.push(PRO_DISMISSED); f.values = [signedOut];
  expect(render()).toBe("");
});
it("persists dismissal and still offers Pro in Settings", async () => {
  f.index = 0;
  const card = ProIntroduction({})!;
  card.props.onDismiss(); await Promise.resolve();
  expect(storage.get(PRO_DISMISSED)).toBe("1");
  expect(api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen: [...f.state.config.onboarding.hintsSeen, PRO_DISMISSED] } }) });
  expect(render()).toBe("");
  f.values = []; f.index = 0;
  expect(render()).toBe(""); // New mount reads the saved preference.
  f.values = [signedOut]; f.index = 0;
  expect(renderToStaticMarkup(createElement(ProSettingsCard))).toContain("Get Pro");
});
it("honours workspace dismissal after browser storage is cleared and a tour is replayed", () => {
  f.state.config.onboarding.hintsSeen.push(PRO_DISMISSED);
  expect(withTourReset(f.state.config.onboarding)).toContain(PRO_DISMISSED);
  expect(render()).toBe("");
});
it.each(["appSettingsOpen", "settingsOpen", "newBotOpen", "pluginsOpen", "shortcutsOpen", "welcomeOpen", "tourOpen"])("does not interrupt %s", key => {
  f.state[key] = true; expect(render()).toBe("");
});
it("waits for onboarding, connection and busy background threads", () => {
  f.state.connected = false; expect(render()).toBe(""); f.state.connected = true;
  f.state.bots = [{ tasks: [{ busy: true }] }]; expect(render()).toBe(""); f.state.bots = [];
  f.state.config.onboarding = EMPTY_ONBOARDING; expect(render()).toBe("");
});
it("does not compete with updates", () => {
  f.updater = { status: "available" }; expect(render()).toBe("");
});
it("suppresses Pro subscribers, unknown/failed account state, and remote clients", () => {
  const pro = { status: "connected", entitlement: { plan: "pro", status: "active" } } as CloudAccountState;
  push(pro); expect(render()).toBe("");
  for (const state of [null, pro, { status: "unavailable" }, { status: "reauth-required" }, { status: "connecting" }] as Array<CloudAccountState | null>) expect(proOfferAvailable(state)).toBe(false);
  push(signedOut); window.ogb!.remoteClient = { active: true } as any; expect(render()).toBe("");
});
