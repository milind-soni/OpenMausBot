// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BotPermissionBoard } from "./BotPermissionBoard";

const f = vi.hoisted(() => ({
  state: { bots: [] as Bot[] }, listeners: new Set<() => void>(),
  api: vi.fn(), inventory: vi.fn(), dispatch: vi.fn(),
  mcp: { servers: [{ name: "files", enabled: true }], error: false, refresh: vi.fn() },
}));
vi.mock("@/state/store", () => ({
  api: (...args: unknown[]) => f.api(...args),
  useStore: () => ({ state: useSyncExternalStore(callback => { f.listeners.add(callback); return () => { f.listeners.delete(callback); }; }, () => f.state), dispatch: f.dispatch }),
}));
vi.mock("@/lib/connected-apps", () => ({ preloadConnectedApps: () => f.inventory() }));
vi.mock("@/lib/mcp-servers", async original => ({ ...await original<typeof import("@/lib/mcp-servers")>(), useMcpServers: () => f.mcp }));
vi.mock("./bot-settings/useBotApps", () => ({
  loadAppCards: async () => new Map([["mail", { label: "Mail" }], ["calendar", { label: "Calendar" }]]),
  emailAppCard: () => ({ label: "Email" }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let saved: Bot[];
const makeBot = (id: string, patch: Partial<Bot> = {}) => ({ id, name: id === "a" ? "Alpha" : "Beta", section: "Research", ...patch }) as Bot;
function setBots(bots: Bot[]) { f.state = { bots }; for (const listener of f.listeners) listener(); }

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  saved = [makeBot("a"), makeBot("b", { composio: false })];
  f.state = { bots: structuredClone(saved) };
  f.inventory.mockResolvedValue({ services: { mail: { connected: true }, calendar: { connected: true } }, authoritative: true });
  f.mcp.servers = [{ name: "files", enabled: true }];
  f.mcp.error = false;
  f.dispatch.mockImplementation((action: { type: string; bot: Bot }) => { if (action.type === "botPatched") setBots(f.state.bots.map(bot => bot.id === action.bot.id ? action.bot : bot)); });
  f.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/email") return { state: "not-connected" };
    if (path === "/api/bots?messages=0") return { bots: structuredClone(saved) };
    if (init?.method === "PATCH") {
      const id = path.split("/").at(-1);
      const bot = { ...saved.find(bot => bot.id === id)!, ...JSON.parse(String(init.body)) };
      saved = saved.map(entry => entry.id === id ? bot : entry);
      return { bot };
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(createElement(BotPermissionBoard))); };
const cell = (bot: string, resource: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${bot}: allow ${resource}"]`)!;
const patches = () => f.api.mock.calls.filter(([, init]) => init?.method === "PATCH");

it("renders all bots as rows, with grouped service and MCP column bands", async () => {
  await render();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(host.querySelectorAll("thead tr")[1]!.querySelectorAll("th")).toHaveLength(3);
  expect(host.textContent).toContain("Services");
  expect(host.textContent).toContain("MCP");
  expect(cell("Alpha", "Mail").checked).toBe(true);
  expect(cell("Beta", "Mail").checked).toBe(false);
  expect(cell("Alpha", "files").checked).toBe(true);
  expect(host.querySelector("[role=region]")?.getAttribute("tabindex")).toBe("0");
});

it("uses a fresh bot snapshot and preserves restrictions changed elsewhere before saving", async () => {
  await render();
  saved[0] = makeBot("a", { connectorScopes: { apps: { mail: "read", calendar: "read" } }, connectorTools: { mail: { tools: ["MAIL_GET_MESSAGE"] }, calendar: { tools: "*" } } });
  await act(async () => cell("Alpha", "Calendar").click());
  expect(JSON.parse(patches()[0]![1].body)).toEqual({ connectorScopes: { apps: { mail: "read" } } });
  expect(cell("Alpha", "Calendar").checked).toBe(false);
  expect(cell("Alpha", "Mail").checked).toBe(true);
  expect(host.textContent).toContain("Read only");
  expect(saved[0]!.connectorTools?.mail.tools).toEqual(["MAIL_GET_MESSAGE"]);
  expect(saved[1]!.composio).toBe(false);
});

it("enabling one service does not resurrect a globally disabled bot's other stored grants", async () => {
  saved[1] = makeBot("b", { composio: false, connectorScopes: { apps: { mail: "read", calendar: "write" } } });
  f.state = { bots: structuredClone(saved) };
  await render();
  await act(async () => cell("Beta", "Mail").click());
  expect(saved[1]!.connectorScopes).toEqual({ apps: { mail: "read" } });
  expect(cell("Beta", "Mail").checked).toBe(true);
  expect(cell("Beta", "Calendar").checked).toBe(false);
});

it("does not show a successful check or notice when persistence fails, and can retry", async () => {
  await render();
  const normal = f.api.getMockImplementation()!;
  let fail = true;
  f.api.mockImplementation((path, init) => init?.method === "PATCH" && fail ? Promise.reject(new Error("Fixture disk failure")) : normal(path, init));
  await act(async () => cell("Beta", "Mail").click());
  expect(cell("Beta", "Mail").checked).toBe(false);
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Fixture disk failure");
  expect(host.textContent).not.toContain("Saved Mail access for Beta");
  fail = false;
  await act(async () => cell("Beta", "Mail").click());
  expect(cell("Beta", "Mail").checked).toBe(true);
  expect(saved[1]!.connectorScopes).toEqual({ apps: { mail: "write" } });
  expect(host.textContent).toContain("Saved Mail access for Beta");
});

it("serializes a bot's concurrent checkbox events while allowing another bot to save", async () => {
  await render();
  const normal = f.api.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.api.mockImplementation(async (path, init) => { if (path === "/api/bots/a" && init?.method === "PATCH") await held; return normal(path, init); });
  await act(async () => { cell("Alpha", "Mail").click(); cell("Alpha", "Calendar").click(); });
  expect(cell("Alpha", "Calendar").disabled).toBe(true);
  await act(async () => cell("Beta", "Mail").click());
  expect(cell("Beta", "Mail").checked).toBe(true);
  await act(async () => release());
  expect(patches().filter(([path]) => path === "/api/bots/a")).toHaveLength(1);
});

it("keeps a busy bot editable and explains that its changes apply from the next turn", async () => {
  saved[0] = makeBot("a", { busy: true }); f.state = { bots: structuredClone(saved) };
  await render();
  expect(cell("Alpha", "files").disabled).toBe(false);
  expect(cell("Alpha", "Mail").disabled).toBe(false);
  expect(host.textContent).toContain("Added access applies from its next turn");
});

it("still saves for a bot that became busy before the click, applying from its next turn", async () => {
  await render();
  saved[0] = makeBot("a", { busy: true });
  await act(async () => cell("Alpha", "files").click());
  expect(patches()).toHaveLength(1);
  expect(saved[0]!.mcpServers).toEqual([]);
  expect(cell("Alpha", "files").checked).toBe(false);
});

it("refresh retries an unavailable inventory without pretending grants were cleared", async () => {
  f.inventory.mockResolvedValue({ services: { mail: { connected: true } }, authoritative: false });
  await render();
  expect(cell("Alpha", "Mail").checked).toBe(true);
  expect(cell("Alpha", "Mail").disabled).toBe(true);
  f.inventory.mockResolvedValue({ services: { mail: { connected: true } }, authoritative: true });
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Refresh list")!.click(); });
  expect(cell("Alpha", "Mail").checked).toBe(true);
  expect(cell("Alpha", "Mail").disabled).toBe(false);
  expect(patches()).toHaveLength(0);
});

it("fails closed on incomplete service inventory and MCP read failures", async () => {
  f.inventory.mockResolvedValue({ services: { mail: { connected: true } }, authoritative: false });
  f.mcp.error = true;
  await render();
  expect(cell("Alpha", "Mail").disabled).toBe(true);
  expect(cell("Alpha", "files").disabled).toBe(true);
  expect(host.querySelectorAll("[role=alert]")).toHaveLength(2);
  expect(patches()).toHaveLength(0);
});
