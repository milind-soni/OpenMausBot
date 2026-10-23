// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdatesConsentState } from "../../electron/updates-consent.mjs";
import { setLocale } from "@/lib/i18n";
import { UpdatesConsentRow } from "./UpdatesConsent";

const base: UpdatesConsentState = { available: true, due: false, status: null, signedIn: false, email: null, version: "2026-10-23" };
let current: UpdatesConsentState;
let bridge: { state: ReturnType<typeof vi.fn>; choose: ReturnType<typeof vi.fn> };
let host: HTMLDivElement;
let root: Root;

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = async () => { await act(async () => { root.render(createElement(UpdatesConsentRow)); }); await settle(); };
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Get product updates by email"]');
const dialog = () => document.querySelector<HTMLElement>("[data-updates-consent-popup]");
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await settle(); };
const type = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = { ...base };
  bridge = {
    state: vi.fn(async () => current),
    choose: vi.fn(async (choice: { status: UpdatesConsentState["status"]; email?: string }) => {
      current = { ...current, due: false, status: choice.status, email: current.signedIn ? current.email : choice.status === "opted_in" ? choice.email ?? null : null };
      return current;
    }),
  };
  (window as unknown as { ogb: unknown }).ogb = { updatesConsent: bridge };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

describe("Settings → General: Product updates by email", () => {
  it("is not shown where it isn't available: a branded build, a remote client, or no bridge", async () => {
    current = { ...base, available: false };
    await show();
    expect(toggle()).toBeNull();
    (window as unknown as { ogb: unknown }).ogb = { updatesConsent: bridge, remoteClient: { active: true } };
    current = { ...base };
    await show();
    expect(toggle()).toBeNull();
    (window as unknown as { ogb: unknown }).ogb = {};
    await show();
    expect(toggle()).toBeNull();
  });

  it("reflects the account's answer, and turning it off withdraws; on again is one tap when signed in", async () => {
    current = { ...base, signedIn: true, status: "opted_in", email: "person@example.test" };
    await show();
    expect(host.textContent).toContain("Product updates by email");
    expect(host.textContent).toContain("Sent to person@example.test.");
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    await click(toggle()!);
    expect(bridge.choose).toHaveBeenLastCalledWith({ status: "withdrawn" });
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).not.toContain("Sent to");
    await click(toggle()!);
    expect(bridge.choose).toHaveBeenLastCalledWith({ status: "opted_in" });
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    expect(dialog()).toBeNull();
  });

  it("signed out, turning it on asks for an optional email first; No thanks changes nothing, Yes records it", async () => {
    current = { ...base, status: "declined" };
    await show();
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    await click(toggle()!);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Get MausBot updates?");
    expect(document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe("");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    await click(button("No thanks"));
    expect(dialog()).toBeNull();
    expect(bridge.choose).not.toHaveBeenCalled();
    await click(toggle()!);
    await type("someone@");
    await click(button("Yes, send me updates"));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Enter a valid email address.");
    expect(bridge.choose).not.toHaveBeenCalled();
    await type("person@example.test");
    await click(button("Yes, send me updates"));
    expect(bridge.choose).toHaveBeenCalledWith({ status: "opted_in", email: "person@example.test" });
    expect(dialog()).toBeNull();
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Sent to person@example.test.");
  });

  it("says so when main can't save the answer, and leaves the switch as it was", async () => {
    current = { ...base, signedIn: true, status: "declined", email: "person@example.test" };
    bridge.choose.mockRejectedValueOnce(new Error("Product updates are not available in this app."));
    await show();
    await click(toggle()!);
    expect(host.textContent).toContain("That didn't save. Try again.");
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  });
});
