// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudOffer } from "../../../electron/cloud-home.mjs";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: async () => ({}) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }) }));
const { WelcomeFlow } = await import("./WelcomeFlow");
const { welcomeOnScreen } = await import("@/lib/onboarding");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const allowances = { cpus: 2, memoryMb: 2048, diskGb: 20, maxDiskGb: 20, computers: 1, computerHours: 50, voiceCharacters: 1 };
const OFFER: CloudOffer = { recommended: "pro", plans: [{ tier: "pro", amount: 4900, trialDays: 3, allowances }] };
let host: HTMLDivElement, root: Root;
beforeEach(() => { setLocale("en"); f.state = { config: {}, cloudAdd: null, bots: [], instances: [] }; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flow = (extra: Record<string, unknown> = {}) => createElement(WelcomeFlow, { onDone: vi.fn(), dictation: false, initialBeat: "cloud", cloudOffer: OFFER, ...extra });

it("the welcome offers MausBot Cloud as its last step, and Not now finishes it, straight into the chat", async () => {
  const onDone = vi.fn();
  await act(async () => { root.render(flow({ onDone })); });
  expect(host.textContent).toContain("Keep your bots working while you sleep");
  expect(host.textContent).toContain("3 of 3");
  const notNow = [...host.querySelectorAll("button")].find(button => button.textContent === "Not now")!;
  await act(async () => { notNow.click(); });
  expect(onDone).toHaveBeenCalledOnce();
});

it("without an offer the welcome has no Cloud beat at all", async () => {
  await act(async () => { root.render(flow({ cloudOffer: null })); });
  expect(host.textContent).not.toContain("Keep your bots working while you sleep");
  expect(host.textContent, "asked for the Cloud step, it opens on the step before it").toContain("2 of 2");
});

it("marks itself on screen while it is shown (so a Cloud sheet over it never switches the window), not as an embedded preview", async () => {
  expect(welcomeOnScreen()).toBe(false);
  await act(async () => { root.render(flow()); });
  expect(welcomeOnScreen()).toBe(true);
  await act(async () => { root.render(flow({ embedded: true })); });
  expect(welcomeOnScreen(), "the embedded preview is not the welcome on screen").toBe(false);
  await act(async () => { root.render(flow()); });
  expect(welcomeOnScreen()).toBe(true);
  await act(async () => root.unmount());
  expect(welcomeOnScreen()).toBe(false);
  root = createRoot(host);
});
