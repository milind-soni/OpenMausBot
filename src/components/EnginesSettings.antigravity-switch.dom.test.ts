// @vitest-environment happy-dom
// Settings → AI → Google Gemini: no runtime selector on an Antigravity account, and one way from the Classic runtime to
// Google's Antigravity CLI.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  state: { instances: [] as InstanceInfo[], bots: [] as Bot[], config: {} as Record<string, unknown> },
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  installFails: false,
  afterRefresh: null as InstanceInfo[] | null,
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({
    state: fixture.state,
    dispatch: (action: { type: string; instances?: InstanceInfo[] }) => { if (action.type === "instances" && action.instances) fixture.state = { ...fixture.state, instances: action.instances }; },
    refreshInstances: async () => { if (fixture.afterRefresh) fixture.state = { ...fixture.state, instances: fixture.afterRefresh }; },
    refreshModels: async () => {},
  }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method) fixture.calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (path.endsWith("/install") && fixture.installFails) throw new Error("Could not find a native Antigravity CLI release.");
    return {};
  },
}));
import { EnginesSettings } from "./EnginesSettings";

function google(fields: Partial<InstanceInfo>): InstanceInfo {
  return {
    instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Google Gemini", cliDefault: "agy",
    snapshot: { state: "available", authenticated: true, version: "1.4.3" }, models: { default: "gemini", options: [] },
    install: { managed: { label: "Install official Antigravity", downloadBytes: 1, sizeUnknown: true } },
    authentication: { method: "callback-url", signOut: true }, ...fields,
  } as InstanceInfo;
}

const classic = google({});
const onCli = (fields: Partial<InstanceInfo> = {}) => google({ cli: "antigravity", snapshot: { state: "available", authenticated: false, nativeCli: true, version: "1.5.2" }, ...fields });

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.calls = [];
  fixture.installFails = false;
  fixture.afterRefresh = null;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function show(instance: InstanceInfo) {
  fixture.state = { instances: [instance], bots: [], config: {} };
  await act(async () => { root.render(createElement(EnginesSettings)); });
}
const card = () => container.querySelector('[data-engine-card="antigravity"]') ?? container;
const button = (label: string) => [...card().querySelectorAll("button")].filter((item) => item.textContent === label);

it.each([
  ["the CLI it runs", google({ cli: "agy", snapshot: { state: "available", authenticated: true, nativeCli: true } })],
  ["the path antigravity", google({ cli: "antigravity", snapshot: { state: "unavailable" } })],
  ["the path Antigravity.exe", google({ cli: "Antigravity.exe", snapshot: { state: "unavailable" } })],
  ["a new install with nothing yet", google({ snapshot: { state: "unavailable" } })],
  ["the Classic runtime it runs", classic],
  ["the path that asks for the Classic runtime", google({ cli: "agy_acp_server", snapshot: { state: "unavailable" } })],
  ["a path of the person's own", google({ cli: "/opt/agy/agy_acp_server.par", snapshot: { state: "available", version: "1.4.3" } })],
  ["a native CLI at a path of the person's own", google({ cli: "/opt/tools/antigravity", snapshot: { state: "available", authenticated: true, nativeCli: true } })],
])("shows no runtime selector for an account on %s", async (_from, instance) => {
  await show(instance);
  expect(card().querySelector("[data-antigravity-runtime]")).toBeNull();
  expect(card().querySelector("select")).toBeNull();
  expect(card().textContent).not.toContain("Runs on");
  expect(card().textContent).not.toContain("Custom path");
});

it.each([
  ["no path", classic],
  ["the retired agy path", google({ cli: "agy" })],
  ["the Classic runtime's own name", google({ cli: "agy_acp_server" })],
  ["the Classic runtime, signed out", google({ snapshot: { state: "available", authenticated: false, version: "1.4.3" } })],
])("offers a signed-in Classic account, unchanged, one switch to the CLI (%s)", async (_from, instance) => {
  await show(instance);
  expect(button("Switch to Google Antigravity CLI")).toHaveLength(1);
  expect(card().querySelector("[data-antigravity-switch-cli]")?.textContent).toContain("you sign in with Google once more");
  expect(fixture.calls).toEqual([]);
});

