import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { pageIsThisComputer, RemoteAccessScope, RemoteComputerSection } from "./RemoteComputerSection";

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const render = (ogb?: unknown, component: () => unknown = RemoteComputerSection) => {
  vi.stubGlobal("window", { ogb });
  setLocale("en");
  return renderToStaticMarkup(createElement(component as () => null));
};

describe("another computer's desktop app", () => {
  it("asks for its address and its six-digit phone link code, and points a server at its own path", () => {
    const html = render({ remoteClient: { active: false }, environments: {} });
    expect(html).toContain("Another computer&#x27;s desktop app");
    expect(html).toContain("Phone link code (6 digits)");
    expect(html).toContain('placeholder="000000"');
    expect(html).toContain("12-character pairing code");
    expect(html).toContain("＋ → Add your own server");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("npx openmausbot pair");
  });

  it("keeps an active connection on its disconnect screen", () => {
    const html = render({ remoteClient: { active: true } });
    expect(html).toContain("Disconnect and use this computer");
    expect(html).not.toContain("<form");
  });

  it.each([undefined, { platform: "darwin" }, { environments: {} }])("shows nothing where this app cannot be a client: %o", (bridge) => {
    expect(render(bridge)).toBe("");
  });
});

describe("whose remote access Settings sets", () => {
  it("names this computer only on the desktop app's own page", () => {
    vi.stubGlobal("window", { ogb: { companion: {} } });
    expect(pageIsThisComputer()).toBe(true);
    expect(render({ companion: {} }, RemoteAccessScope)).toContain("reach this computer");
  });

  it.each([
    ["a browser", undefined],
    ["a server's page in the app", { platform: "darwin" }],
    ["client mode", { companion: {}, remoteClient: { active: true } }],
  ])("names the bots here, not this computer, in %s", (_where, ogb) => {
    vi.stubGlobal("window", { ogb });
    expect(pageIsThisComputer()).toBe(false);
    const html = render(ogb, RemoteAccessScope);
    expect(html).toContain("reach the bots here");
    expect(html).not.toContain("this computer");
  });
});
