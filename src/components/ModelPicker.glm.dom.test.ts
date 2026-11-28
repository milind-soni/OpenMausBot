// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, initialState, reducer, type AppState, type Bot, type InstanceInfo } from "@/state/store";
import { ModelPicker } from "./ModelPicker";

const fixture = vi.hoisted(() => ({ owner: true, advanced: true, api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));
vi.mock("@/lib/interface-mode", async (original) => ({ ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => fixture.advanced }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const local: InstanceInfo = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", authenticated: true }, models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }] },
};
const glm: InstanceInfo = {
  instanceId: "openai-compat-glm", driverKind: "openai-compat", displayName: "GLM (Z.ai)", access: "api",
  snapshot: { state: "available", authenticated: true },
  icon: { kind: "preset", preset: "zai" }, url: "https://api.z.ai/api/paas/v4",
  models: { default: "glm-5.3", options: [{ id: "glm-5.3", label: "GLM-5.3" }, { id: "glm-4.6", label: "GLM-4.6" }] },
};
const bot: Bot = {
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", color: "green", notifications: true,
  unread: false, messages: [], modelSelection: { instanceId: "claude", model: "sonnet" },
};
const saveAction = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const refreshModels = vi.fn();

function Fixture({ readOnly = false }: { readOnly?: boolean }) {
  const [state, setState] = useState<AppState>({ ...initialState, bots: [bot], instances: [{ ...local, readOnly }], selectedId: bot.id });
  const dispatch = (action: Parameters<typeof reducer>[1]) => {
    saveAction(action);
    setState((previous) => reducer(previous, action));
  };
  refreshModels.mockResolvedValue(undefined);
  return createElement(BotEditorStore, {
    value: { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels },
    children: createElement(ModelPicker, { bot: state.bots[0]! }),
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.owner = true;
  fixture.advanced = true;
  fixture.api.mockReset().mockResolvedValue({ instanceId: glm.instanceId, instances: [local, glm] });
  refreshModels.mockClear();
  saveAction.mockClear();
  setLocale("en");
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

async function open(readOnly = false) {
  await act(async () => root.render(createElement(Fixture, { readOnly })));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-tour="model"]')!.click());
  return document.querySelector<HTMLElement>("[data-model-picker-content]")!;
}
const connect = '[data-model-glm-setup]';

it.each([
  ["international", "GLM (Z.ai)", "https://api.z.ai/api/paas/v4", true],
  ["china", "GLM (Zhipu BigModel)", "https://open.bigmodel.cn/api/paas/v4", false],
])("adds GLM in the %s region and selects a discovered model", async (region, displayName, url, advanced) => {
  fixture.api.mockResolvedValue({ instanceId: glm.instanceId, instances: [local, { ...glm, url, displayName }] });
  fixture.advanced = advanced;
  const menu = await open();
  const setup = menu.querySelector<HTMLButtonElement>(advanced ? connect : "[data-simple-glm-setup]");
  expect(setup).not.toBeNull();
  await act(async () => setup!.click());
  const form = menu.querySelector<HTMLFormElement>("form[data-glm-server]")!;
  const select = form.querySelector("select")!;
  await act(async () => { select.value = region; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const key = form.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, "  glm-test-key  ");
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(fixture.api).toHaveBeenCalledWith("/api/instances/openai-compat", { method: "POST", body: JSON.stringify({ displayName, url, key: "glm-test-key" }) });
  const model = [...menu.querySelectorAll<HTMLButtonElement>("[data-menu-row]")].find((row) => row.textContent?.includes("GLM-4.6"));
  expect(model).toBeDefined();
  await act(async () => model!.click());
  expect(saveAction).toHaveBeenCalledWith(expect.objectContaining({ type: "setModel", selection: { instanceId: glm.instanceId, model: "glm-4.6" } }));
});

it.each([true, false])("does not offer GLM setup without provider management access (readOnly=%s)", async (readOnly) => {
  fixture.owner = readOnly;
  expect((await open(readOnly)).querySelector(connect)).toBeNull();
});
