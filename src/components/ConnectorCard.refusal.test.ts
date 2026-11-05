// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { ApiError } from "@/state/api";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), openExternal: vi.fn(async (_url: string) => {}) }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => { throw new Error("outside the app"); },
}));
import { ConnectorCard } from "./ConnectorCard";

const SENTENCE = "Finish this sign-in in Apps → MCP servers.";
const AUTH_URL = "https://mcp.linear.app/authorize?client_id=maus&state=s3cr3t";

let host: HTMLDivElement;
let root: Root;
const render = (connector: Partial<NonNullable<Message["connector"]>>) => flushSync(() => root.render(createElement(ConnectorCard, {
  botId: "atlas",
  threadId: "thread",
  message: {
    id: "m1",
    role: "bot",
    kind: "connector",
    at: 1,
    connector: { slug: "linear", label: "Linear", description: "Read issues", status: "required", resumeKey: "resume1", ...connector },
  },
})));
const press = (label: string) => {
  const button = [...host.querySelectorAll("button")].find((each) => each.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  button.click();
};
const links = () => [...host.querySelectorAll("a")].map((link) => link.getAttribute("href"));

beforeEach(() => {
  setLocale("en");
  (window as { ogb?: unknown }).ogb = { openExternal: fixture.openExternal };
  fixture.api.mockRejectedValue(new ApiError(SENTENCE, 409, { error: SENTENCE, url: AUTH_URL }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
  vi.clearAllMocks();
});

describe("ConnectorCard authorize refusal", () => {
  it("shows an MCP server's refusal as its sentence, with no sign-in link anywhere on the card", async () => {
    render({ source: "mcp" });
    press("Sign in");
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toBe(SENTENCE));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/atlas/connector-cards/m1/authorize", { method: "POST", body: JSON.stringify({ threadId: "thread" }) });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain(AUTH_URL);
    expect(host.innerHTML).not.toContain("mcp.linear.app");
    expect(links()).toEqual([]);
    expect(fixture.openExternal).not.toHaveBeenCalled();
  });

  it("keeps a Composio app's 409 as the card's error", async () => {
    render({ source: "composio" });
    press("Connect securely");
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe(SENTENCE));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(links()).toEqual([]);
  });
});
