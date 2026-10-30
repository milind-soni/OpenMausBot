// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { XConnectorStatus } from "../../shared/x-connector";

const fixture = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { api: vi.fn(), dispatch: vi.fn(), track: vi.fn(), config: {} as Record<string, unknown> };
});
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));

import { XCard } from "./XCard";

const USAGE = { calls: 312, max: 5_000, resetsAt: "2026-11-01T00:00:00.000Z" };
const KEY = "treg_live_0123456789";

interface Server {
  own: boolean;
  included: boolean;
  usage?: XConnectorStatus["usage"];
  check: { ok: boolean; check: "treg"; balanceUsd?: number; message?: string };
  calls: Array<[string, string, unknown]>;
}
let server: Server;
let host: HTMLDivElement;
let root: Root;
let onConnection: ReturnType<typeof vi.fn<(connected: boolean | null) => void>>;

const settle = () => act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); });
const card = () => host.querySelector<HTMLElement>('[data-app-tile="x"]')!;
const text = () => card().textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
const field = () => host.querySelector<HTMLInputElement>("[data-x-key-form] input");
const configStatus = () => ({ treg: { configured: server.own }, xResearch: { included: server.included } });

function serve() {
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.calls.push([method, path, body]);
    if (path.startsWith("/api/x/status") && method === "GET") {
      const status: XConnectorStatus = { using: server.own ? "own" : server.included ? "included" : null, ownKey: server.own, included: server.included };
      return server.included && server.usage ? { ...status, usage: server.usage } : status;
    }
    if (path === "/api/config" && method === "PUT") { server.own = Boolean(body.treg.key); return configStatus(); }
    if (path === "/api/keys/test" && method === "POST") return server.check;
    throw new Error(`unexpected ${method} ${path}`);
  });
}

async function mount(state: Partial<Server>) {
  server = { own: false, included: false, check: { ok: true, check: "treg", balanceUsd: 4.25 }, calls: [], ...state };
  fixture.config = configStatus();
  serve();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(XCard, { onConnection })));
  await settle();
}

async function type(value: string) {
  const input = field()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { host.querySelector<HTMLFormElement>("[data-x-key-form]")!.requestSubmit(); });
  await settle();
}
async function click(label: string) {
  await act(async () => { button(label)!.click(); });
  await settle();
}

beforeEach(() => {
  setLocale("en");
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.track.mockReset();
  onConnection = vi.fn<(connected: boolean | null) => void>();
  (window as unknown as { ogb?: unknown }).ogb = undefined;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the X card in Apps", () => {
  it("shows a Cloud plan's included calls with this month's use, and nothing to set up", async () => {
    await mount({ included: true, usage: USAGE });
    expect(card().dataset.xState).toBe("included");
    expect(text()).toContain("X (Twitter)");
    expect(text()).toContain("Included with your plan");
    expect(text()).toContain("312 of 5,000 X calls this month. They reset on November 1.");
    expect(field()).toBeNull();
    expect(button("Use my own treg key")).toBeDefined();
    expect(onConnection).toHaveBeenLastCalledWith(true);
  });

  it("says when the month's included calls are used up and how to keep going, with the key field open", async () => {
    await mount({ included: true, usage: { ...USAGE, calls: 5_000, usedUp: true } });
    expect(text()).toContain("This month's included X calls are used up. They reset on November 1. Add your own treg key to keep going.");
    expect(field()).not.toBeNull();
  });

  it("names a free trial's calls, and when its full allowance starts once they are used up", async () => {
    await mount({ included: true, usage: { calls: 2, max: 3, resetsAt: USAGE.resetsAt, trialEndsAt: "2026-10-25T09:00:00.000Z" } });
    expect(text()).toContain("2 of 3 X calls in your free trial.");
    await act(async () => root.unmount());
    host.remove();
    await mount({ included: true, usage: { calls: 3, max: 3, usedUp: true, resetsAt: USAGE.resetsAt, trialEndsAt: "2026-10-25T09:00:00.000Z" } });
    expect(text()).toContain("Your free trial's included X calls are used up. Your full allowance starts on October 25. Add your own treg key to keep going.");
  });

  it("asks everyone else for a treg key with a link to treg.to, saves it where keys go, tests it once and says it works", async () => {
    await mount({});
    expect(card().dataset.xState).toBe("none");
    expect(text()).toContain("Add your treg key");
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://treg.to"]')?.textContent).toContain("Get a key at treg.to");
    expect(onConnection).toHaveBeenLastCalledWith(false);
    await type(KEY);
    await submit();
    expect(server.calls.filter(([method]) => method !== "GET")).toEqual([
      ["PUT", "/api/config", { treg: { key: KEY } }],
      ["POST", "/api/keys/test", { provider: "treg" }],
    ]);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { treg: { configured: true }, xResearch: { included: false } } });
    expect(card().dataset.xState).toBe("own");
    expect(text()).toContain("Using your treg key");
    expect(text()).toContain("treg is working ✓ Balance: $4.25.");
    expect(field()).toBeNull();
    expect(fixture.track).toHaveBeenCalledWith("api_key_saved", { provider: "treg", via: "apps", result: "ok" });
    expect(onConnection).toHaveBeenLastCalledWith(true);
  });

  it("saves a pasted key into the desktop's encrypted store when the app has one", async () => {
    const setCredential = vi.fn(async (_name: string, value: string) => { server.own = Boolean(value); return configStatus(); });
    (window as unknown as { ogb: unknown }).ogb = { setCredential };
    await mount({});
    await type(KEY);
    await submit();
    expect(setCredential).toHaveBeenCalledWith("tregApiKey", KEY);
    expect(server.calls.some(([method, path]) => method === "PUT" && path === "/api/config")).toBe(false);
  });

  it("refuses something that is not a key without saving it", async () => {
    await mount({});
    await type("my treg key");
    await submit();
    expect(text()).toContain("doesn't look like an API key");
    expect(server.calls.filter(([method]) => method !== "GET")).toEqual([]);
  });

  it("says the person's own key is used first when the plan's calls are there too, and Test shows treg's plain reason", async () => {
    await mount({ own: true, included: true, usage: USAGE, check: { ok: false, check: "treg", message: "treg rejected this key. Copy it again from treg.to." } });
    expect(card().dataset.xState).toBe("own");
    expect(text()).toContain("Your own treg key is used first, and calls are billed to your treg balance. Your plan's included X calls wait until you remove it.");
    await click("Test");
    expect(text()).toContain("treg rejected this key. Copy it again from treg.to.");
  });

  it("falls back to the plan's included calls when the key is removed", async () => {
    await mount({ own: true, included: true, usage: USAGE });
    await click("Remove key");
    expect(server.calls).toContainEqual(["PUT", "/api/config", { treg: { key: "" } }]);
    expect(card().dataset.xState).toBe("included");
    expect(text()).toContain("Included with your plan");
    expect(fixture.track).toHaveBeenCalledWith("api_key_removed", { provider: "treg", via: "apps" });
  });

  it("removing the only key leaves no X, and the card asks for a key again", async () => {
    await mount({ own: true });
    expect(text()).toContain("Your bots search and read X with your own treg key. Calls are billed to your treg balance.");
    await click("Remove key");
    expect(card().dataset.xState).toBe("none");
    expect(field()).not.toBeNull();
    expect(onConnection).toHaveBeenLastCalledWith(false);
  });

  it("speaks the app's language", async () => {
    setLocale("de");
    await mount({ included: true, usage: USAGE });
    expect(text()).toContain("In deinem Tarif enthalten");
    expect(text()).toContain("312 von 5.000 X-Aufrufen in diesem Monat.");
  });
});
