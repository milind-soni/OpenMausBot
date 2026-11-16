// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";

const antigravity: InstanceInfo = {
  instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Antigravity",
  models: { default: "gemini", options: [] },
  snapshot: { state: "available", authenticated: false, version: "1.1.1" },
  install: { managed: { label: "Install official Antigravity", downloadBytes: 1024 } },
  authentication: { method: "callback-url", signOut: true },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    auth: { phase: "pending", flowId: "flow-1", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" },
  }), { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function auth(body: object) {
  return new Response(JSON.stringify({ auth: body }), { status: 200, headers: { "content-type": "application/json" } });
}

async function startSignIn(status: object, ogb: object = { remoteClient: { active: false } }) {
  const openExternal = vi.fn(async () => {});
  vi.stubGlobal("ogb", { platform: "linux", openExternal, ...ogb });
  const fetched = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/auth/status")
    ? auth(status)
    : auth({ phase: "waiting", flowId: "flow-1", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s" }));
  vi.stubGlobal("fetch", fetched);
  const store = { state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: antigravity }) })));
  const button = () => [...host.querySelectorAll("button")].find((b) => /Sign in with Google|Open Google sign-in again/.test(b.textContent ?? ""))!;
  button().click();
  await vi.waitFor(() => expect(host.querySelector("[data-redirect-paste]")).not.toBeNull());
  return { store, fetched, openExternal, button };
}

it("shows the paste-the-redirect field the whole time the card waits, on the person's own computer too", async () => {
  await startSignIn({ phase: "waiting", flowId: "flow-1" });
  const field = host.querySelector<HTMLInputElement>("[data-redirect-paste] input")!;
  expect(field.getAttribute("aria-label")).toBeTruthy();
  expect(host.querySelector("details")).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  expect(host.querySelector("[data-redirect-paste] input")).not.toBeNull();
}, 15_000);

it("opens the same Google link again instead of starting another sign-in", async () => {
  const { fetched, openExternal, button } = await startSignIn({ phase: "waiting", flowId: "flow-1" });
  await vi.waitFor(() => expect(button().textContent).toContain("Open Google sign-in again"));
  button().click();
  await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
  expect(fetched.mock.calls.filter(([input]) => String(input).includes("/auth/start"))).toHaveLength(1);
});

it("says the sign-in expired and offers to start again, once the server reports it", async () => {
  const { button } = await startSignIn({ phase: "expired", flowId: "flow-1", message: "Google sign-in expired. Start sign-in again." });
  await vi.waitFor(() => expect(host.textContent).toContain("Google sign-in expired. Start again."), { timeout: 6_000 });
  expect(host.querySelector("[data-redirect-paste]")).toBeNull();
  expect(button().textContent).toContain("Sign in with Google");
}, 15_000);

it("shows the server's fixed reason when the sign-in fails", async () => {
  await startSignIn({ phase: "failed", flowId: "flow-1", message: "Google sign-in was not approved. Start sign-in again." });
  await vi.waitFor(() => expect(host.textContent).toContain("Google sign-in was not approved. Start sign-in again."), { timeout: 6_000 });
}, 15_000);

it("reads the engines and their models when the sign-in finishes by itself", async () => {
  const { store } = await startSignIn({ phase: "succeeded", flowId: "flow-1" });
  await vi.waitFor(() => expect(store.refreshModels).toHaveBeenCalledWith("antigravity"), { timeout: 6_000 });
  await vi.waitFor(() => expect(host.querySelector("[data-redirect-paste]")).toBeNull());
}, 15_000);

it("names Google on the sign-in card, never another provider", () => {
  vi.stubGlobal("ogb", { platform: "linux", remoteClient: { active: false } });
  const store = { state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: antigravity }) })));
  expect(host.textContent).toContain("Sign in with Google");
  expect(host.textContent).not.toContain("Mistral");
});
