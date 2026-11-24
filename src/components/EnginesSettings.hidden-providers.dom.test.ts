// @vitest-environment happy-dom
// Settings → AI → Providers against a small model of the server: a hidden provider leaves /api/instances (as
// withInstanceConfig does) and is listed only by /api/instances/hidden.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";
import { BUILT_IN_INSTANCE_DRIVERS } from "@/lib/built-in-instances";

const server = vi.hoisted(() => ({
  all: [] as InstanceInfo[], hidden: new Set<string>(), calls: [] as Array<{ method: string; path: string; body?: unknown }>, refuseUnhide: false, refreshes: 0,
  holdHidden: null as Promise<void> | null,
}));
const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> } }));
vi.mock("@/state/store", async (original) => {
  const visible = () => server.all.filter((instance) => !server.hidden.has(instance.instanceId));
  const refresh = async () => { server.refreshes++; fixture.state = { ...fixture.state, instances: visible() }; };
  return {
    ...await original<typeof import("@/state/store")>(),
    useStore: () => ({
      state: fixture.state,
      dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
      refreshInstances: refresh, refreshModels: async () => {},
    }),
    api: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      server.calls.push({ method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      if (path === "/api/instances/hidden") {
        await server.holdHidden;
        return { instances: server.all.filter((instance) => server.hidden.has(instance.instanceId)).map(({ instanceId, driverKind, displayName }) => ({ instanceId, driverKind, displayName })) };
      }
      const signOut = /^\/api\/instances\/([\w.-]+)\/auth\/sign-out$/.exec(path);
      if (signOut) {
        server.all = server.all.map((instance) => instance.instanceId === signOut[1] ? { ...instance, snapshot: { state: "available", authenticated: false } } : instance);
        return { instances: visible() };
      }
      const patch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
      if (patch && method === "PATCH") {
        const { hidden } = JSON.parse(init!.body!) as { hidden?: boolean };
        if (hidden === false && server.refuseUnhide) throw new Error("provider settings are already being updated");
        if (hidden === true) server.hidden.add(patch[1]!);
        if (hidden === false) server.hidden.delete(patch[1]!);
        return { instances: visible() };
      }
      return {};
    },
  };
});
const { EnginesSettings } = await import("./EnginesSettings");
const { accountGroupOf } = await import("./EngineAccounts");

const kimi = (authenticated: boolean): InstanceInfo => ({
  instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi", cliDefault: "kimi",
  snapshot: { state: "available", authenticated, version: "kimi 2.5.2" }, models: { default: "kimi-for-coding", options: [] },
  authentication: { method: "device-code", signOut: true }, install: { signInCommand: "kimi login" },
});
const codex: InstanceInfo = {
  instanceId: "codex", driverKind: "codex", displayName: "Codex", cliDefault: "codex",
  snapshot: { state: "available", authenticated: true }, models: { default: "gpt", options: [] },
};

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  server.all = [codex, kimi(true)];
  server.hidden = new Set();
  server.calls = [];
  server.refuseUnhide = false;
  server.refreshes = 0;
  server.holdHidden = null;
  fixture.state = { instances: [...server.all], bots: [], config: {} };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const render = async (open = true) => {
  await act(async () => { root.render(createElement(EnginesSettings, { simple: true, more: { id: "ai-more", open, onToggle: () => {} } })); });
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const rows = () => [...container.querySelectorAll("[data-simple-engine]")].map((row) => row.getAttribute("data-simple-engine"));
const hiddenRows = () => [...container.querySelectorAll("[data-hidden-engine]")].map((row) => row.getAttribute("data-hidden-engine"));
const click = async (target: Element | null | undefined) => {
  expect(target).toBeTruthy();
  await act(async () => { (target as HTMLElement).click(); });
  await render();
};
const rowButton = (instanceId: string) => container.querySelector(`[data-simple-engine="${instanceId}"] button`);
const moreCount = () => container.querySelector('[data-settings-disclosure="ai-more"]')?.textContent;

describe("Settings → AI: a provider hidden from its own card", () => {
  it("stays listed under More providers → Hidden, and Unhide brings it back with its row", async () => {
    await render();
    expect(rows()).toContain("kimi");
    await click(rowButton("kimi"));
    // The Hide button on the connected card (the customer's "disconnect").
    await click(container.querySelector('[data-hide-engine="kimi"]'));
    expect(server.calls).toContainEqual({ method: "PATCH", path: "/api/instances/kimi", body: { hidden: true } });
    expect(fixture.state.instances.map((instance) => instance.instanceId)).toEqual(["codex"]);

    expect(rows()).not.toContain("kimi");
    expect(hiddenRows()).toEqual(["kimi"]);
    expect(server.refreshes).toBe(0);
    expect(moreCount()).toContain("More providers");
    // Only hidden Kimi: the Google AI Studio row is in the main list.
    expect(moreCount()).toMatch(/\D1$/);
    const hiddenRow = container.querySelector('[data-hidden-engine="kimi"]')!;
    expect(hiddenRow.textContent).toContain("Kimi");
    expect(hiddenRow.textContent).toContain(t("settings.ai.hiddenStatus"));
    expect(hiddenRow.querySelector("svg")).toBeTruthy();

    expect(hiddenRow.querySelector('[data-unhide-engine="kimi"]')?.getAttribute("aria-label")).toBe("Unhide Kimi");
    await click(hiddenRow.querySelector('[data-unhide-engine="kimi"]'));
    expect(server.calls).toContainEqual({ method: "PATCH", path: "/api/instances/kimi", body: { hidden: false } });
    expect(rows()).toContain("kimi");
    expect(hiddenRows()).toEqual([]);
    expect(server.refreshes).toBe(0);
  });

  it("keeps the More providers row while every provider left in it is hidden", async () => {
    server.hidden.add("kimi");
    fixture.state = { ...fixture.state, instances: [codex] };
    await render(false);
    expect(moreCount()).toMatch(/\D1$/);
    expect(hiddenRows()).toEqual([]);
    await render(true);
    expect(hiddenRows()).toEqual(["kimi"]);
  });

  it("keeps a hidden provider listed, with the server's refusal, when Unhide fails", async () => {
    server.hidden.add("kimi");
    server.refuseUnhide = true;
    fixture.state = { ...fixture.state, instances: [codex] };
    await render();
    await click(container.querySelector('[data-unhide-engine="kimi"]'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("provider settings are already being updated");
    expect(hiddenRows()).toEqual(["kimi"]);
    expect(rows()).not.toContain("kimi");
  });

  it.each([
    ["is still pending", (release: { done: () => void; fail: () => void }) => release.done()],
    ["fails", (release: { done: () => void; fail: () => void }) => release.fail()],
  ])("drops an unhidden provider from the hidden rows before the hidden list is read again, and when that read %s", async (_name, settle) => {
    server.hidden.add("kimi");
    fixture.state = { ...fixture.state, instances: [codex] };
    await render();
    expect(hiddenRows()).toEqual(["kimi"]);
    const release = { done: () => {}, fail: () => {} };
    server.holdHidden = new Promise<void>((resolve, reject) => { release.done = resolve; release.fail = () => reject(new Error("offline")); });
    server.holdHidden.catch(() => {});
    await click(container.querySelector('[data-unhide-engine="kimi"]'));
    expect(rows().filter((id) => id === "kimi")).toEqual(["kimi"]);
    expect(hiddenRows()).toEqual([]);
    await act(async () => { settle(release); await server.holdHidden!.catch(() => {}); });
    expect(rows().filter((id) => id === "kimi")).toEqual(["kimi"]);
    expect(hiddenRows()).toEqual([]);
  });

  it("signs a connected CLI out from its card without hiding it", async () => {
    await render();
    await click(rowButton("kimi"));
    const signOut = container.querySelector('[data-engine-sign-out="kimi"] button');
    expect(signOut?.textContent).toBe("Sign out");
    expect(signOut?.getAttribute("aria-label")).toBe("Sign out of Kimi");
    await click(signOut);
    // The dialog says the CLI's own sign-in on this computer goes too.
    expect(document.body.querySelector("[data-sign-out-cli]")?.textContent).toBe(t("accounts.signOutCliBody", { name: "Kimi" }));
    const confirm = [...document.body.querySelectorAll("button")].filter((button) => button.textContent === "Sign out").at(-1);
    await click(confirm);
    expect(server.calls).toContainEqual({ method: "POST", path: "/api/instances/kimi/auth/sign-out" });
    expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
    await act(async () => { fixture.state = { ...fixture.state, instances: server.all }; });
    await render();
    expect(rows()).toContain("kimi");
    expect(rowButton("kimi")?.textContent).not.toBe("Manage");
    expect(hiddenRows()).toEqual([]);
  });
});

describe("Settings → AI: Sign out on other CLI sign-ins", () => {
  const grok: InstanceInfo = {
    instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", cliDefault: "grok",
    snapshot: { state: "available", authenticated: true }, models: { default: "grok", options: [] },
    authentication: { method: "device-code", signOut: true },
  };
  const vibe = (account?: { method: "api-key" }): InstanceInfo => ({
    instanceId: "mistralVibe", driverKind: "mistralVibeAgent", displayName: "Mistral (Vibe)", cliDefault: "vibe-acp",
    snapshot: { state: "available", authenticated: true, ...(account ? { account } : {}) }, models: { default: "mistral-medium-3.5", options: [] },
    authentication: { method: "browser", signOut: true },
  });

  it.each([["Grok", grok], ["Mistral (Vibe)", vibe()]] as const)("signs %s out through its own sign-out", async (name, engine) => {
    server.all = [codex, engine];
    fixture.state = { ...fixture.state, instances: [...server.all] };
    await render();
    await click(rowButton(engine.instanceId));
    const signOut = container.querySelector(`[data-engine-sign-out="${engine.instanceId}"] button`);
    expect(signOut?.getAttribute("aria-label")).toBe(`Sign out of ${name}`);
    await click(signOut);
    expect(document.body.querySelector("[data-sign-out-cli]")?.textContent).toContain(name);
    await click([...document.body.querySelectorAll("button")].filter((button) => button.textContent === "Sign out").at(-1));
    expect(server.calls).toContainEqual({ method: "POST", path: `/api/instances/${engine.instanceId}/auth/sign-out` });
    expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("offers no Sign out to an engine an API key signs in", async () => {
    server.all = [codex, vibe({ method: "api-key" })];
    fixture.state = { ...fixture.state, instances: [...server.all] };
    await render();
    await click(rowButton("mistralVibe"));
    expect(container.querySelector('[data-engine-card="mistralVibe"]')).toBeTruthy();
    expect(container.querySelector('[data-engine-sign-out="mistralVibe"]')).toBeNull();
  });
});

// Drivers whose instances carry no CLI: the server marks them API-key engines.
const API_DRIVERS = new Set(["openai-compat", "mistral", "cerebras", "groq", "greenference", "modelgo", "meta", "grok"]);
const STATES: Record<string, InstanceInfo["snapshot"] | "hidden"> = {
  "never set up, CLI missing": { state: "unavailable", reason: "CLI not found" },
  connected: { state: "available", authenticated: true },
  "signed out": { state: "available", authenticated: false },
  "sign-in unknown": { state: "available" },
  hidden: "hidden",
};

describe("Settings → AI lists every provider the app knows", () => {
  const catalog = Object.entries(BUILT_IN_INSTANCE_DRIVERS);
  const instance = ([instanceId, driverKind]: [string, string], index: number, snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
    instanceId, driverKind, displayName: instanceId, snapshot, models: { default: "model", options: [] },
    ...(API_DRIVERS.has(driverKind) ? { access: "api" as const } : { cliDefault: instanceId }),
    // Half sign in by account (the featured rows), half not (folded under More providers).
    ...(index % 2 === 0 ? { authentication: { method: "device-code" as const, signOut: true } } : {}),
  });

  it.each(Object.keys(STATES))("reaches each one when it is %s", async (name) => {
    const state = STATES[name]!;
    const all = catalog.map((entry, index) => instance(entry, index, state === "hidden" ? { state: "available", authenticated: true } : state));
    server.all = all;
    server.hidden = new Set(state === "hidden" ? all.map((one) => one.instanceId) : []);
    fixture.state = { ...fixture.state, instances: all.filter((one) => !server.hidden.has(one.instanceId)) };
    await render();
    const shown = new Set(rows());
    const hidden = new Set(hiddenRows());
    const unreachable = all.filter((one) => {
      if (shown.has(one.instanceId) || hidden.has(one.instanceId)) return false;
      // A provider's accounts share one card, the row of its first account.
      const group = accountGroupOf(one);
      return !(group && all.some((other) => accountGroupOf(other) === group && shown.has(other.instanceId)));
    }).map((one) => one.instanceId);
    expect(unreachable).toEqual([]);
    if (state === "hidden") expect(hidden.size).toBe(all.length);
  });
});

describe("Settings → AI → ChatGPT: the built-in account rows can be hidden", () => {
  const codexAccount: InstanceInfo = { ...codex, authentication: { method: "device-code", signOut: true } };
  const plan: InstanceInfo = {
    instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan", cliDefault: "codex",
    snapshot: { state: "available", authenticated: false, chatgptPlan: true }, models: { default: "gpt", options: [] },
    authentication: { method: "browser-pkce", signOut: true },
  };
  const added: InstanceInfo = { ...plan, instanceId: "chatgpt-work", displayName: "Work" };
  const accounts = () => [...container.querySelectorAll("[data-account]")].map((row) => row.getAttribute("data-account"));
  const menuItems = async (instanceId: string) => {
    await click(container.querySelector(`[data-account="${instanceId}"] button[aria-haspopup="menu"]`));
    return [...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
  };
  const openCard = async () => { await render(); await click(rowButton("codex")); };

  beforeEach(() => {
    server.all = [codexAccount, plan, added];
    fixture.state = { ...fixture.state, instances: [...server.all] };
  });

  it("hides only the signed-out ChatGPT plan row, and Unhide brings it back to the card", async () => {
    await openCard();
    expect(accounts()).toEqual(["codex", "chatgpt", "chatgpt-work"]);
    const hide = (await menuItems("chatgpt")).find((item) => item.textContent === "Hide");
    await click(hide);
    expect(server.calls).toContainEqual({ method: "PATCH", path: "/api/instances/chatgpt", body: { hidden: true } });
    expect(accounts()).toEqual(["codex", "chatgpt-work"]);
    expect(hiddenRows()).toEqual(["chatgpt"]);
    await click(container.querySelector('[data-unhide-engine="chatgpt"]'));
    expect(server.calls).toContainEqual({ method: "PATCH", path: "/api/instances/chatgpt", body: { hidden: false } });
    expect(accounts()).toEqual(["codex", "chatgpt", "chatgpt-work"]);
    expect(hiddenRows()).toEqual([]);
    expect(server.refreshes).toBe(0);
  });

  it("offers Hide on the Codex row too", async () => {
    await openCard();
    expect((await menuItems("codex")).map((item) => item.textContent)).toContain("Hide");
  });

  it("keeps Remove, not Hide, for an added account", async () => {
    await openCard();
    expect((await menuItems("chatgpt-work")).map((item) => item.textContent)).not.toContain("Hide");
    expect(container.querySelector('[data-account="chatgpt-work"]')?.textContent).toContain("Remove");
  });

  it("won't hide an account a bot still uses", async () => {
    fixture.state = { ...fixture.state, bots: [{ modelSelection: { instanceId: "chatgpt" } } as Bot] };
    await openCard();
    const hide = (await menuItems("chatgpt")).find((item) => item.textContent === "Hide");
    expect(hide?.disabled).toBe(true);
    expect(container.textContent).toContain(t("accounts.inUse", { count: "1" }));
  });

  it("won't hide an account a bot only keeps as a backup AI", async () => {
    fixture.state = { ...fixture.state, bots: [{ modelSelection: { instanceId: "codex" }, fallback: [{ instanceId: "chatgpt", model: "gpt-5" }] } as Bot] };
    await openCard();
    const hide = (await menuItems("chatgpt")).find((item) => item.textContent === "Hide");
    expect(hide?.disabled).toBe(true);
    expect(container.textContent).toContain(t("accounts.inUse", { count: "1" }));
  });
});
