// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { appVersion } from "@/lib/app-links";
import { fullContext, pageById } from "./settings-index";
import { overviewStatus, SettingsPageHeader } from "./SettingsPageHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  setLocale("en");
  (window as unknown as { ogb: unknown }).ogb = { app: { version: "9.8.7", ownPage: false } };
});

afterEach(() => {
  delete (window as unknown as { ogb?: unknown }).ogb;
});

describe("overviewStatus on a Cloud's page in the desktop window", () => {
  it("names the desktop app's version for This computer", () => {
    expect(overviewStatus({ name: "This computer", kind: "computer", color: null, named: false })).toContain("9.8.7");
  });

  it("names the page's own version for the Cloud", () => {
    const line = overviewStatus({ name: "My Cloud", kind: "cloud", color: null, named: false });
    expect(line).toContain(appVersion());
    expect(line).not.toContain("9.8.7");
  });
});

describe("a step inside a page", () => {
  it("takes the page's title, with its way back above it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onBack = vi.fn();
    act(() => root.render(createElement(SettingsPageHeader, {
      page: pageById("devices"), ctx: fullContext({ advanced: false }), place: { name: "This computer", kind: "computer", color: null, named: false }, narrow: false,
      sub: { title: "Add a computer", back: "Add a device", onBack },
    })));
    expect(host.querySelector("#settings-page-title")?.textContent).toBe("Add a computer");
    const back = host.querySelector<HTMLButtonElement>("[data-settings-sub-back]")!;
    expect(back.textContent).toBe("Add a device");
    act(() => back.click());
    expect(onBack).toHaveBeenCalledOnce();
    act(() => root.unmount());
    host.remove();
  });
});
