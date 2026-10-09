// @vitest-environment happy-dom
// Grok Build's setup card, wherever Grok is not ready: Settings → Engines,
// My Cloud's sign-in and a failed turn's card all render this one. Signed out,
// it is the in-app code, the same on the desktop, a server and My Cloud; the
// `grok login` command stays behind "Prefer a terminal?" only where a
// terminal runs on that machine. Where Grok cannot run and nobody here can
// install it, it is one honest line and one action: an xAI key.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup, grokKeyInstead } from "./EngineSetup";

const CURL = "curl -fsSL https://x.ai/cli/install.sh | bash";
const NOT_INSTALLED = "Grok with your grok.com subscription isn't installed on this server. Use an xAI API key instead.";
const grok = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
  instanceId: "grok", driverKind: "grokAgent", displayName: "Grok",
  models: { default: "grok-4.7", options: [] }, snapshot,
  authentication: { method: "device-code", signOut: false },
  install: { command: { darwin: CURL, linux: CURL }, docsUrl: "https://x.ai/cli", signInCommand: "grok login" },
});
const signedOut = grok({ state: "available", authenticated: false, version: "grok 1.0.41" });
const missing = grok({ state: "unavailable", reason: "`grok` CLI not found" });

// Where the page is: the desktop app's own window on its own server, the
// desktop paired to another server, or a browser on a server's page.
const desktop = { platform: "darwin", openInstallTerminal: vi.fn(async () => true), remoteClient: { active: false } };
const pairedDesktop = { ...desktop, remoteClient: { active: true } };

let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();
function render(engine: InstanceInfo, ogb: object | undefined, cloudHome = false): string {
  vi.stubGlobal("ogb", ogb);
  const store = { state: { config: cloudHome ? { cloudHome: true } : {} }, dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: engine }) })));
  return host.innerHTML;
}

beforeEach(() => {
  setLocale("en");
  dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("signed out: the in-app code", () => {
  it("signs in with xAI's code on a server's page, with no terminal command", () => {
    const html = render(signedOut, undefined);
    expect(html).toContain('data-device-sign-in="grok"');
    expect(html).toContain("Sign in with your grok.com account so Grok runs on this server");
    expect(html).toContain("Sign in to Grok");
    expect(html).not.toContain("grok login");
    expect(html).not.toContain("Prefer a terminal?");
    expect(html).not.toMatch(/Connect ChatGPT|ChatGPT security settings/);
  });

  it("keeps `grok login` behind Prefer a terminal? in the desktop app's own window", () => {
    const html = render(signedOut, desktop);
    expect(html).toContain('data-device-sign-in="grok"');
    expect(html).toContain("Prefer a terminal?");
    expect(html).toContain("grok login");
  });

  it.each([
    ["a desktop paired to another server", pairedDesktop, false],
    ["My Cloud in the desktop app's window", desktop, true],
  ] as const)("never hands %s a terminal command", (_where, ogb, cloudHome) => {
    const html = render(signedOut, ogb, cloudHome);
    expect(html).toContain('data-device-sign-in="grok"');
    expect(html).not.toContain("grok login");
  });
});

describe("Grok cannot run here: an xAI key instead", () => {
  it.each([
    ["a server's page in a browser", undefined, false],
    ["My Cloud in the desktop app's window", desktop, true],
  ] as const)("says so in one line with one action on %s", (_where, ogb, cloudHome) => {
    const html = render(missing, ogb, cloudHome);
    expect(grokKeyInstead(missing, cloudHome)).toBe(true);
    expect(html).toContain("data-engine-setup-key-instead");
    expect(html).toContain(NOT_INSTALLED);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Add xAI key");
    expect(html).not.toContain(CURL);
    expect(html).not.toContain("Install Grok");
    expect(html).not.toContain("Terminal");
  });

  it("opens Settings → API keys", () => {
    render(missing, undefined);
    host.querySelector("button")!.click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleAppSettings", open: true, section: "connections" });
  });

  it("has no button on a paired desktop, whose Settings hide the keys", () => {
    const html = render(missing, pairedDesktop);
    expect(html).toContain(NOT_INSTALLED);
    expect(html).not.toContain("<button");
  });

  it("keeps the install on the desktop, where a terminal can run it", () => {
    const html = render(missing, desktop);
    expect(grokKeyInstead(missing, false)).toBe(false);
    expect(html).toContain("Install Grok");
    expect(html).toContain(CURL);
    expect(html).not.toContain("Add xAI key");
  });

  it("is about Grok Build alone, and only while it cannot run", () => {
    vi.stubGlobal("ogb", undefined);
    expect(grokKeyInstead(signedOut, false)).toBe(false);
    expect(grokKeyInstead({ ...missing, driverKind: "kimiAgent" }, false)).toBe(false);
  });
});
