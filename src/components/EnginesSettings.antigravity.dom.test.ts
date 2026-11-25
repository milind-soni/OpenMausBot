// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> }, posts: [] as Array<{ path: string; body: unknown }> }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => {}, refreshModels: async () => {},
  }),
  api: async (path: string, init?: { body?: string }) => {
    if (path !== "/api/instances/antigravity-accounts") return {};
    fixture.posts.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    const added = google("antigravity-work", "Work", false);
    return { instanceId: added.instanceId, instances: [...fixture.state.instances, added] };
  },
}));
import { EnginesSettings } from "./EnginesSettings";

function google(instanceId: string, displayName: string, authenticated: boolean): InstanceInfo {
  return {
    instanceId, driverKind: "antigravityAgent", displayName, cliDefault: "agy",
    snapshot: { state: "available", authenticated }, models: { default: "gemini", options: [] },
    install: { managed: { label: "Install Antigravity", downloadBytes: 1 } },
  } as InstanceInfo;
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.state = { instances: [google("antigravity", "Google Gemini", true)], bots: [], config: {} };
  fixture.posts = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = async () => { await act(async () => { root.render(createElement(EnginesSettings)); }); };
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const click = async (target: Element | undefined) => { expect(target).toBeTruthy(); await act(async () => { (target as HTMLElement).click(); }); };
async function addWork() {
  await render();
  await click(button("Add Google account"));
  const input = container.querySelector<HTMLInputElement>("form[data-add-account] input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Add and sign in"));
}

describe("Settings → Google Gemini → Add Google account", () => {
  it("keeps the new account's Google sign-in under the card it was added from", async () => {
    await addWork();
    await render();
    expect(fixture.posts).toEqual([{ path: "/api/instances/antigravity-accounts", body: { displayName: "Work", sourceInstanceId: "antigravity" } }]);
    const added = container.querySelector("[data-antigravity-added]");
    expect(added?.getAttribute("data-antigravity-added")).toBe("antigravity-work");
    expect([...added!.querySelectorAll("button")].map((item) => item.textContent)).toContain("Sign in with Google");
    expect(added!.textContent).toContain("Work");
  });

  it("drops that sign-in from the card once the new account is signed in", async () => {
    await addWork();
    fixture.state = { ...fixture.state, instances: [google("antigravity", "Google Gemini", true), google("antigravity-work", "Work", true)] };
    await render();
    expect(container.querySelector("[data-antigravity-added]")).toBeNull();
  });
});
