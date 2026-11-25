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
  it("offers Google AI Studio and adds its key as a Gemini server", async () => {
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

  it("lists Google AI Studio in the main provider list, outside the closed More providers fold", async () => {
    await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "more", open: false, onToggle: () => {} } })); });
    expect(studio()?.textContent).toContain("Google AI Studio");
    expect(studio()?.textContent).toContain("Not set up");
    expect(container.textContent).not.toContain("More providers");
  });

  it("keeps an added Gemini server in the main list while its key is not working", async () => {
    fixture.state = { ...fixture.state, instances: [{ ...gemini(GEMINI_URL), snapshot: { state: "available", authenticated: false } } as InstanceInfo] };
    await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "more", open: false, onToggle: () => {} } })); });
    expect(container.querySelector("[data-simple-engine=\"openai-compat-gemini\"]")?.textContent).toContain("Google Gemini");
    expect(container.textContent).not.toContain("More providers");
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

describe("Settings → AI → Providers: ModelGo sits in the main list, among its first three rows", () => {
  const provider = (instanceId: string, driverKind: string, snapshot: InstanceInfo["snapshot"] = { state: "unavailable", reason: "No API key" }) => ({
    instanceId, driverKind, displayName: instanceId === "modelgo" ? "ModelGo" : instanceId, access: "api", snapshot, models: { default: "model", options: [] },
  } as unknown as InstanceInfo);
  const closed = async () => { await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "more", open: false, onToggle: () => {} } })); }); };
  const order = () => [...container.querySelectorAll("[data-simple-engine]")].map((row) => row.getAttribute("data-simple-engine"));
  const moreCount = () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("More providers"))?.textContent;

  it("follows Google AI Studio when nothing else leads, outside More providers, which no longer counts it", async () => {
    fixture.state = { ...fixture.state, instances: [provider("groq", "groq"), provider("modelgo", "modelgo"), provider("mistral", "mistral")] };
    await closed();
    expect(order()).toEqual(["google-ai-studio", "modelgo"]);
    expect(container.querySelector("[data-simple-engine=\"modelgo\"]")?.textContent).toContain("ModelGo");
    expect(container.querySelector("[data-simple-engine=\"modelgo\"]")?.textContent).toContain("Not set up");
    expect(moreCount()).toContain("More providers"); expect(moreCount()).toContain("2");
    await render();
    expect(order().filter((id) => id === "modelgo"), "listed once, the fold open too").toHaveLength(1);
  });

  it("follows the ready rows where Google's row is not offered, and keeps a higher place, once, when it is ready itself", async () => {
    const ready = { state: "available", authenticated: true } as const;
    fixture.state = { ...fixture.state, instances: [provider("modelgo", "modelgo"), provider("groq", "groq", ready), gemini(GEMINI_URL)] };
    await closed();
    expect(order()).toEqual(["groq", "openai-compat-gemini", "modelgo"]);
    expect(container.textContent).not.toContain("More providers");
    fixture.state = { ...fixture.state, instances: [provider("groq", "groq", ready), provider("modelgo", "modelgo", ready), provider("mistral", "mistral")] };
    await closed();
    expect(order()).toEqual(["groq", "modelgo", "google-ai-studio"]);
  });

  it("stays folded where it may not be offered, and hidden once the person hid it", async () => {
    fixture.state = { ...fixture.state, instances: [provider("modelgo", "modelgo")], config: { managedPolicy: { organizationName: "Acme", companyModelsOnly: false, allowedEngines: ["groq"] } } };
    await closed();
    expect(order()).toEqual(["google-ai-studio"]);
    expect(moreCount()).toContain("1");
    fixture.state = { ...fixture.state, instances: [], config: {} };
    fixture.hidden = [{ instanceId: "modelgo", driverKind: "modelgo", displayName: "ModelGo" }];
    await closed();
    expect(order()).toEqual(["google-ai-studio"]);
    expect(moreCount()).toContain("1");
  });
});

