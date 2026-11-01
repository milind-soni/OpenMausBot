// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";

const CURL = "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash";
const kimi = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
  instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi",
  models: { default: "kimi-code/k3", options: [] }, snapshot,
  authentication: { method: "device-code", signOut: false },
  install: { command: { darwin: CURL, linux: CURL }, signInCommand: "kimi login", platform: "linux", server: { package: "@moonshot-ai/kimi-code" } },
});
const missing = kimi({ state: "unavailable", reason: "`kimi` isn't installed, or isn't on this app's PATH." });
const signedOut = kimi({ state: "available", authenticated: false, version: "2.4.1" });
const desktop = { platform: "darwin", openInstallTerminal: vi.fn(async () => true), remoteClient: { active: false } };

let host: HTMLDivElement;
let root: Root;
function render(engine: InstanceInfo, ogb: object | undefined, cloudHome = false): string {
  vi.stubGlobal("ogb", ogb);
  const store = { state: { config: cloudHome ? { cloudHome: true } : {} }, dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: engine }) })));
  return host.innerHTML;
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Kimi on My Cloud, which has no terminal", () => {
  it("installs from Settings, with Moonshot's command only to copy", () => {
    const html = render(missing, desktop, true);
    expect(html).toContain("Install Kimi here");
    expect(html).toContain("Prefer a terminal?");
    expect(html).toContain(CURL);
    expect(html).not.toContain("Open install in Terminal");
  });

  it("signs in with Kimi's code on the server's page, with no terminal command", () => {
    const html = render(signedOut, desktop, true);
    expect(html).toContain('data-device-sign-in="kimi"');
    expect(html).toContain("Sign in with your Kimi Code membership so your bots can use Kimi");
    expect(html).toContain("Sign in to Kimi");
    expect(html).not.toContain("kimi login");
  });
});

it("keeps `kimi login` behind Prefer a terminal? in the desktop app's own window", () => {
  const html = render(signedOut, desktop);
  expect(html).toContain('data-device-sign-in="kimi"');
  expect(html).toContain("Prefer a terminal?");
  expect(html).toContain("kimi login");
});
