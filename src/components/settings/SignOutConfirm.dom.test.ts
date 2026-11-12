// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { SignOutConfirm } from "./SignOutConfirm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function confirmWith(onConfirm: () => Promise<unknown>) {
  const onClose = vi.fn();
  act(() => root.render(createElement(SignOutConfirm, { here: "This computer", onConfirm, onClose })));
  await act(async () => document.body.querySelector<HTMLButtonElement>("[data-sign-out-confirm]")!.click());
  return onClose;
}

describe("SignOutConfirm", () => {
  it("closes once the sign-out went through", async () => {
    expect(await confirmWith(async () => {})).toHaveBeenCalledOnce();
  });

  it("stays open and says so when the sign-out fails, so nobody thinks they are signed out", async () => {
    const onClose = await confirmWith(async () => { throw new Error("offline"); });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-settings-dialog] [role=alert]")?.textContent).toBe("Could not complete this Cloud action. Check your connection and try again.");
    expect(document.body.querySelector<HTMLButtonElement>("[data-sign-out-confirm]")!.disabled).toBe(false);
  });
});
