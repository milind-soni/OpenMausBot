// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }) }));
const { DesktopWorkspaceSwitcher } = await import("../DesktopWorkspaceSwitcher");
const { ConnectedWorkspacesSettings } = await import("../ConnectedWorkspacesSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); });
afterEach(() => { host.remove(); vi.unstubAllGlobals(); });
const mount = async (element: ReturnType<typeof createElement>) => {
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  await act(async () => { await Promise.resolve(); });
  return root;
};

it("the sidebar switcher shows a Cloud named and coloured while it was set up: its name on its colour's tile", async () => {
  Object.assign(window, { ogb: { workspaces: { state: async () => ({ local: false, name: "Studio", origin: "https://omb-u-1.fly.dev", color: "teal" }), menu: async () => {} } } });
  const root = await mount(createElement(DesktopWorkspaceSwitcher));
  expect(host.textContent).toContain("Studio");
  expect(host.innerHTML).toContain("background: var(--identity-teal)");
  await act(async () => root.unmount());
  Object.assign(window, { ogb: { workspaces: { state: async () => ({ local: false, name: "VPS", origin: "https://bots.example.test", color: "url(x)" }), menu: async () => {} } } });
  const plain = await mount(createElement(DesktopWorkspaceSwitcher));
  expect(host.innerHTML).not.toContain("--identity-"); expect(host.textContent).toContain("VPS");
  await act(async () => plain.unmount());
});

it("Settings → Servers lists the Cloud under its name, on its colour's tile; other servers keep the plain mark", async () => {
  Object.assign(window, { ogb: { environments: { state: async () => ({ localOrigin: "http://127.0.0.1:1", remote: false, packaged: false, activeId: "local",
    environments: [{ id: "c", kind: "remote", name: "Studio", origin: "https://omb-u-1.fly.dev", color: "purple" }, { id: "v", kind: "remote", name: "VPS", origin: "https://bots.example.test" }] }),
    switch: vi.fn(), forget: vi.fn(), addFromLink: vi.fn(), onOpenSettings: () => () => {} } } });
  const root = await mount(createElement(ConnectedWorkspacesSettings));
  expect(host.textContent).toContain("Studio"); expect(host.textContent).toContain("VPS");
  expect(host.innerHTML.match(/var\(--identity-purple\)/g)).toHaveLength(1);
  await act(async () => root.unmount());
});
