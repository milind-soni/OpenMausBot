// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> },
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  startGate: null as Promise<void> | null,
  completeGate: null as Promise<void> | null,
  cancelGate: null as Promise<void> | null,
  refreshGate: null as Promise<void> | null,
  opened: [] as string[],
  cancelFails: false,
  modelsFail: false,
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => { if (fixture.refreshGate) await fixture.refreshGate; }, refreshModels: async () => { if (fixture.modelsFail) throw new Error("Could not read the models."); },
  }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method) fixture.calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/instances/antigravity-accounts") {
      const added = google("antigravity-work", "Work", { authenticated: false });
      return { instanceId: added.instanceId, instances: [...fixture.state.instances, added] };
    }
    if (path.endsWith("/auth/start") && fixture.startGate) await fixture.startGate;
    if (path.endsWith("/auth/complete") && fixture.completeGate) await fixture.completeGate;
    if (path.endsWith("/auth/cancel") && fixture.cancelGate) await fixture.cancelGate;
    if (path.endsWith("/auth/cancel") && fixture.cancelFails) throw new Error("The sign-in is finishing. Try again in a moment.");
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
  fixture.completeGate = null;
  fixture.cancelGate = null;
  fixture.refreshGate = null;
  fixture.opened = [];
  fixture.cancelFails = false;
  fixture.modelsFail = false;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const more = { id: "more", open: false, onToggle: () => {} };
const render = async (view: "full" | "simple" | "chat" | "strict" = "full") => {
  await act(async () => {
    root.render(view === "chat" ? createElement(AiSignInSettings) : view === "simple" ? createElement(EnginesSettings, { simple: true, more })
      : view === "strict" ? createElement(StrictMode, null, createElement(EnginesSettings)) : createElement(EnginesSettings));
  });
};
const buttons = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].filter((item) => item.textContent === label);
const click = async (target: Element | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); };
const row = (instanceId: string) => container.querySelector(`[data-account="${instanceId}"]`)!;
const rows = () => [...container.querySelectorAll('[data-accounts="antigravity"] [data-account]')].map((item) => item.getAttribute("data-account"));
const usable = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")]
  .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true").map((item) => item.textContent || item.getAttribute("aria-label"));
