// @vitest-environment happy-dom
import { createElement, Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const value = {
    state: {} as any,
    listeners,
    api: null as any,
    set(next: any) { value.state = next; listeners.forEach((listener) => listener()); },
    dispatch(action: any) {
      if (action.type === "configStatus") value.set({ ...value.state, config: action.config });
    },
  };
  return value;
});
vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; };
  return {
    ...actual,
    api: (...args: unknown[]) => fixture.api(...args),
    useStore: () => ({ state: useSyncExternalStore(subscribe, () => fixture.state), dispatch: fixture.dispatch, refreshInstances: vi.fn() }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/components/CloudTrialNotice", () => ({ useCloudPlanSnapshot: () => null }));
vi.mock("@/components/EngineSetup", () => ({ EngineSetup: () => null }));
vi.mock("@/components/TeamLibraryPanel", () => ({ TeamLibraryPanel: () => null }));
import { CloudWelcome } from "./CloudWelcome";
import { WelcomeKeeper } from "./WelcomeKeeper";
import { resetCloudWelcome, useCloudWelcome } from "@/lib/cloud-welcome";

const owner = { hosted: false, canSave: true, cloudHome: true };

let host: HTMLDivElement;
let root: Root;
let server: any;

function Harness() {
  const welcome = useCloudWelcome();
  return createElement(Fragment, null, welcome.ended ? null : createElement(CloudWelcome), createElement(WelcomeKeeper, { viewer: owner }));
}
function welcomeNow() {
  let value: ReturnType<typeof useCloudWelcome> | null = null;
  function Probe() { value = useCloudWelcome(); return null; }
  const probe = createRoot(document.createElement("div"));
  flushSync(() => probe.render(createElement(Probe)));
  flushSync(() => probe.unmount());
  return value!;
}

beforeEach(() => {
  setLocale("en");
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
  fixture.state = {
    connected: true, selectedId: "b1", activeView: "chat", routines: [], groups: [], bots: [{ id: "b1", threadId: "t1", name: "Maus" }],
    instances: [{ instanceId: "claude" }], config: { cloudHome: true, onboarding: { ...EMPTY_ONBOARDING }, profile: { name: "", email: "", aboutMe: "" } },
  };
  server = structuredClone(fixture.state.config);
  // Like the server: each save applies when it arrives, and every answer is the whole config as it is then.
  fixture.api = vi.fn((_path: string, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body ?? "{}"));
    if (patch.onboarding) server = { ...server, onboarding: { ...server.onboarding, ...patch.onboarding } };
    return Promise.resolve().then(() => structuredClone(server));
  });
  window.ogb = { platform: "darwin", workspaces: { state: vi.fn().mockResolvedValue({ local: false, name: "Studio Cloud" }), menu: vi.fn() } } as unknown as typeof window.ogb;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete window.ogb;
  vi.unstubAllGlobals();
});

describe("an end of the welcome kept on this device", () => {
  it("keeps the welcome away, reaches the Cloud's record when it can, and is then let go", async () => {
    localStorage.setItem("omb.cloudWelcome.done", "1");
    resetCloudWelcome();
    flushSync(() => root.render(createElement(Harness)));
    expect(document.body.textContent).not.toContain("What should Studio Cloud start with?");
    await vi.waitFor(() => expect(server.onboarding.hintsSeen).toContain("cloud-welcome-done"));
    await vi.waitFor(() => expect(localStorage.getItem("omb.cloudWelcome.done")).toBeNull());
    expect(welcomeNow().doneHere).toBe(false);
  });
});
