// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { PostizStatus } from "../../shared/postiz";

const fixture = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { api: vi.fn(), dispatch: vi.fn(), config: {} as Record<string, unknown> };
});
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));

import { PostizCard } from "./PostizCard";

const base = { address: "https://api.postiz.com", host: "api.postiz.com", selfHosted: false, keySaved: false, team: false, scope: "team" } as const;
const notConnected: PostizStatus = { ...base, state: "not-connected", how: null };
const connectedSignIn: PostizStatus = { ...base, state: "connected", how: "sign-in" };
const authorizationUrl = "https://platform.postiz.com/oauth/authorize?client_id=pcd_1&state=s";

class Refusal extends Error {
  readonly body: Record<string, unknown>;
  constructor(body: Record<string, unknown>) { super(String(body.error)); this.body = body; }
}

let status: PostizStatus;
let calls: Array<[string, string, unknown]>;
let refuseKey: Record<string, unknown> | null;
let host: HTMLDivElement;
let root: Root;
let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<boolean>>>;
let onConnection: ReturnType<typeof vi.fn<(connected: boolean | null) => void>>;

const settle = () => act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); });
const text = () => host.querySelector<HTMLElement>('[data-app-tile="postiz"]')?.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const type = (input: HTMLInputElement, value: string) => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };

