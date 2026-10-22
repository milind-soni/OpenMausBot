// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";

let host: HTMLDivElement;
let root: Root;
const menu = vi.fn(() => Promise.resolve());
const show = async (state: Record<string, unknown>, props: Record<string, unknown> = {}, plan?: Record<string, unknown>) => {
  window.ogb = { workspaces: { state: vi.fn().mockResolvedValue(state), menu },
    ...(plan ? { cloudPlan: { state: vi.fn().mockResolvedValue(plan), manage: vi.fn() } } : {}) } as unknown as typeof window.ogb;
  flushSync(() => root.render(createElement(DesktopWorkspaceSwitcher, props)));
  await vi.waitFor(() => expect(host.innerHTML).not.toBe(""));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => { setLocale("en"); menu.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); host.remove(); delete window.ogb; });

it("in a window whose home is My Cloud, names My Cloud with nothing to open: no menu, no This computer", async () => {
  for (const props of [{ cloudHome: true }, { cloudHome: true, inline: true, pill: true }, { cloudHome: true, rail: true }]) {
    await show({ local: false, name: "My Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev", home: true }, props);
    expect(host.querySelector("[data-cloud-home-indicator]"), JSON.stringify(props)).not.toBeNull();
    expect(host.querySelector("button"), JSON.stringify(props)).toBeNull();
    expect(host.textContent).not.toContain("This computer");
  }
  expect(menu).not.toHaveBeenCalled();
});

it("anywhere else keeps the switcher as it was", async () => {
  await show({ local: false, name: "My Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev" }, { cloudHome: true });
  expect(host.querySelector("button")?.getAttribute("aria-haspopup")).toBe("menu");
  await show({ local: true, name: "This computer" });
  expect(host.querySelector("button")?.textContent).toContain("This computer");
});

it("says always on only when My Cloud's verified plan never sleeps, on its pages and its pair page alike", async () => {
  const home = { local: false, name: "My Cloud", origin: "https://omb-u-1a2b3c4d5e6f.fly.dev", home: true };
  const label = () => host.querySelector("[data-cloud-home-indicator]")?.textContent ?? "";
  for (const props of [{ cloudHome: true }, {}]) {
    await show(home, props, { status: "paid", tier: "pro" });
    await vi.waitFor(() => expect(label(), JSON.stringify(props)).toBe("My Cloud · always on"));
    await show(home, props, { status: "paid", tier: "starter", sleeps: true });
    await vi.waitFor(() => expect(label(), JSON.stringify(props)).toBe("My Cloud · sleeps when idle"));
    for (const plan of [{ status: "checking", tier: "pro" }, { status: "signin" }, { status: "none" }]) {
      await show(home, props, plan);
      expect(label(), JSON.stringify(plan)).toBe("My Cloud");
    }
    await show(home, props);
    expect(label(), "no plan to read").toBe("My Cloud");
  }
});
