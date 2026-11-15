// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/connectors/catalog") {
      return { cards: [{ slug: "apollo", label: "Apollo", blurb: "leads", logo: null, domain: null }], source: "api", configured: true, mode: "self-hosted" };
    }
    if (path.startsWith("/api/connectors?services=")) return { services: fixture.services };
    if (init?.method === "DELETE") return {};
    throw new Error(`unexpected ${path}`);
  }),
  useStore: () => ({
    state: { pluginsSurface: "apps", bots: [], instances: [], config: null },
    dispatch: vi.fn(),
  }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/connected-apps", () => ({
  preloadConnectedApps: vi.fn(async () => ({ services: fixture.services, authoritative: true })),
  connectorStatusMemory: () => null,
  rememberConnectorStatus: () => {},
}));
vi.mock("@/lib/connected-apps-cache", () => ({ readCachedInventory: () => null, writeCachedInventory: () => {} }));
vi.mock("@/lib/connector-oauth", () => ({
  reserveConnectionPage: () => ({ open: async () => true, cancel: () => {} }),
  reusableConnectionUrl: () => null,
}));
vi.mock("@/lib/product-events", () => ({ connectorConnect: vi.fn() }));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => null }));
vi.mock("./XCard", () => ({ X_CARD_SEARCH: "x", XCard: () => null }));
vi.mock("./PostizCard", () => ({ PostizCard: () => null }));
vi.mock("./EmailCard", () => ({ EmailCard: () => null }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { api } from "@/state/store";
const { PluginsPanel } = await import("./PluginsPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async () => {
  await act(async () => root.render(createElement(PluginsPanel)));
  await flush();
};
const tile = () => host.querySelector<HTMLElement>('[data-app-tile="apollo"]')!;
const byLabel = (scope: ParentNode, label: string) =>
  Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label);
const deletes = () => vi.mocked(api).mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "DELETE");

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", alias: "work", status: "ACTIVE" }] } };
  vi.mocked(api).mockClear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root.unmount());
  host.remove();
  document.body.querySelector("[role=alertdialog]")?.closest(".fixed")?.remove();
});

describe("disconnecting an app account", () => {
  it("asks in the page, and removes only that account after the confirm button", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    await open();
    await act(async () => { byLabel(tile(), "Disconnect work from Apollo")!.click(); });
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deletes()).toEqual([]);
    const dialog = document.body.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("“work” (ca_old)");
    expect(dialog?.textContent).toContain("Only this Apollo account will be revoked");
    await act(async () => { byLabel(dialog!, "Disconnect")!.click(); });
    await flush();
    expect(deletes()).toEqual([["/api/connectors/apollo/accounts/ca_old", { method: "DELETE" }]]);
    expect(document.body.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("leaves the account connected when the confirm is cancelled", async () => {
    await open();
    await act(async () => { byLabel(tile(), "Disconnect work from Apollo")!.click(); });
    const dialog = document.body.querySelector("[role=alertdialog]")!;
    await act(async () => { byLabel(dialog, "Cancel")!.click(); });
    expect(deletes()).toEqual([]);
    expect(document.body.querySelector("[role=alertdialog]")).toBeNull();
    expect(byLabel(tile(), "Disconnect work from Apollo")).toBeTruthy();
  });
});
