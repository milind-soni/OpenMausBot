// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import type { CompanionState } from "./PhoneSetupFlow";

const f = vi.hoisted(() => ({ here: true, state: null as object | null, act: null as unknown }));
vi.mock("@/lib/companion-bridge", () => ({ pageIsThisComputer: () => f.here }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }), api: async () => ({}) }));
vi.mock("./PhonesList", () => ({ PhonesList: () => null }));
vi.mock("./ServerPairingCard", async () => {
  const { createElement: h } = await import("react");
  return { ServerPairingCard: (props: { forComputer?: boolean }) => h("div", { "data-pairing-card": props.forComputer ? "computer" : "phone" }) };
});
vi.mock("./PhoneSetupFlow", () => ({
  companionBridge: () => ({}),
  companionAccountBridge: () => null,
  usePhoneSetupController: () => ({ state: f.state, busy: false, accountBusy: false, account: null, act: f.act, error: null }),
  PhoneSetupFlowView: () => null,
  companionAccountActionError: () => null,
  loadCompanionBridgeState: () => null,
  shouldHydrateCompanionEmail: () => false,
}));

const { RichMessageRow, richRowKind } = await import("./RichMessageRow");
const { PhoneDevicesSection } = await import("./PhoneDevicesSection");

const TEXT = "Your other computers: this is turned on in MausBot on the computer itself, in Settings → Phone & devices.";
const message = { id: "m1", role: "bot", kind: "text", text: TEXT, settingsCard: { id: "other-computers" } } as unknown as Message;
const off = { on: false, since: null };
const state = (tailscale: object = off, extra: Partial<CompanionState> = {}) => ({ enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null, notices: [], routes: { wifi: off, relay: off, https: off, tailscale }, ...extra });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  f.here = true;
  f.state = state();
  f.act = vi.fn(async () => null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

async function show(row: Message = message) {
  flushSync(() => root.render(createElement(RichMessageRow, { botId: "kiwi", botName: "Kiwi", threadId: "t-kiwi", message: row })));
  await vi.waitFor(() => expect(host.querySelector("[data-settings-card] [data-route-row], [data-settings-card-elsewhere], p")).not.toBeNull());
  return host;
}
const rowOf = (within: ParentNode) => within.querySelector('[data-settings-block="computers"]');

describe("a settings card in chat", () => {
  it("is drawn as a card row, not as the bot's text", () => {
    expect(richRowKind(message)).toBe("widget");
  });

  it("draws the same row the Phone & devices page draws, with its switch", async () => {
    const chat = await show();
    const inChat = rowOf(chat)!;
    expect(inChat).not.toBeNull();
    expect(chat.querySelector('[data-settings-card="other-computers"][data-settings-look="simple"]')).not.toBeNull();
    expect(chat.textContent).not.toContain(TEXT);
    const page = document.createElement("div");
    const pageRoot = createRoot(page);
    flushSync(() => pageRoot.render(createElement("div", { "data-settings-look": "simple" }, createElement(PhoneDevicesSection, { simple: true }))));
    expect(rowOf(page)!.textContent).toBe(inChat.textContent);
    expect(inChat.textContent).toContain("Your other computers");
    expect(inChat.textContent).toContain("Needs Tailscale on both.");
    flushSync(() => pageRoot.unmount());
    const toggle = inChat.querySelector<HTMLButtonElement>('[data-route-row="tailscale-computers"] [role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it("shows the state the app has now when the row is drawn again later", async () => {
    f.state = state({ on: true, since: 1, name: "macmini.tail1234.ts.net", computers: true }, { tailnetShare: { on: true, origin: "http://macmini.tail1234.ts.net:8799", https: false, problem: null } });
    const chat = await show();
    expect(chat.querySelector('[data-route-row="tailscale-computers"] [role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(chat.querySelector('[data-pairing-card="computer"]')).not.toBeNull();
  });

  it("on a Cloud's page, a browser or another computer's window, says where it is set and draws no switch", async () => {
    f.here = false;
    const chat = await show();
    expect(chat.querySelector("[data-settings-card-elsewhere]")!.textContent).toBe("This is set on the computer itself: open MausBot there, then Settings → Phone & devices → Your other computers.");
    expect(chat.querySelector('[role="switch"]')).toBeNull();
    expect(chat.querySelector("button")).toBeNull();
    expect(rowOf(chat)).toBeNull();
  });

  it("falls back to the row's own words for a card this version does not know", async () => {
    const chat = await show({ ...message, settingsCard: { id: "phone-pairing" } } as unknown as Message);
    expect(chat.textContent).toBe(TEXT);
    expect(chat.querySelector('[role="switch"]')).toBeNull();
  });
});
