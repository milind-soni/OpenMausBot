// @vitest-environment happy-dom
// Connecting Whop from its app card: OAuth succeeds, then the app lists
// Whop's tools once before turning the server on. When that list fails, the
// card says why in one line (the test's own reason) and Connect retries;
// while it runs, the card says it is loading tools and Cancel stops it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  runMcpSignIn: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/mcp-sign-in", async (original) => ({
  ...(await original<typeof import("@/lib/mcp-sign-in")>()),
  runMcpSignIn: fixture.runMcpSignIn,
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/mcp-servers", () => ({ updateMcpServers: vi.fn() }));

import { McpServersPanel } from "./McpServersPanel";

const whop = { name: "whop", type: "http", url: "https://mcp.whop.com/mcp", headerKeys: [], enabled: false, auth: "needs-sign-in" };

function WhopCard() { return McpServersPanel({ whopCard: true }); }

let host: HTMLDivElement;
let root: Root;
let testRequest: { resolve: (value: unknown) => void; signal?: AbortSignal } | null;

const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
const card = () => host.querySelector<HTMLElement>('[data-app-tile="whop"]')!;
const button = (label: string) => [...card().querySelectorAll("button")].find((element) => element.textContent?.trim() === label)!;

beforeEach(async () => {
  vi.clearAllMocks();
  setLocale("en");
  testRequest = null;
  fixture.runMcpSignIn.mockResolvedValue({ phase: "succeeded", flowId: "00000000-0000-4000-8000-000000000000", authorizationUrl: null });
  fixture.api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return Promise.resolve({ servers: [whop] });
    if (path === "/api/mcp/servers/whop/test") {
      return new Promise((resolve, reject) => {
        testRequest = { resolve, signal: init?.signal ?? undefined };
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.reject(new Error(`unexpected ${init?.method ?? "GET"} ${path}`));
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(WhopCard)));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function connect() {
  await act(async () => button("Connect").click());
  await settle();
}

describe("Connecting Whop from its card", () => {
  it("says it is loading Whop's tools while the test runs, then shows why it failed in one line", async () => {
    await connect();
    expect(testRequest).not.toBeNull();
    expect(card().querySelector('[role="status"]')?.textContent).toContain("Signed in. Loading Whop’s tools…");
    expect(card().textContent).not.toContain("Waiting");
    expect(button("Cancel")).toBeTruthy();

    await act(async () => testRequest!.resolve({ ok: false, error: "The server did not answer in time." }));
    await settle();

    const alerts = [...card().querySelectorAll('[role="alert"]')].map((element) => element.textContent);
    expect(alerts).toEqual([
      "Signed in, but Whop’s tools could not be loaded: The server did not answer in time. Please connect again to retry.",
    ]);
    // never turned on, and Connect is the retry
    expect(fixture.api.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    expect(button("Connect")).toBeTruthy();
  });

  it("keeps the reason when the test request itself is refused", async () => {
    await connect();
    await act(async () => { testRequest!.resolve(Promise.reject(new Error("Two MCP connection tests are already running."))); });
    await settle();
    expect(card().querySelector('[role="alert"]')?.textContent)
      .toBe("Signed in, but Whop’s tools could not be loaded: Two MCP connection tests are already running. Please connect again to retry.");
  });

  it("ends a reason that has no period of its own, like a proxy's 504", async () => {
    await connect();
    await act(async () => { testRequest!.resolve(Promise.reject(new Error("504 Gateway Timeout"))); });
    await settle();
    expect(card().querySelector('[role="alert"]')?.textContent)
      .toBe("Signed in, but Whop’s tools could not be loaded: 504 Gateway Timeout. Please connect again to retry.");
  });

  it("closes the test request when the person cancels", async () => {
    await connect();
    expect(testRequest?.signal?.aborted).toBe(false);
    await act(async () => button("Cancel").click());
    await settle();
    expect(testRequest?.signal?.aborted).toBe(true);
    expect(card().querySelector('[role="alert"]')).toBeNull();
  });
});