it.each([
  ["the CLI, signed in", onCli({ snapshot: { state: "available", authenticated: true, nativeCli: true } })],
  ["the CLI, signed out", onCli()],
  ["the CLI on the retired agy path", google({ cli: "agy", snapshot: { state: "available", authenticated: true, nativeCli: true } })],
  ["nothing installed yet", google({ snapshot: { state: "unavailable" } })],
  ["a path of the person's own", google({ cli: "/opt/agy/agy_acp_server.par" })],
])("offers no switch to an account on %s", async (_from, instance) => {
  await show(instance);
  expect(card().querySelector("[data-antigravity-switch-cli]")).toBeNull();
});

it("moves the account to the CLI, installs it, and shows the sign-in card with no way back", async () => {
  await show(classic);
  fixture.afterRefresh = [onCli()];
  await act(async () => { button("Switch to Google Antigravity CLI")[0]!.click(); });
  expect(fixture.calls.map(({ path, method, body }) => [method, path, body])).toEqual([
    ["PATCH", "/api/instances/antigravity", { cli: "antigravity" }],
    ["POST", "/api/instances/antigravity/install", undefined],
  ]);
  await act(async () => { root.render(createElement(EnginesSettings)); });
  expect(card().querySelector("[data-antigravity-switch-cli]")).toBeNull();
  expect(button("Sign in")).toHaveLength(1);
  await act(async () => { button("Sign in")[0]!.click(); });
  expect(fixture.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/instances/antigravity/auth/start" });
  expect(card().querySelector("select")).toBeNull();
  expect(card().textContent).not.toContain("Classic runtime");
});

it("puts the path back when the CLI cannot be installed, so the Classic account keeps working", async () => {
  await show(google({ cli: "agy" }));
  fixture.installFails = true;
  await act(async () => { button("Switch to Google Antigravity CLI")[0]!.click(); });
  expect(fixture.calls.map(({ path, method, body }) => [method, path, body])).toEqual([
    ["PATCH", "/api/instances/antigravity", { cli: "antigravity" }],
    ["POST", "/api/instances/antigravity/install", undefined],
    ["PATCH", "/api/instances/antigravity", { cli: "agy" }],
  ]);
  expect(card().querySelector('[role="alert"]')?.textContent).toContain("Could not find a native Antigravity CLI release.");
  expect(button("Switch to Google Antigravity CLI")).toHaveLength(1);
});

it("installs the CLI from a fresh home's install button, with no path saved first", async () => {
  await show(google({ snapshot: { state: "unavailable", reason: "The Google Antigravity CLI is not installed yet. Install it here." } }));
  const install = button("Install Google Antigravity CLI");
  expect(install).toHaveLength(1);
  await act(async () => { install[0]!.click(); });
  expect(fixture.calls.map(({ path, method }) => [method, path])).toEqual([["POST", "/api/instances/antigravity/install"]]);
});

it("says the CLI is being installed while the server installs it on its own, and starts no second install", async () => {
  await show(google({ snapshot: { state: "unavailable", installing: true } }));
  expect(button("Install Google Antigravity CLI")).toHaveLength(0);
  const installing = button("Downloading and verifying…");
  expect(installing).toHaveLength(1);
  expect(installing[0]!.disabled).toBe(true);
  await act(async () => { installing[0]!.click(); });
  expect(fixture.calls).toEqual([]);
});

it("keeps the one-way switch on each Classic account of the shared accounts card, with no runtime menu", async () => {
  const added = onCli({ instanceId: "antigravity-2", displayName: "Work", snapshot: { state: "available", authenticated: true, nativeCli: true, account: { email: "work@example.com" } } });
  fixture.state = { instances: [classic, added], bots: [], config: {} };
  await act(async () => { root.render(createElement(EnginesSettings)); });
  const row = (id: string) => container.querySelector(`[data-account="${id}"]`)!;
  expect(container.querySelector('[data-accounts="antigravity"]')).not.toBeNull();
  expect(row("antigravity").querySelector("[data-antigravity-switch-cli]")).not.toBeNull();
  expect(row("antigravity-2").querySelector("[data-antigravity-switch-cli]")).toBeNull();
  expect(container.querySelectorAll("[data-antigravity-switch-cli]")).toHaveLength(1);
  expect(container.querySelector("[data-antigravity-runtime]")).toBeNull();
  expect(container.querySelector("select")).toBeNull();
  expect(container.textContent).not.toContain("Runs on");
  const offer = [...row("antigravity").querySelectorAll("button")].find((item) => item.textContent === "Switch to Google Antigravity CLI")!;
  await act(async () => { offer.click(); });
  expect(fixture.calls.map(({ path, method }) => [method, path])).toEqual([
    ["PATCH", "/api/instances/antigravity"],
    ["POST", "/api/instances/antigravity/install"],
  ]);
});
