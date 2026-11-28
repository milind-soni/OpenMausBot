// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import * as store from "@/state/store";
import { BuiltInCustomHeaders, OpenAiCompatCustomHeaders } from "./OpenAiCompatCustomHeaders";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  refreshInstances: vi.fn(),
  instances: [] as store.InstanceInfo[],
  config: undefined as store.ConfigStatus | undefined,
}));

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({
    state: { ...store.initialState, config: fixture.config, instances: fixture.instances },
    dispatch: fixture.dispatch,
    flushBotPatches: vi.fn(),
    refreshInstances: fixture.refreshInstances,
    refreshModels: vi.fn(),
  }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.refreshInstances.mockReset();
  fixture.instances = [];
  fixture.config = undefined;
});

afterEach(() => {
  root.unmount();
  host.remove();
});

const instance = (instanceId: string, customHeaders?: store.InstanceInfo["customHeaders"]): store.InstanceInfo => ({
  instanceId,
  driverKind: "openai-compat",
  displayName: "Gateway",
  snapshot: { state: "available" },
  models: { default: "m1", options: [] },
  ...(customHeaders ? { customHeaders } : {}),
}) as unknown as store.InstanceInfo;

describe("OpenAI-compatible custom request headers UI", () => {
  it("toggles enabled, adds header rows, inserts runtime {threadId} variable, and saves via PATCH /api/instances/:id", async () => {
    const server = instance("openai-compat-1");
    fixture.instances = [server];
    flushSync(() => root.render(createElement(OpenAiCompatCustomHeaders, { server })));

    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    flushSync(() => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    const addBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add header"))!;
    flushSync(() => addBtn.click());

    const nameInput = host.querySelector<HTMLInputElement>('input[aria-label="Header name 1"]')!;
    const valueInput = host.querySelector<HTMLInputElement>('input[aria-label="Header value 1"]')!;
    const varSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Insert runtime variable 1"]')!;

    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "X-Maus-Thread-ID");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      varSelect.value = "{threadId}";
      varSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(valueInput.value).toBe("{threadId}");

    fixture.api.mockResolvedValue({ instances: [server] });
    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save headers")!;
    flushSync(() => saveBtn.click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(1));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/openai-compat-1", {
      method: "PATCH",
      body: JSON.stringify({
        customHeaders: {
          enabled: true,
          headers: [{ name: "X-Maus-Thread-ID", value: "{threadId}", required: true, secret: false }],
        },
      }),
    });
  });

  it("keeps configured secret header values unexposed via keepExisting and hides BuiltInCustomHeaders until base URL is set", async () => {
    fixture.config = { openaiCompat: {} } as unknown as store.ConfigStatus;
    fixture.instances = [instance("openaiCompat")];
    flushSync(() => root.render(createElement(BuiltInCustomHeaders)));
    expect(host.querySelector('button[role="switch"]')).toBeNull();

    const server = instance("openaiCompat", {
      enabled: true,
      headers: [{ name: "X-Gateway-Token", configured: true, required: true, secret: true }],
    });
    fixture.config = { openaiCompat: { url: "https://gw.example/v1" } } as unknown as store.ConfigStatus;
    fixture.instances = [server];
    flushSync(() => root.render(createElement(BuiltInCustomHeaders)));

    fixture.api.mockResolvedValue({ instances: [server] });
    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save headers")!;
    flushSync(() => saveBtn.click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(saveBtn.disabled).toBe(false));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/openaiCompat", {
      method: "PATCH",
      body: JSON.stringify({
        customHeaders: {
          enabled: true,
          headers: [{ name: "X-Gateway-Token", keepExisting: true, required: true, secret: true }],
        },
      }),
    });

    const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const secretBox = checkboxes[1]!;
    const valueInput = host.querySelector<HTMLInputElement>('input[aria-label="Header value 1"]')!;
    expect(valueInput.type).toBe("password");
    flushSync(() => secretBox.click());
    expect(secretBox.checked).toBe(false);
    expect(valueInput.type).toBe("text");

    fixture.api.mockClear();
    flushSync(() => saveBtn.click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(1));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/openaiCompat", {
      method: "PATCH",
      body: JSON.stringify({
        customHeaders: {
          enabled: true,
          headers: [{ name: "X-Gateway-Token", value: "", required: true, secret: false }],
        },
      }),
    });
  });
});