describe("Settings → AI → Providers: ModelGo stands directly above Cursor, within the first three rows", () => {
  // The rows a fresh install lists first, in the server's order: sign-in agents lead the Simple list, Droid has no sign-in.
  const agent = (instanceId: string, driverKind: string, signIn = true) => ({
    instanceId, driverKind, displayName: instanceId, access: "subscription", cliDefault: instanceId, snapshot: { state: "unavailable", reason: "Not installed" },
    models: { default: "model", options: [] }, ...(signIn ? { authentication: { method: "browser" } } : {}),
  } as unknown as InstanceInfo);
  const key = (instanceId: string, driverKind: string, snapshot: InstanceInfo["snapshot"] = { state: "unavailable", reason: "No API key" }) => ({
    instanceId, driverKind, displayName: instanceId === "modelgo" ? "ModelGo" : instanceId, access: "api", snapshot, models: { default: "model", options: [] },
  } as unknown as InstanceInfo);
  const [grok, kimi, droid, cursor, vibe] = [agent("grok", "grokAgent"), agent("kimi", "kimiAgent"), agent("droid", "droidAgent", false), agent("cursor", "cursorAgent"), agent("mistralVibe", "mistralVibeAgent")];
  const fleet = [grok, kimi, droid, cursor, vibe, key("groq", "groq"), key("modelgo", "modelgo"), key("meta", "meta")];
  const simple = async (open = false) => { await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "more", open, onToggle: () => {} } })); }); };
  const advanced = async () => { await act(async () => { root.render(createElement(EnginesSettings)); }); };
  const order = () => [...container.querySelectorAll("[data-simple-engine]")].map((row) => row.getAttribute("data-simple-engine"));
  const cards = () => [...container.querySelectorAll("[data-engine-card]")].map((card) => card.getAttribute("data-engine-card"));
  const raised = (ids: Array<string | null>) => { expect(ids.indexOf("modelgo")).toBeGreaterThanOrEqual(0); expect(ids.indexOf("modelgo")).toBeLessThan(3); };

  it("takes Cursor's third place in the Simple list, the others keeping their order, and is listed once with the fold open", async () => {
    fixture.state = { ...fixture.state, instances: fleet };
    await simple();
    expect(order().slice(0, 6)).toEqual(["grok", "kimi", "modelgo", "cursor", "mistralVibe", "google-ai-studio"]);
    await simple(true);
    expect(order().filter((id) => id === "modelgo")).toHaveLength(1);
    expect(order().slice(0, 4)).toEqual(["grok", "kimi", "modelgo", "cursor"]);
  });

  it("goes directly above Cursor when Cursor leads, and third when Cursor is lower or gone", async () => {
    fixture.state = { ...fixture.state, instances: [cursor, grok, kimi, key("modelgo", "modelgo")] };
    await simple();
    expect(order().slice(0, 3)).toEqual(["modelgo", "cursor", "grok"]);
    fixture.state = { ...fixture.state, instances: [grok, kimi, vibe, cursor, key("modelgo", "modelgo")] };
    await simple();
    expect(order().slice(0, 5)).toEqual(["grok", "kimi", "modelgo", "mistralVibe", "cursor"]);
    fixture.state = { ...fixture.state, instances: [grok, kimi, vibe, key("modelgo", "modelgo")] };
    await simple();
    expect(order().slice(0, 4)).toEqual(["grok", "kimi", "modelgo", "mistralVibe"]);
  });

  it("keeps that place, once, when ModelGo is set up", async () => {
    fixture.state = { ...fixture.state, instances: [grok, kimi, droid, cursor, vibe, key("modelgo", "modelgo", { state: "available", authenticated: true })] };
    await simple(true);
    expect(order().slice(0, 4)).toEqual(["grok", "kimi", "modelgo", "cursor"]);
    expect(order().filter((id) => id === "modelgo")).toHaveLength(1);
  });

  it("leaves the order alone where ModelGo may not be offered, and stays hidden once hidden", async () => {
    fixture.state = { ...fixture.state, instances: fleet, config: { managedPolicy: { organizationName: "Acme", companyModelsOnly: false, allowedEngines: ["groq"] } } };
    await simple();
    expect(order().slice(0, 4)).toEqual(["grok", "kimi", "cursor", "mistralVibe"]);
    expect(order()).not.toContain("modelgo");
    fixture.state = { ...fixture.state, instances: fleet.filter((instance) => instance.instanceId !== "modelgo"), config: {} };
    fixture.hidden = [{ instanceId: "modelgo", driverKind: "modelgo", displayName: "ModelGo" }];
    await simple(true);
    expect(order().slice(0, 4)).toEqual(["grok", "kimi", "cursor", "mistralVibe"]);
    expect(order()).not.toContain("modelgo");
  });

  it("stands third, above Cursor, among the Advanced list's providers that need setting up", async () => {
    fixture.state = { ...fixture.state, instances: fleet };
    await advanced();
    expect(cards().slice(0, 5)).toEqual(["grok", "kimi", "modelgo", "droid", "cursor"]);
    raised(cards());
    const ready = { state: "available", authenticated: true } as const;
    fixture.state = { ...fixture.state, instances: [grok, cursor, key("groq", "groq", ready), key("mistral", "mistral", ready), key("meta", "meta", ready), key("modelgo", "modelgo", ready)] };
    await advanced();
    expect(cards(), "set up, it is third among the ready ones").toEqual(["groq", "mistral", "modelgo", "meta", "grok", "cursor"]);
    fixture.state = { ...fixture.state, instances: fleet, config: { managedPolicy: { organizationName: "Acme", companyModelsOnly: false, allowedEngines: ["groq"] } } };
    await advanced();
    expect(cards().slice(0, 4)).toEqual(["grok", "kimi", "droid", "cursor"]);
  });
});
