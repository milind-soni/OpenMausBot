// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({
  api,
  useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }),
}));

import { McpServersPanel } from "./McpServersPanel";

const FLOW = "00000000-0000-4000-8000-000000000000";
const AUTHORIZE = "https://auth.example.test/authorize?client_id=omb";
const lusha = { name: "lusha", type: "http", url: "https://mcp.example.test", headerKeys: [], enabled: true, auth: "needs-sign-in" };

let root: Root;
let host: HTMLElement;
let started!: (value: unknown) => void;
const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
const signIn = () => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Sign in")!;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  api.mockReset();
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return Promise.resolve({ servers: [lusha] });
    if (path === "/api/mcp/servers/lusha/sign-in" && init?.method === "POST") return new Promise((resolve) => { started = resolve; });
    return new Promise(() => {});
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(McpServersPanel)); });
  await settle();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("reserves the browser tab during the click, then sends it to the sign-in page", async () => {
  const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.fn(() => page);
  vi.stubGlobal("open", open);
  await act(async () => { signIn().click(); });
  expect(open).toHaveBeenCalledWith("", "_blank");
  await act(async () => { started({ auth: { phase: "waiting", flowId: FLOW, authorizationUrl: AUTHORIZE } }); });
  await settle();
  expect(page.location.replace).toHaveBeenCalledWith(AUTHORIZE);
  expect(host.querySelector("[role=alert]")).toBeNull();
});

async function testedWith(result: unknown) {
  api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return Promise.resolve({ servers: [lusha] });
    if (path === "/api/mcp/servers/lusha/test" && init?.method === "POST") return Promise.resolve(result);
    return new Promise(() => {});
  });
  await act(async () => { [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Test")!.click(); });
  await settle();
  return [...host.querySelectorAll("[role=status]")].map((node) => node.textContent).join(" ");
}

it("passes on what the server said about a refused key beside the offer to sign in", async () => {
  expect(await testedWith({ ok: false, auth: "required", said: "Invalid API key", error: "This server needs you to sign in. It said: \"Invalid API key\"." }))
    .toContain("This server needs you to sign in. Sign in opens it in your browser. It said: \"Invalid API key\".");
});

it("passes on what the server said when it refused the keys", async () => {
  expect(await testedWith({ ok: false, reason: "keys", status: 401, said: "Invalid API key", error: "The server didn't accept the keys (HTTP 401)." }))
    .toContain("Couldn't connect. The server didn't let it in (HTTP 401). It probably needs a key: add it with Fix the keys. It said: \"Invalid API key\".");
});

it("says the browser blocked the sign-in page instead of waiting in silence", async () => {
  vi.stubGlobal("open", vi.fn(() => null));
  await act(async () => { signIn().click(); });
  await act(async () => { started({ auth: { phase: "waiting", flowId: FLOW, authorizationUrl: AUTHORIZE } }); });
  await settle();
  expect(host.querySelector("[role=alert]")?.textContent).toBe("Your browser blocked the connection page. Allow pop-ups, then try again.");
  expect([...host.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Open sign-in page")).toBe(true);
});
