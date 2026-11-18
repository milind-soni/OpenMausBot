// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> }, posts: [] as Array<{ path: string; body: unknown }>, hidden: [] as unknown[] }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => {}, refreshModels: async () => {},
  }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/instances/hidden") return { instances: fixture.hidden };
    if (init?.method !== "POST") return {};
    const body = JSON.parse(init.body ?? "{}") as { displayName: string; url: string };
    fixture.posts.push({ path, body });
    return { instances: [...fixture.state.instances, gemini(body.url)] };
  },
}));
import { AiSignInSettings, EnginesSettings } from "./EnginesSettings";

function gemini(url: string): InstanceInfo {
  return {
    instanceId: "openai-compat-gemini", driverKind: "openai-compat", displayName: "Google Gemini", access: "api", url,
    snapshot: { state: "available", authenticated: true }, models: { default: "gemini-2.5-flash", options: [] },
  } as unknown as InstanceInfo;
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.state = { instances: [], bots: [], config: {} };
  fixture.posts = [];
  fixture.hidden = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = async () => {
  await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "more", open: true, onToggle: () => {} } })); });
};
const studio = () => container.querySelector("[data-simple-engine=\"google-ai-studio\"]");
const click = async (target: Element | null | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Settings → AI → Providers: Google AI Studio (#6352)", () => {
  it("offers Google AI Studio under More providers and adds its key as a Gemini server", async () => {
    await render();
    expect(studio()?.textContent).toContain("Google AI Studio");
    await click(studio()!.querySelector("button"));
    const fold = container.querySelector("[data-provider-fold=\"google-ai-studio\"]")!;
    expect(fold.querySelector("a")?.getAttribute("href")).toBe("https://aistudio.google.com/api-keys");
    const add = [...fold.querySelectorAll("button")].find((button) => button.textContent === "Add Google AI Studio")!;
    expect(add.disabled).toBe(true);
    await type(fold.querySelector("input[type=password]")!, "  AIza-test-key  ");
    await click(add);
    expect(fixture.posts).toEqual([{ path: "/api/instances/openai-compat", body: { displayName: "Google Gemini", url: GEMINI_URL, key: "AIza-test-key" } }]);

    await render();
    expect(studio()).toBeNull();
    expect(container.querySelector("[data-simple-engine=\"openai-compat-gemini\"]")?.textContent).toContain("Google Gemini");
  });

  it("is not offered once a Gemini server is added, nor on the chat's sign-in card", async () => {
    fixture.state = { ...fixture.state, instances: [gemini(GEMINI_URL)] };
    await render();
    expect(studio()).toBeNull();
    // Google's address with another path is still that server.
    fixture.state = { ...fixture.state, instances: [gemini("https://generativelanguage.googleapis.com/v1beta/openai/")] };
    await render();
    expect(studio()).toBeNull();
    fixture.state = { ...fixture.state, instances: [] };
    await act(async () => { root.render(createElement(AiSignInSettings)); });
    expect(container.querySelector("[data-ai-sign-in]")).not.toBeNull();
    expect(studio()).toBeNull();
  });

  it("is not offered while a Gemini server is hidden, nor in a hosted workspace that cannot add one", async () => {
    fixture.hidden = [{ instanceId: "openai-compat-gemini", driverKind: "openai-compat", displayName: "Google Gemini" }];
    await render();
    expect(studio()).toBeNull();
    expect(container.textContent).toContain("Google Gemini");

    fixture.hidden = [];
    fixture.state = { ...fixture.state, instances: [{
      instanceId: "claude", driverKind: "claude", displayName: "Claude", readOnly: true,
      snapshot: { state: "available", authenticated: true }, models: { default: "sonnet", options: [] },
    } as unknown as InstanceInfo] };
    await render();
    expect(container.querySelector("[data-simple-engine]")).not.toBeNull();
    expect(studio()).toBeNull();
  });
});
