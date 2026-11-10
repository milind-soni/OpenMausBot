// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BrowserProxyRow, NewBrowserSettings, ServerSitesRow } from "./BrowserSettingsRows";

const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  api: vi.fn(),
  dispatch: vi.fn(),
}));
const owner = vi.hoisted(() => ({ value: true as boolean | null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => owner.value }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(NewBrowserSettings)));
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Use the new browser"]')!;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = { browserEngine: { kind: "engine", engine: "agent-browser" } };
  fixture.dispatch.mockImplementation((action: { type: string; config?: Record<string, unknown> }) => {
    if (action.type === "configStatus") fixture.config = action.config;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("New browser setting", () => {
  it("is off while agent-browser runs the bots' browsers", () => {
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("turns the new browser on as browserEngine.engine and shows the server's answer", async () => {
    const saved = { browserEngine: { kind: "engine", engine: "chrome" } };
    fixture.api.mockResolvedValue(saved);
    render();
    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ browserEngine: { engine: "chrome" } }),
    });
    render();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("turns it off as agent-browser, and shows a refusal from the server", async () => {
    fixture.config = { browserEngine: { kind: "engine", engine: "chrome" } };
    fixture.api.mockRejectedValue(new Error("stop Scout's turn before switching the browser"));
    render();
    flushSync(() => toggle().click());
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe("stop Scout's turn before switching the browser"));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ browserEngine: { engine: "agent-browser" } }),
    });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});

describe("Open sites on this server", () => {
  const sites = () => host.querySelector<HTMLButtonElement>('button[aria-label="Open sites on this server"]');
  const show = () => flushSync(() => root.render(createElement(ServerSitesRow)));
  afterEach(() => { owner.value = true; });

  it("shows only on a self-hosted server with the built-in browser on, and only to its owner", () => {
    show();
    expect(sites()).toBeNull();
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine", serverSites: false } };
    show();
    expect(sites()).toBeNull();
    fixture.config = { features: { browser: true }, browserEngine: { kind: "engine", serverSites: false } };
    owner.value = false;
    show();
    expect(sites()).toBeNull();
    owner.value = true;
    show();
    expect(sites()?.getAttribute("aria-checked")).toBe("false");
  });

  it("turns it on as browserEngine.egress.localNetwork and shows the server's answer", async () => {
    fixture.config = { features: { browser: true }, browserEngine: { kind: "engine", serverSites: false } };
    const saved = { features: { browser: true }, browserEngine: { kind: "engine", serverSites: true } };
    fixture.api.mockResolvedValue(saved);
    show();
    flushSync(() => sites()!.click());
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ browserEngine: { egress: { localNetwork: true } } }),
    });
    show();
    expect(sites()?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Built-in browser proxy setting", () => {
  const show = () => flushSync(() => root.render(createElement(BrowserProxyRow)));

  it("is owner-only and saves the endpoint without echoing it in the status", async () => {
    fixture.config = { features: { browser: true }, browserEngine: { kind: "engine", proxyConfigured: false } };
    show();
    expect(host.querySelector('input[aria-label="SOCKS5 proxy"]')).not.toBeNull();
    owner.value = false;
    show();
    expect(host.querySelector('input[aria-label="SOCKS5 proxy"]')).toBeNull();
    owner.value = true;
    fixture.api.mockResolvedValue({ features: { browser: true }, browserEngine: { kind: "engine", proxyConfigured: true } });
    show();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="SOCKS5 proxy"]')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "socks5://127.0.0.1:1080");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")?.click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      body: JSON.stringify({ browserEngine: { egress: { proxy: "socks5://127.0.0.1:1080" } } }),
    })));
    const body = JSON.parse(fixture.api.mock.calls[0]![1].body);
    expect(body.browserEngine.egress.proxy).toBe("socks5://127.0.0.1:1080");
    expect(fixture.dispatch.mock.calls[0]![0].config.browserEngine.proxyConfigured).toBe(true);
  });
});
