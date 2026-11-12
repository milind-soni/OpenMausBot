// @vitest-environment happy-dom
// The real controller runs against a fake preload bridge.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { PairedPhones } from "./PairedPhones";
import { usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

const ada = { id: "phone-1", name: "Ada", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: true };
const paired: CompanionState = { enabled: true, keepAwake: false, port: 8810, devices: [ada], pairing: null };

function Page() {
  const c = usePhoneSetupController();
  return c.state ? createElement(PairedPhones, { c, state: c.state }) : null;
}

let host: HTMLDivElement;
let root: Root;
const remove = () => host.querySelector<HTMLButtonElement>("[data-phone-remove]");

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

async function clickRemove(revoke: () => Promise<CompanionState>) {
  (globalThis as { ogb?: unknown }).ogb = { companion: { state: vi.fn(async () => paired), revoke: vi.fn(revoke) } };
  flushSync(() => root.render(createElement(Page)));
  await vi.waitFor(() => expect(remove()?.disabled).toBe(false));
  remove()!.click();
}

it("says a phone was removed once the computer removed it", async () => {
  await clickRemove(async () => ({ ...paired, devices: [] }));
  await vi.waitFor(() => expect(host.textContent).toContain("Removed Ada."));
});

it("never says a phone was removed when removing it failed", async () => {
  let failed = false;
  await clickRemove(async () => {
    failed = true;
    throw new Error("sidecar down");
  });
  await vi.waitFor(() => expect(failed).toBe(true));
  await vi.waitFor(() => expect(remove()?.disabled).toBe(false));
  expect(host.textContent).not.toContain("Removed Ada.");
});