const gate = () => { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open: () => act(async () => { open(); await promise; }) }; };
const startCalls = () => fixture.calls.filter((call) => call.path.endsWith("/auth/start")).map((call) => call.path);
async function pasteRedirect(instanceId: string) {
  const input = row(instanceId).querySelector<HTMLInputElement>("[data-redirect-paste] input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "http://127.0.0.1:1/?state=fixture&code=x");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const nextFrame = () => act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
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

  it("opens no Google page for a sign-in cancelled before it started, and keeps it until that flow is ended", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    const start = gate();
    fixture.startGate = start.promise;
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity"), "Cancel")[0]);
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeTruthy();
    expect(usable(row("antigravity").querySelector("[data-account-sign-in]")!)).toEqual([]);
    await start.open();
    expect(fixture.opened).toEqual([]);
    expect(fixture.calls.at(-1)).toEqual({ path: "/api/instances/antigravity/auth/cancel", method: "POST", body: { flowId: "flow-antigravity" } });
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
  });

  it("keeps a sign-in cancelled before it started open with its Google link when the server refuses the cancel", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    fixture.cancelFails = true;
    const start = gate();
    fixture.startGate = start.promise;
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity"), "Cancel")[0]);
    await start.open();
    const panel = row("antigravity").querySelector("[data-account-sign-in]")!;
    expect(panel.textContent).toContain("The sign-in is finishing. Try again in a moment.");
    expect(usable(panel)).toContain("Open Google sign-in again");
    expect(usable(panel)).toContain("Cancel");
    expect(fixture.opened).toEqual([]);
  });

  it("keeps the sign-in's controls held until the cancel answers, even when a status check ends first", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    const refresh = gate(), cancel = gate();
    fixture.refreshGate = refresh.promise;
    fixture.cancelGate = cancel.promise;
    await click(buttons(row("antigravity"), "I finished signing in")[0]);
    await click(buttons(row("antigravity"), "Cancel")[0]);
    await refresh.open();
    expect(usable(row("antigravity").querySelector("[data-account-sign-in]")!)).toEqual([]);
    await cancel.open();
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
  });

  it("offers no Rename while the account is signing in", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(container.querySelector('[aria-label="Options for Personal"]') ?? undefined);
    expect(row("antigravity").querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(false);
    await click(container.querySelector('[aria-label="Options for Personal"]') ?? undefined);
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(container.querySelector('[aria-label="Options for Personal"]') ?? undefined);
    expect(buttons(row("antigravity"), "Rename")[0]?.disabled).toBe(true);
  });

  it("closes the panel once the pasted redirect signs the account in, before its status is read again", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await pasteRedirect("antigravity");
    await click(buttons(row("antigravity"), "Send redirect")[0]);
    expect(fixture.calls.at(-1)).toMatchObject({ path: "/api/instances/antigravity/auth/complete", method: "POST" });
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
  });

  it("moves focus into the sign-in it opens, and back to Sign in when it is cancelled", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(row("antigravity").querySelector("[data-account-sign-in]")?.contains(document.activeElement)).toBe(true);
    const cancel = gate();
    fixture.cancelGate = cancel.promise;
    buttons(row("antigravity"), "Cancel")[0]!.focus();
    await click(buttons(row("antigravity"), "Cancel")[0]);
    expect(document.activeElement).toBe(buttons(row("antigravity"), "Cancel")[0]);
    await cancel.open();
    expect(document.activeElement).toBe(buttons(row("antigravity"), "Sign in")[0]);
  });

  it("leaves focus on the page when it left the sign-in before the cancel answered", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await nextFrame();
    const cancel = gate();
    fixture.cancelGate = cancel.promise;
    await click(buttons(row("antigravity"), "Cancel")[0]);
    (document.activeElement as HTMLElement).blur();
    await cancel.open();
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus where it is when another account's sign-in finishes", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false }), google("antigravity-work", "Work", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity-work"), "Sign in")[0]);
    await nextFrame();
    const typing = row("antigravity-work").querySelector<HTMLInputElement>("[data-redirect-paste] input")!;
    typing.focus();
    await pasteRedirect("antigravity");
    await act(async () => { buttons(row("antigravity"), "Send redirect")[0]!.click(); });
    await nextFrame();
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
    expect(document.activeElement).toBe(typing);
  });

  it("moves focus into the sign-in of an account just added, also under StrictMode", async () => {
    await render("strict");
    await click(buttons(container, "Add Google account")[0]);
    const input = container.querySelector<HTMLInputElement>("form[data-add-account] input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons(container, "Add and sign in")[0]);
    await render("strict");
    await nextFrame();
    expect(row("antigravity-work").querySelector("[data-account-sign-in]")?.contains(document.activeElement)).toBe(true);
  });

  it("holds every control of a sign-in while it is being cancelled", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    let cancelled!: () => void;
    fixture.cancelGate = new Promise((resolve) => { cancelled = resolve; });
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await pasteRedirect("antigravity");
    await click(buttons(row("antigravity"), "Cancel")[0]);
    const panel = row("antigravity").querySelector("[data-account-sign-in]")!;
    expect(usable(panel)).toEqual([]);
    await act(async () => { cancelled(); await fixture.cancelGate; });
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
  });

  it("keeps the sign-in open and says why when the server could not cancel it", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    fixture.cancelFails = true;
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await click(buttons(row("antigravity"), "Cancel")[0]);
    expect(row("antigravity").querySelector("[data-account-sign-in]")?.textContent).toContain("The sign-in is finishing. Try again in a moment.");
  });

  it("offers no Cancel while a pasted redirect is being sent", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    let send!: () => void;
    fixture.completeGate = new Promise((resolve) => { send = resolve; });
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await pasteRedirect("antigravity");
    await click(buttons(row("antigravity"), "Send redirect")[0]);
    expect(usable(row("antigravity"))).not.toContain("Cancel");
    expect(usable(row("antigravity"))).not.toContain("I finished signing in");
    await act(async () => { send(); await fixture.completeGate; });
  });

  it("offers no second sign-in once a pasted redirect is accepted, while the account is read again", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await pasteRedirect("antigravity");
    const refresh = gate();
    fixture.refreshGate = refresh.promise;
    await click(buttons(row("antigravity"), "Send redirect")[0]);
    expect(usable(row("antigravity"))).not.toContain("Sign in");
    expect(usable(row("antigravity"))).not.toContain("Open Google sign-in again");
    await refresh.open();
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
  });

  it("adds an account with the path of one that can run, when the first cannot", async () => {
    fixture.state.instances = [
      google("antigravity", "Personal", { state: "unavailable", authenticated: undefined, reason: "Not installed" }),
      google("antigravity-native", "Native", {}, { cli: "/opt/agy/antigravity" }),
    ];
    await render();
    await click(buttons(container, "Add Google account")[0]);
    const input = container.querySelector<HTMLInputElement>("form[data-add-account] input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttons(container, "Add and sign in")[0]);
    expect(fixture.calls[0]?.body).toEqual({ displayName: "Work", sourceInstanceId: "antigravity-native" });
  });

  it("does not start a sign-in again for an account hidden while it waited and shown again", async () => {
    const work = google("antigravity-work", "Work", { authenticated: false });
    fixture.state.instances = [fixture.state.instances[0]!, work];
    await render();
    await click(buttons(row("antigravity-work"), "Sign in")[0]);
    fixture.state = { ...fixture.state, instances: [fixture.state.instances[0]!] };
    await render();
    fixture.state = { ...fixture.state, instances: [fixture.state.instances[0]!, work] };
    await render();
    expect(startCalls()).toEqual(["/api/instances/antigravity-work/auth/start"]);
    expect(row("antigravity-work").querySelector("[data-account-sign-in]")).toBeNull();
    expect(buttons(row("antigravity-work"), "Sign in")).toHaveLength(1);
  });

  it("closes the panel of a sign-in the server accepted even when the models cannot be read yet", async () => {
    fixture.state.instances = [google("antigravity", "Personal", { authenticated: false })];
    fixture.modelsFail = true;
    await render();
    await click(buttons(row("antigravity"), "Sign in")[0]);
    await pasteRedirect("antigravity");
    await click(buttons(row("antigravity"), "Send redirect")[0]);
    expect(row("antigravity").querySelector("[data-account-sign-in]")).toBeNull();
    expect(container.textContent).not.toContain("Could not read the models.");
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
