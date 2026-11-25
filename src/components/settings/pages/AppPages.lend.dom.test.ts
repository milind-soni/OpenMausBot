// @vitest-environment happy-dom
// Settings → This app in Simple mode: Your computers (where a server is added and its lend switch is) shows there too,
// on This computer's own page and on a server's own page, where that server's switch sits under its row.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

let advanced = false;
vi.mock("../settings-shell", () => ({ useSettingsShell: () => ({
  ctx: { desktop: true, advanced, client: false, home: false, here: true, cloud: false },
  place: { kind: "server", name: "hetzner-1", color: null, named: true }, go: vi.fn(),
}) }));
vi.mock("../settings-context", () => ({ useOtherPlaces: () => [], versionLine: () => "MausBot 0.1.178" }));
vi.mock("../inert", () => ({ useSwitchToComputer: () => ({ name: "This computer" }), InertRow: ({ title }: { title: string }) => createElement("div", { "data-inert": title }) }));
vi.mock("@/state/store-select", () => ({ useStoreDispatch: () => vi.fn() }));
vi.mock("../../ConnectedWorkspacesSettings", () => ({ ConnectedWorkspacesSettings: ({ label }: { label: string }) => createElement("section", { "data-your-computers": label }) }));
vi.mock("../../RemoteComputerSection", () => ({ RemoteComputerSection: () => null }));
vi.mock("../../NotificationSettingsRows", () => ({ NotificationRows: () => null }));
vi.mock("../../AppSettingsRows", async (original) => ({ ...(await original<object>()), LanguageRow: () => null, UpdatesRow: () => null, ReplayTourRow: () => null }));
vi.mock("../../AboutDialog", () => ({ AboutDialog: () => null }));
vi.mock("../../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { label: "macOS", platform: "darwin" }, localComputer: { reasonCode: "remote-server", available: false } }, ready: true }) }));
const { AppPage } = await import("./AppPages");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const mount = async (children?: ReactNode) => {
  root = createRoot(host);
  await act(async () => { root!.render(children ?? createElement(AppPage)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

beforeEach(() => { setLocale("en"); advanced = false; host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

it("Simple mode shows Your computers on This computer's own page, as Advanced does", async () => {
  Object.assign(window, { ogb: { environments: { state: vi.fn() } } });
  await mount();
  expect(host.querySelector("[data-your-computers]")?.getAttribute("data-your-computers")).toBe("Your computers");
  await act(async () => root!.unmount()); root = null;
  advanced = true;
  await mount();
  expect(host.querySelector("[data-your-computers]")).toBeTruthy();
});

it("on a server's own page in Simple mode, its lend switch sits under its row, and the inert environments group stays Advanced", async () => {
  const lendComputer = { state: vi.fn(async () => ({ name: "hetzner-1", lendable: true, on: false, connected: false, paused: false })), set: vi.fn(), allowScreen: vi.fn() };
  Object.assign(window, { ogb: { workspaces: { add: vi.fn() }, lendComputer } });
  await mount();
  expect(lendComputer.state).toHaveBeenCalledWith(null);
  expect(host.querySelector("[data-lend-switch]")?.textContent).toContain("Let hetzner-1’s bots use this computer");
  expect(host.querySelector("[data-settings-block=\"environments\"]"), "the inert environments group stays Advanced").toBeNull();
});
