// @vitest-environment happy-dom
// Settings → General → MCP calls. A server older than the setting (a remote
// server or a Cloud this app is newer than) sends a config with no `mcp`
// section; the card shows the 10 minutes that server uses instead of
// crashing Settings, and a save still sends the shape the server expects.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";

const fixture = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  api: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

// A config as a server from before the setting sends it: everything else, no `mcp`.
const olderServerConfig = { rooms: { turnTimeoutMinutes: 5 }, composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" } };

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(McpCallTimeoutSettings)));
const input = () => host.querySelector<HTMLInputElement>("#mcp-call-timeout")!;
const type = (value: string) => {
  const field = input();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
};
const blur = () => flushSync(() => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.config = undefined;
  // as the real store does: the server's reply becomes the config Settings reads
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

describe("McpCallTimeoutSettings", () => {
  it("shows the 10-minute default when the server's config has no mcp section", () => {
    fixture.config = olderServerConfig;
    render();
    expect(input().value).toBe("10");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the 10-minute default before any config has arrived", () => {
    render();
    expect(input().value).toBe("10");
  });

  it("shows the timeout the server confirmed", () => {
    fixture.config = { ...olderServerConfig, mcp: { callTimeoutMinutes: 30 } };
    render();
    expect(input().value).toBe("30");
  });

  it("saves as { mcp: { callTimeoutMinutes } } and shows the server's answer", async () => {
    fixture.config = olderServerConfig;
    const saved = { ...olderServerConfig, mcp: { callTimeoutMinutes: 45 } };
    fixture.api.mockResolvedValue(saved);
    render();
    type("45");
    blur();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved }));
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PUT",
      body: JSON.stringify({ mcp: { callTimeoutMinutes: 45 } }),
    });
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    expect(input().value).toBe("45");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the 10 minutes an older server keeps using when its reply has no mcp section", async () => {
    fixture.config = olderServerConfig;
    fixture.api.mockResolvedValue(olderServerConfig);
    render();
    type("45");
    blur();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    expect(input().value).toBe("10");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
