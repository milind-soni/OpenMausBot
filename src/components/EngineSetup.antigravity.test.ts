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

/** Starts the Google sign-in and returns the "Signing in from another computer?" fold. */
async function startSignIn(cloudHome: boolean, ogb: object): Promise<HTMLDetailsElement> {
  vi.stubGlobal("ogb", { platform: "linux", openExternal: vi.fn(async () => {}), ...ogb });
  const store = { state: { config: cloudHome ? { cloudHome: true } : {} }, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: antigravity }) })));
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Sign in with Google"))!;
  button.click();
  await vi.waitFor(() => expect(host.querySelector("details")).not.toBeNull());
  return host.querySelector("details")!;
}

it("opens the paste-the-redirect step on a Cloud, where Google's 127.0.0.1 redirect can't reach the server", async () => {
  expect((await startSignIn(true, { remoteClient: { active: false } })).open).toBe(true);
});

it("opens it on a desktop paired to another computer's server", async () => {
  expect((await startSignIn(false, { remoteClient: { active: true } })).open).toBe(true);
});

it("keeps it folded on the person's own computer, where the redirect lands by itself", async () => {
  expect((await startSignIn(false, { remoteClient: { active: false } })).open).toBe(false);
});
