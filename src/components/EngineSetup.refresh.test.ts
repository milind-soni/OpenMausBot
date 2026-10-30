// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { RefreshEngines } from "./EngineLibrary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
const dispatch = vi.fn();
const refreshModels = vi.fn().mockResolvedValue(undefined);
const engine: InstanceInfo = {
  instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi",
  snapshot: { state: "unavailable", reason: "Fixture missing CLI" }, models: { default: "", options: [] },
  install: { platform: "linux", command: { linux: "fixture-install" }, signInCommand: "kimi login", server: { package: "kimi-fixture" } },
};
function mount(child: ReactNode = createElement(RefreshEngines)) {
  const store = { state: initialState, dispatch, refreshInstances: refresh, refreshModels } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: child })));
}
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(name))!;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  refresh.mockReset(); dispatch.mockReset(); refreshModels.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows refresh failure and offers a working retry", async () => {
  refresh.mockRejectedValueOnce(new Error("Fixture server offline")).mockResolvedValueOnce(undefined);
  mount();
  await act(async () => button("Check again").click());
  expect(refresh).toHaveBeenCalledWith({ reportErrors: true });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("previous status is still shown");
  expect(button("Check again").disabled).toBe(false);
  await act(async () => button("Check again").click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("refreshed");
});

it("disables recheck while a probe is running", async () => {
  let finish!: () => void;
  refresh.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  mount();
  act(() => button("Check again").click());
  expect(button("Checking").disabled).toBe(true);
  await act(async () => finish());
  expect(button("Check again").disabled).toBe(false);
});

it("does not claim install success when the returned provider probe is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ instances: [engine] }))));
  mount(createElement(EngineSetup, { instance: engine }));
  await act(async () => button("Install Kimi here").click());
  expect(host.textContent).toContain("installer finished, but the provider is not usable yet");
  expect(host.textContent).not.toContain("Installation verified");
  expect(refreshModels).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [engine] });
});

it("uses the verified install response instead of relying on another status request", async () => {
  const installed = { ...engine, snapshot: { state: "available", authenticated: false } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ instances: [installed] }))));
  mount(createElement(EngineSetup, { instance: engine }));
  await act(async () => button("Install Kimi here").click());
  expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [installed] });
  expect(refresh).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Installation verified. Sign in if requested.");
});

it("never opens a local terminal to install on a paired remote server", () => {
  vi.stubGlobal("window", Object.assign(window, { ogb: { platform: "win32", openInstallTerminal: vi.fn(), remoteClient: { active: true } } }));
  mount(createElement(EngineSetup, { instance: engine }));
  expect(host.textContent).not.toContain("Open install in Terminal");
  expect(host.textContent).toContain("fixture-install");
  expect(host.textContent).toContain("the machine it runs on, not this device");
});

it("says plainly when the engine now runs the copy the app installed", async () => {
  const opencode: InstanceInfo = {
    ...engine, instanceId: "opencode", driverKind: "opencodeGo", displayName: "OpenCode",
    install: { platform: "linux", command: { linux: "npm install -g opencode-ai" }, server: { standalone: { version: "1.19.4", downloadBytes: 79_667_571 } } },
  };
  const ready: InstanceInfo = { ...opencode, snapshot: { state: "available", authenticated: true } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ instances: [ready], usingAppCopy: true }))));
  mount(createElement(EngineSetup, { instance: opencode }));
  await act(async () => button("Install OpenCode here").click());
  expect(host.textContent).toContain("Another copy of OpenCode on this computer doesn't start, so OpenCode now uses the copy MausBot installed.");
  expect(host.textContent).toContain("Installation verified");
});
