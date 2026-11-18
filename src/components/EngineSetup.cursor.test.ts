// @vitest-environment happy-dom
// Cursor's card, and any engine's, on a Cloud: no terminal there, so nothing to copy and no CLI path to set; the app
// installs Cursor itself, then signs it in with a link.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";

const CURL = "curl https://cursor.com/install -fsS | bash";
const cursor = (snapshot: InstanceInfo["snapshot"], server = true): InstanceInfo => ({
  instanceId: "cursor", driverKind: "cursorAgent", displayName: "Cursor",
  models: { default: "auto", options: [] }, snapshot,
  authentication: { method: "device-code", signOut: false },
  install: {
    command: { darwin: CURL, linux: CURL }, signInCommand: "cursor-agent login", platform: "linux", docsUrl: "https://cursor.com/docs/cli/installation",
    ...(server ? { server: { standalone: { version: "2026.10.22-27dcf5f", downloadBytes: 184_859_176 } } } : {}),
  },
});
const missing = { state: "unavailable" as const, reason: "`cursor-agent` isn't installed, or isn't on this app's PATH. Install it for the user running OpenMausBot or use Set CLI, then check again." };
const pasted = { state: "unavailable" as const, reason: `\`${CURL}\` is not Cursor's CLI: it answered --version as another program.`, notEngineCli: true as const };

let host: HTMLDivElement;
let root: Root;
function render(engine: InstanceInfo, cloudHome: boolean): string {
  vi.stubGlobal("ogb", undefined);
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

describe("Cursor on a Cloud", () => {
  it.each([["not installed", missing], ["a CLI path that runs another program", pasted]] as const)("offers the app's own install when %s, never a command or a CLI path", (_case, snapshot) => {
    const html = render(cursor(snapshot), true);
    expect(html).toContain("Install Cursor here");
    expect(html).toContain("About 185 MB download.");
    // The pasted path is named once, in why it isn't Cursor; never as a command to copy.
    expect(html.split(CURL).length - 1).toBe("notEngineCli" in snapshot ? 1 : 0);
    expect(html).not.toContain("Set CLI");
    expect(html).not.toContain("Copy command");
    expect(html).not.toContain("computer running");
  });

  it("says the CLI path runs another program, so the person knows why, without asking them to fix it by hand", () => {
    const html = render(cursor(pasted), true);
    expect(html).toContain("is not Cursor's CLI");
    expect(html).not.toContain("Reset");
  });

  it("signs in with Cursor's link once installed", () => {
    const html = render(cursor({ state: "available", authenticated: false, version: "2026.10.22-27dcf5f" }), true);
    expect(html).toContain("Sign in to Cursor");
    expect(html).not.toContain("cursor-agent login");
  });
});

describe("an engine a Cloud can't install", () => {
  it("says so in one line: no command to copy, no CLI path to set, no terminal guide", () => {
    const html = render(cursor(missing, false), true);
    expect(html).toContain("Cursor can’t be installed on the Cloud yet. Choose another AI in the model picker.");
    expect(html).not.toContain(CURL);
    expect(html).not.toContain("Set CLI");
    expect(html).not.toContain("computer running");
    expect(html).not.toContain("View setup guide");
  });

  it("keeps the command and the hints on a computer with a terminal", () => {
    const html = render(cursor(missing, false), false);
    expect(html).toContain(CURL);
    expect(html).toContain("Set CLI");
    expect(html).not.toContain("can’t be installed on the Cloud");
  });
});
