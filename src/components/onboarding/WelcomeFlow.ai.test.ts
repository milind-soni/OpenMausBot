// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({
  state: {} as { instances: InstanceInfo[]; config: object; cloudAdd: null; bots: Bot[] }, dispatch: vi.fn(),
  checks: [] as string[], check: { ok: true } as object,
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: async (path: string) => {
  if (!path.endsWith("/check")) return { instances: f.state.instances };
  f.checks.push(path);
  return f.check;
} }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), setEmailGateDone: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }) }));
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance }: { instance: InstanceInfo }) => h("div", { "data-engine-setup": instance.instanceId }) };
});
const { WelcomeFlow } = await import("./WelcomeFlow");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean, aiTest?: InstanceInfo["aiTest"]): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] }, ...(aiTest ? { aiTest } : {}),
});
const freeOpenCode: InstanceInfo = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", install: { docsUrl: "https://example.test" },
  snapshot: { state: "available", authenticated: true, freeFallback: true }, models: { default: "opencode/big-pickle", options: [] }, aiTest: "passed",
};
const chief: Bot = {
  id: "chief", threadId: "t", name: "Pip", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, messages: [], chiefOfStaff: true,
};
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? "";
const flow = (extra: Record<string, unknown> = {}) => createElement(WelcomeFlow, { onDone: vi.fn(), dictation: false, cloudOffer: null, setupImport: null, ...extra });
const show = async (extra: Record<string, unknown> = {}) => { await act(async () => { root.render(flow(extra)); }); };
const press = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
  await act(async () => { button.click(); });
};

// A fresh store per test: on Node 24 happy-dom's storage outlives a test, so a step one test reached would open the next.
const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
};
beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  f.checks = [];
  f.check = { ok: true };
  f.state = { instances: [claude(false)], config: {}, cloudAdd: null, bots: [chief] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("asks for no AI when one already works: the greeting is the whole welcome, and it ends in the chat", async () => {
  f.state.instances = [claude(true)];
  const onDone = vi.fn();
  await show({ onDone });
  // One tiny test message first: the step is left out once Claude answered it.
  expect(f.checks).toEqual(["/api/instances/claude/check"]);
  expect(text()).not.toContain("Step 1 of");
  await press("Maybe later");
  expect(text()).not.toContain("Connect an AI");
  expect(onDone).toHaveBeenCalledOnce();
});

it("asks to connect an AI when none works, and keeps the step once it is shown, even after one connects", async () => {
  await show();
  expect(text()).toContain("Step 1 of 2");
  await press("Maybe later");
  expect(text()).toContain("Connect an AI");
  expect(host.querySelector('[data-engine-setup="claude"]')).not.toBeNull();
  f.state = { ...f.state, instances: [claude(true)] };
  await show();
  expect(text()).toContain("Connected · Claude");
  expect(text()).toContain("Step 2 of 2");
});

it("still asks for the person's own AI when only OpenCode's free model works, and says it is there as a backup", async () => {
  f.state.instances = [freeOpenCode, claude(false)];
  await show();
  expect(text()).toContain("Step 1 of 2");
  await press("Maybe later");
  expect(text()).toContain("Connect an AI");
  expect(text()).toContain("OpenCode's free model is ready as a backup");
  expect(host.querySelector('[data-engine-setup="claude"]')).not.toBeNull();
  expect(host.querySelector("[data-ai-connected]")).toBeNull();
  expect(f.checks).toEqual([]);
});

it("leaves the step out for a real AI that answered its test, and keeps it for one that didn't", async () => {
  f.state.instances = [freeOpenCode, claude(true, "passed")];
  await show();
  expect(text()).not.toContain("Step 1 of");
  expect(f.checks).toEqual([]);
  f.state.instances = [freeOpenCode, claude(true, "failed")];
  await act(async () => root.unmount());
  root = createRoot(host);
  await show();
  expect(text()).toContain("Step 1 of 2");
});

it("has no step about the first bot: Continue on the last step lands in the chat", async () => {
  const onDone = vi.fn();
  await show({ onDone, initialBeat: "engines" });
  expect(text()).toContain("Step 2 of 2");
  await press("Continue");
  expect(onDone).toHaveBeenCalledOnce();
  expect(text()).not.toContain("Meet your");
});

it("doesn't count an AI that offers no model yet, such as OpenCode still listing its models", async () => {
  f.state.instances = [{ ...freeOpenCode, snapshot: { state: "available", authenticated: true }, models: { default: "", options: [] }, aiTest: undefined }, claude(false)];
  await show();
  expect(text()).toContain("Step 1 of 2");
  expect(f.checks).toEqual([]);
});
