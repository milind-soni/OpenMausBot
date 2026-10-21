// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/mcp-servers", () => ({ updateMcpServers: vi.fn() }));
vi.mock("./GetMaxButton", () => ({ GetMaxButton: () => createElement("button", { "data-get-max": "" }, "Get Max") }));

import { McpServersPanel } from "./McpServersPanel";

const entry = (auth: string) => ({ name: "Consensus", type: "http", url: "https://science.example/consensus", headerKeys: [], enabled: true, auth, catalog: { id: "consensus", auth: "cloud" } });

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
const labels = () => [...host.querySelectorAll("button")].map((element) => element.textContent?.trim());

async function show(server: unknown) {
  fixture.api.mockImplementation((path: string) => path === "/api/mcp/servers" ? Promise.resolve({ servers: [server] }) : Promise.reject(new Error(`unexpected ${path}`)));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(McpServersPanel, {})));
  await settle();
}

beforeEach(() => { vi.clearAllMocks(); setLocale("en"); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("a cloud entry in MCP servers", () => {
  it("says Needs Max with a Get Max action, never Sign in, and keeps the entry", async () => {
    await show(entry("needs-max"));
    expect(host.textContent).toContain("Needs Max");
    expect(host.querySelector("[data-get-max]")).not.toBeNull();
    expect(labels()).not.toContain("Sign in");
    expect(labels()).not.toContain("Sign out");
    expect(host.textContent).toContain("Consensus");
  });

  it("offers no Sign out once signed in", async () => {
    await show(entry("signed-in"));
    expect(labels()).not.toContain("Sign out");
    expect(host.querySelector("[data-get-max]")).toBeNull();
  });

  it("still signs out a connector that is not a cloud entry", async () => {
    await show({ ...entry("signed-in"), catalog: { id: "x", auth: "oauth" } });
    expect(labels()).toContain("Sign out");
  });
});