function serve() {
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push([method, path, body]);
    if (path === "/api/postiz" && method === "GET") return status;
    if (path === "/api/postiz/check" && method === "POST") return { ...status, tools: 4 };
    if (path === "/api/postiz/sign-in" && method === "POST") return { ...status, how: "sign-in" };
    if (path === "/api/mcp/servers/postiz/sign-in" && method === "POST") return { auth: { phase: "waiting", flowId: "flow-1", authorizationUrl, expiresAt: "2026-10-29T12:00:00Z" } };
    if (path === "/api/mcp/servers/postiz/sign-in/flow-1" && method === "GET") return { auth: { phase: "succeeded", flowId: "flow-1", authorizationUrl: null } };
    if (path === "/api/mcp/servers/postiz/test") return { ok: true, tools: [{ name: "schedulePostTool" }] };
    if (path === "/api/mcp/servers/postiz" && method === "PATCH") { status = connectedSignIn; return { servers: [] }; }
    if (path === "/api/postiz/key-check") { if (refuseKey) throw new Refusal(refuseKey); return { ok: true, tools: 4 }; }
    if (path === "/api/config" && method === "PUT") {
      if (body.postiz?.key) status = { ...base, state: "connected", how: "key", keySaved: true };
      if (body.postiz?.key === "") status = { ...status, keySaved: false };
      return { postiz: { configured: Boolean(body.postiz?.key) } };
    }
    if (path === "/api/postiz" && method === "DELETE") { status = notConnected; return status; }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

async function mount(initial: PostizStatus) {
  status = initial;
  calls = [];
  serve();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(PostizCard, { onConnection })));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  setLocale("en");
  fixture.api.mockReset();
  fixture.config = {};
  refuseKey = null;
  openExternal = vi.fn<(url: string) => Promise<boolean>>(async () => true);
  onConnection = vi.fn<(connected: boolean | null) => void>();
  window.confirm = vi.fn(() => true);
  (window as unknown as { ogb: unknown }).ogb = { openExternal };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the Postiz card", () => {
  it("offers Connect and an API key instead, with Postiz's own words and mark", async () => {
    await mount(notConnected);
    expect(text()).toContain("Postiz");
    expect(text()).toContain("Draft, schedule and publish social posts with Postiz.");
    expect(button("Connect Postiz")).toBeTruthy();
    expect(button("Use an API key instead")).toBeTruthy();
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector("svg rect")?.getAttribute("fill")).toBe("#612bd3");
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });

  it("signs in through the browser, loads the tools, turns the server on and says where it is connected", async () => {
    await mount(notConnected);
    await act(async () => button("Connect Postiz")!.click());
    await settle();
    expect(openExternal).toHaveBeenCalledWith(authorizationUrl);
    expect(text()).toContain("Finish signing in to Postiz in your browser.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    await settle();
    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual(expect.arrayContaining([
      "POST /api/postiz/sign-in", "POST /api/mcp/servers/postiz/sign-in", "GET /api/mcp/servers/postiz/sign-in/flow-1",
      "POST /api/mcp/servers/postiz/test", "PATCH /api/mcp/servers/postiz",
    ]));
    expect(calls).toContainEqual(["PATCH", "/api/mcp/servers/postiz", { enabled: true }]);
    expect(text()).toContain("Connected to api.postiz.com");
    expect(button("Postiz options")).toBeTruthy();
    expect(onConnection).toHaveBeenLastCalledWith(true);
  });

  it("checks the saved connection again when it opens connected, and offers Reconnect once Postiz signed it out", async () => {
    await mount(connectedSignIn);
    expect(calls).toContainEqual(["POST", "/api/postiz/check", undefined]);
    await act(async () => root.unmount());
    host.remove();
    await mount({ ...base, state: "needs-sign-in", how: "sign-in" });
    expect(text()).toContain("Signed out. Reconnect to keep using it.");
    expect(button("Reconnect Postiz")).toBeTruthy();
  });

  it("checks an API key and its address before saving, then saves the address and the key apart", async () => {
    await mount(notConnected);
    await act(async () => button("Use an API key instead")!.click());
    await settle();
    const key = host.querySelector<HTMLInputElement>('input[aria-label="Postiz API key"]')!;
    const address = host.querySelector<HTMLInputElement>('input[aria-label="Postiz server address (optional)"]')!;
    expect(key.type).toBe("password");
    expect(address.placeholder).toBe("https://api.postiz.com");
    expect(text()).toContain("Leave the address empty for Postiz Cloud");
    await act(async () => { type(key, " pz-org-key "); type(address, "https://postiz.example.com/api"); });
    await act(async () => host.querySelector<HTMLButtonElement>('form[data-postiz-key-form] button[type="submit"]')!.click());
    await settle();
    expect(calls).toContainEqual(["POST", "/api/postiz/key-check", { key: "pz-org-key", address: "https://postiz.example.com/api" }]);
    expect(calls).toContainEqual(["PUT", "/api/config", { postiz: { url: "https://postiz.example.com/api" } }]);
    expect(calls).toContainEqual(["PUT", "/api/config", { postiz: { key: "pz-org-key" } }]);
    expect(text()).toContain("Connected to api.postiz.com with an API key");
    expect(text()).not.toContain("pz-org-key");
  });

  it("says plainly why a key or an address was refused, and saves nothing", async () => {
    await mount(notConnected);
    await act(async () => button("Use an API key instead")!.click());
    await settle();
    const [key, address] = [...host.querySelectorAll<HTMLInputElement>("form[data-postiz-key-form] input")];
    for (const [refusal, said] of [
      [{ error: "x", code: "key_rejected" }, "Postiz didn’t accept this API key. Copy it again from Postiz → Settings → Public API."],
      [{ error: "x", code: "unreachable" }, "Couldn’t reach a Postiz server at postiz.example.com. Check the address and try again."],
      [{ error: "x", code: "address" }, "Check the address: it starts with https:// and has no key or password in it."],
      [{ error: "x", code: "not_postiz" }, "postiz.example.com didn’t answer like Postiz. Check the address. Postiz Cloud’s is https://api.postiz.com."],
    ] as const) {
      refuseKey = refusal;
      await act(async () => { type(key!, "pz-wrong"); type(address!, "https://postiz.example.com"); });
      await act(async () => host.querySelector<HTMLButtonElement>('form[data-postiz-key-form] button[type="submit"]')!.click());
      await settle();
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(said);
    }
    expect(calls.some(([method, path]) => method === "PUT" && path === "/api/config")).toBe(false);
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });

  it("disconnects after asking, removing a saved key first", async () => {
    await mount({ ...base, state: "connected", how: "key", keySaved: true });
    await act(async () => button("Postiz options")!.click());
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"][data-menu-key="disconnect"]')!.click());
    await settle();
    expect(window.confirm).toHaveBeenCalledWith("Disconnect Postiz? Bots stop using it until you connect it again.");
    const order = calls.filter(([method]) => method !== "GET" && method !== "POST").map(([method, path, body]) => [method, path, body]);
    expect(order).toEqual([["PUT", "/api/config", { postiz: { key: "" } }], ["DELETE", "/api/postiz", undefined]]);
    expect(button("Connect Postiz")).toBeTruthy();
  });

  it("tells which other server holds the name, and is hidden from a person who may not manage it", async () => {
    await mount({ ...base, state: "taken", how: null });
    expect(text()).toContain("An MCP server named postiz is already set up.");
    expect(button("Connect Postiz")).toBeUndefined();
    await act(async () => root.unmount());
    host.remove();
    fixture.api.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    fixture.api.mockImplementation(async () => { throw Object.assign(new Error("Only the owner or an admin can manage the Postiz connection."), { status: 403 }); });
    await act(async () => root.render(createElement(PostizCard, { onConnection })));
    await settle();
    expect(host.querySelector('[data-app-tile="postiz"]')).toBeNull();
  });

  it("on a Team Cloud, lets the admin keep Postiz for each person, and connects their own", async () => {
    await mount({ ...base, state: "not-connected", how: null, team: true });
    expect(text()).toContain("Only for me");
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push([method, path, typeof init?.body === "string" ? JSON.parse(init.body) : undefined]);
      if (path === "/api/postiz" && method === "GET") return { ...base, state: "not-connected", how: "sign-in", team: true, scope: "person" };
      if (path === "/api/team/my-connections") return { mcp: [{ name: "postiz", connected: calls.filter(([, p]) => p === "/api/team/my-connections").length >= 2, how: "sign-in" }] };
      if (path === "/api/team/my-connections/mcp/postiz/sign-in") return { auth: { phase: "waiting", flowId: "own", authorizationUrl, expiresAt: "2026-10-29T12:00:00Z" } };
      return { ok: true, servers: [] };
    });
    await act(async () => host.querySelector<HTMLInputElement>("[data-postiz-only-me] input")!.click());
    await act(async () => button("Connect Postiz")!.click());
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_200); });
    await settle();
    expect(calls).toContainEqual(["PUT", "/api/team/connection-scopes", { kind: "mcp", id: "postiz", scope: "person" }]);
    expect(calls).toContainEqual(["PATCH", "/api/mcp/servers/postiz", { enabled: true }]);
    expect(calls).toContainEqual(["POST", "/api/team/my-connections/mcp/postiz/sign-in", undefined]);
    expect(openExternal).toHaveBeenCalledWith(authorizationUrl);
    expect(calls.some(([, path]) => path === "/api/mcp/servers/postiz/sign-in")).toBe(false);
  });
});
