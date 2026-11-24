// @vitest-environment happy-dom
// Settings → AI and the chat's AI sign-in card: every Google Gemini (Antigravity) account on one card, as Claude's and
// ChatGPT's are.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> },
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  startGate: null as Promise<void> | null,
  opened: [] as string[],
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => {}, refreshModels: async () => {},
  }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method) fixture.calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/instances/antigravity-accounts") {
      const added = google("antigravity-work", "Work", { authenticated: false });
      return { instanceId: added.instanceId, instances: [...fixture.state.instances, added] };
    }
    if (path.endsWith("/auth/start") && fixture.startGate) await fixture.startGate;
    if (path.endsWith("/auth/start")) return { auth: { phase: "waiting", flowId: `flow-${path.split("/")[3]}`, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" } };
    if (path.includes("/auth/status")) return { auth: { phase: "waiting" } };
    return {};
  },
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/state/team-people", async (original) => ({ ...await original<typeof import("@/state/team-people")>(), useTeamPeople: () => null }));
import { AiSignInSettings, EnginesSettings } from "./EnginesSettings";

function google(instanceId: string, displayName: string, snapshot: Partial<InstanceInfo["snapshot"]> = {}, extra: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId, driverKind: "antigravityAgent", displayName, cliDefault: "agy_acp_server",
    snapshot: { state: "available", authenticated: true, ...snapshot }, models: { default: "gemini", options: [] },
    install: { managed: { label: "Install Antigravity", downloadBytes: 1 } },
    authentication: { method: "callback-url", signOut: true }, ...extra,
  } as InstanceInfo;
}
const other = (instanceId: string, displayName: string): InstanceInfo => ({
  instanceId, driverKind: "opencodeGo", displayName, cliDefault: instanceId,
  snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] },
} as InstanceInfo);

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("open", (url: string) => { fixture.opened.push(url); return null; });
  setLocale("en");
  fixture.state = { instances: [google("antigravity", "Google Gemini (Antigravity)", { account: { email: "me@example.test" } })], bots: [], config: {} };
  fixture.calls = [];
  fixture.startGate = null;
  fixture.opened = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const more = { id: "more", open: false, onToggle: () => {} };
const render = async (view: "full" | "simple" | "chat" = "full") => {
  await act(async () => {
    root.render(view === "chat" ? createElement(AiSignInSettings) : view === "simple" ? createElement(EnginesSettings, { simple: true, more }) : createElement(EnginesSettings));
  });
};
const buttons = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].filter((item) => item.textContent === label);
const click = async (target: Element | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); };
const row = (instanceId: string) => container.querySelector(`[data-account="${instanceId}"]`)!;
const rows = () => [...container.querySelectorAll('[data-accounts="antigravity"] [data-account]')].map((item) => item.getAttribute("data-account"));
const startCalls = () => fixture.calls.filter((call) => call.path.endsWith("/auth/start")).map((call) => call.path);
async function openSimpleCard() {
  await render("simple");
  await click(container.querySelector('[data-simple-engine="antigravity"] button') ?? undefined);
}

