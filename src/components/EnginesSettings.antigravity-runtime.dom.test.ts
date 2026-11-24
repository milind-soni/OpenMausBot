// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> }, patches: [] as Array<{ path: string; body: unknown }> }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => {}, refreshModels: async () => {},
  }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PATCH") fixture.patches.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    return {};
  },
}));
import { EnginesSettings } from "./EnginesSettings";

function google(fields: Partial<InstanceInfo>): InstanceInfo {
  return {
    instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Google Gemini", cliDefault: "agy",
    snapshot: { state: "available", authenticated: true }, models: { default: "gemini", options: [] },
    install: { managed: { label: "Install Antigravity", downloadBytes: 1 } }, ...fields,
  } as InstanceInfo;
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.patches = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function show(instance: InstanceInfo) {
  fixture.state = { instances: [instance], bots: [], config: {} };
  await act(async () => { root.render(createElement(EnginesSettings)); });
  return container.querySelector<HTMLSelectElement>("[data-antigravity-runtime] select");
}

it.each([
  ["the CLI it runs", google({ cli: "agy", snapshot: { state: "available", authenticated: true, nativeCli: true } }), "cli"],
  ["the path antigravity", google({ cli: "antigravity", snapshot: { state: "unavailable" } }), "cli"],
  ["the path Antigravity.exe", google({ cli: "Antigravity.exe", snapshot: { state: "unavailable" } }), "cli"],
  ["a new install with nothing yet", google({ snapshot: { state: "unavailable" } }), "cli"],
  ["the pinned runtime it runs", google({ snapshot: { state: "available", authenticated: true, version: "1.4.3" } }), "pinned"],
  ["the path that asks for the pinned runtime", google({ cli: "agy_acp_server", snapshot: { state: "unavailable" } }), "pinned"],
  ["a path of the person's own", google({ cli: "/opt/agy/agy_acp_server.par", snapshot: { state: "available", version: "1.4.3" } }), "custom"],
  ["a native CLI at a path of the person's own", google({ cli: "/opt/tools/antigravity", snapshot: { state: "available", authenticated: true, nativeCli: true } }), "custom"],
])("shows what an Antigravity account runs, from %s", async (_from, instance, shown) => {
  const select = await show(instance);
  expect(select?.value).toBe(shown);
});

it.each([
  ["pinned", "agy_acp_server", google({ cli: "antigravity", snapshot: { state: "available", authenticated: true, nativeCli: true } })],
  ["cli", "antigravity", google({ snapshot: { state: "available", authenticated: true, version: "1.4.3" } })],
  ["cli", "antigravity", google({ cli: "/opt/tools/antigravity", snapshot: { state: "available", authenticated: true, nativeCli: true } })],
])("saves the path for %s when it is chosen", async (choice, path, instance) => {
  const select = await show(instance);
  await act(async () => {
    select!.value = choice;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(fixture.patches).toEqual([{ path: "/api/instances/antigravity", body: { cli: path } }]);
});
