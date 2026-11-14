// @vitest-environment happy-dom
// Real store + setup components; every request is synthetic and stays in-process.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore, type InstanceInfo } from "./store";
import { EngineCard, engineReady } from "../components/EngineLibrary";
import { EngineSetup } from "../components/EngineSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it("recovers from offline, detects installation, and becomes ready on focus without remounting", async () => {
  let snapshot: InstanceInfo["snapshot"] = { state: "unavailable", reason: "Fixture CLI missing" };
  let offline = false;
  const requests = vi.fn(async (path: string) => {
    if (path.split("?")[0] === "/api/instances") return new Response(JSON.stringify(offline ? { error: "Fixture offline" } : { instances: [{
      instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi", models: { default: "fixture", options: [] }, snapshot,
      install: { platform: "linux", command: { linux: "fixture-install" }, signInCommand: "fixture-login" },
    }] }), { status: offline ? 503 : 200 });
    return new Response(JSON.stringify(path.startsWith("/api/bots?") ? { bots: [], groups: [] } : {}));
  });
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("EventSource", undefined);
  let controls!: ReturnType<typeof useStore>;
  function Preview() {
    controls = useStore();
    const { state } = controls;
    const instance = state.instances.find((value) => value.instanceId === "kimi");
    if (!instance) return null;
    return createElement(EngineCard, { instance, children: engineReady(instance)
      ? createElement("p", null, "Ready to use") : createElement(EngineSetup, { instance }) });
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const check = async () => act(async () => {
    Array.from(host.querySelectorAll("button")).find((node) => node.textContent === "Check again")!.click();
  });
  try {
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Preview))));
    await act(async () => controls.refreshInstances({ reportErrors: true }));
    const card = host.querySelector("details")!;
    card.open = true;
    expect(host.textContent).toContain("Set up Kimi");
    offline = true;
    await check();
    expect(host.textContent).toContain("previous status is still shown");
    expect(host.textContent).toContain("Fixture CLI missing");
    offline = false;
    snapshot = { state: "available", authenticated: false, version: "1.0.0" };
    await check();
    expect(host.textContent).toContain("Sign in to Kimi");
    expect(host.textContent).toContain("Sign-in required");
    expect(host.querySelector("details")).toBe(card);
    expect(card.open).toBe(true);
    snapshot = { state: "available", authenticated: true, version: "1.0.0" };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.textContent).toContain("Ready to use");
    expect(host.querySelector("details")).toBe(card);
    expect(card.open).toBe(true);
  } finally {
    act(() => root.unmount()); host.remove();
  }
});