describe("Google Gemini (Antigravity) accounts share one card", () => {
  it("lists an added account under the first one, even with other providers between them in the config", async () => {
    fixture.state.instances = [fixture.state.instances[0]!, other("opencodeGo", "OpenCode"), google("antigravity-work", "Work", { account: { email: "work@example.test" } })];
    await openSimpleCard();
    expect([...container.querySelectorAll("[data-simple-engine]")].map((item) => item.getAttribute("data-simple-engine")).filter((id) => id !== "google-ai-studio")).toEqual(["antigravity", "opencodeGo"]);
    expect(rows()).toEqual(["antigravity", "antigravity-work"]);
    expect(row("antigravity-work").textContent).toContain("work@example.test");
    expect(buttons(row("antigravity"), "Remove")).toHaveLength(0);
    expect(buttons(row("antigravity-work"), "Remove")).toHaveLength(1);
  });

  it("keeps the provider's name on its row when the first account is renamed", async () => {
    fixture.state.instances = [google("antigravity", "Personal"), google("antigravity-work", "Work")];
    await render("simple");
    expect(container.querySelector('[data-simple-engine="antigravity"]')?.textContent).toContain("Google Gemini (Antigravity)");
    expect(container.querySelector('[data-simple-engine="antigravity"]')?.textContent).not.toContain("Personal");
  });

  it("adds an account from the card and starts its Google sign-in under its own row, then closes it once signed in", async () => {
    await render();
    await click(buttons(container, "Add Google account")[0]);
    const input = container.querySelector<HTMLInputElement>("form[data-add-account] input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons(container, "Add and sign in")[0]);
    await render();
    expect(fixture.calls[0]).toEqual({ path: "/api/instances/antigravity-accounts", method: "POST", body: { displayName: "Work", sourceInstanceId: "antigravity" } });
    expect(rows()).toEqual(["antigravity", "antigravity-work"]);
    expect(startCalls()).toEqual(["/api/instances/antigravity-work/auth/start"]);
    expect(row("antigravity-work").querySelector("[data-account-sign-in]")?.textContent).toContain("Open Google sign-in again");

    fixture.state = { ...fixture.state, instances: [fixture.state.instances[0]!, google("antigravity-work", "Work", { account: { email: "work@example.test" } })] };
    await render();
    expect(row("antigravity-work").querySelector("[data-account-sign-in]")).toBeNull();

    fixture.state = { ...fixture.state, instances: [fixture.state.instances[0]!, google("antigravity-work", "Work", { authenticated: false })] };
    await render();
    expect(buttons(row("antigravity-work"), "Sign in")).toHaveLength(1);
  });

  it("keeps one account's Google sign-in waiting while another account signs in", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false }), google("antigravity-work", "Work", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity-work"), "Sign in")[0]);
    expect(startCalls()).toEqual(["/api/instances/antigravity/auth/start", "/api/instances/antigravity-work/auth/start"]);
    expect(row("antigravity").querySelector("[data-account-sign-in]")?.textContent).toContain("Open Google sign-in again");
    expect(row("antigravity-work").querySelector("[data-account-sign-in]")?.textContent).toContain("Open Google sign-in again");
  });

  it("cancels the account's Google sign-in on the server and closes its panel", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity"), "Cancel")[0]);
    expect(fixture.calls.at(-1)).toEqual({ path: "/api/instances/antigravity/auth/cancel", method: "POST", body: { flowId: "flow-antigravity" } });
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
    expect(buttons(row("antigravity"), "Sign in")).toHaveLength(1);
  });

  it("opens no Google page for a sign-in cancelled before it started, and ends that flow", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    let start!: () => void;
    fixture.startGate = new Promise((resolve) => { start = resolve; });
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity"), "Cancel")[0]);
    await act(async () => { start(); await fixture.startGate; });
    expect(fixture.opened).toEqual([]);
    expect(fixture.calls.at(-1)).toEqual({ path: "/api/instances/antigravity/auth/cancel", method: "POST", body: { flowId: "flow-antigravity" } });
  });

  it("closes the panel once the pasted redirect signs the account in, before its status is read again", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    const input = row("antigravity").querySelector<HTMLInputElement>("[data-redirect-paste] input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "http://127.0.0.1:1/?state=fixture&code=x");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons(row("antigravity"), "Send redirect")[0]);
    expect(fixture.calls.at(-1)).toMatchObject({ path: "/api/instances/antigravity/auth/complete", method: "POST" });
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
  });

  it("signs in an account whose status could not be read, rather than offering an install", async () => {
    fixture.state.instances = [google("antigravity", "Google Gemini (Antigravity)", { authenticated: undefined, nativeCli: true })];
    await render();
    expect(row("antigravity").getAttribute("data-account-state")).toBe("unknown");
    await click(buttons(row("antigravity"), "Sign in")[0]);
    expect(startCalls()).toEqual(["/api/instances/antigravity/auth/start"]);
    expect(row("antigravity").textContent).not.toContain("Install");
  });

  it("lists every account when none can run yet, each with its own setup", async () => {
    fixture.state.instances = [
      google("antigravity", "Personal", { state: "unavailable", authenticated: undefined, reason: "Not installed" }),
      google("antigravity-work", "Work", { state: "unavailable", authenticated: undefined, reason: "The custom path is missing" }),
    ];
    await render();
    expect(rows()).toEqual(["antigravity", "antigravity-work"]);
    expect(row("antigravity").querySelector('[data-account-setup="antigravity"]')).toBeTruthy();
    expect(row("antigravity-work").querySelector('[data-account-setup="antigravity-work"]')?.textContent).toContain("The custom path is missing");
    expect(buttons(container, "Add Google account")).toHaveLength(1);
  });

  it("keeps each account's CLI path in reach, in Settings and in the chat's sign-in card", async () => {
    fixture.state.instances = [google("antigravity", "Personal"), google("antigravity-work", "Work", {}, { cli: "/opt/work/agy_acp_server.par" })];
    for (const view of ["full", "chat"] as const) {
      await render(view);
      if (view === "chat") await click(container.querySelector('[data-simple-engine="antigravity"] button') ?? undefined);
      const advanced = [...container.querySelectorAll("details > summary")].map((item) => item.textContent).filter((text) => text?.startsWith("CLI path and updates"));
      expect(advanced).toEqual(["CLI path and updates · Personal", "CLI path and updates · Work"]);
      expect(container.textContent).toContain("/opt/work/agy_acp_server.par");
      expect(container.querySelector('[data-hide-engine="antigravity-work"]')).toBeTruthy();
    }
  });

  it("leaves an account with its own access setting on a card of its own, with its old controls", async () => {
    fixture.state.instances = [fixture.state.instances[0]!, google("antigravity-gw", "Gateway", {}, { access: "custom" })];
    await render();
    expect(rows()).toEqual(["antigravity"]);
    const card = container.querySelector('[data-engine-card="antigravity-gw"]')!;
    expect(card.querySelector("[data-account]")).toBeNull();
    expect(buttons(card, "Add Google account")).toHaveLength(1);
  });
});
