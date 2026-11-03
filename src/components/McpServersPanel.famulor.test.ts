// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";

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

const famulor = { name: "famulor", type: "http", url: "https://app.famulor.io/mcp", headerKeys: [], enabled: false, auth: "needs-sign-in" };

function FamulorCard() { return McpServersPanel({ nativeCard: "famulor" }); }

let host: HTMLDivElement;
let root: Root;
let testRequest: { resolve: (value: unknown) => void; signal?: AbortSignal } | null;

const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
const card = () => host.querySelector<HTMLElement>('[data-app-tile="famulor"]')!;
const button = (label: string) => [...card().querySelectorAll("button")].find((element) => element.textContent?.trim() === label)!;

beforeEach(async () => {
  vi.clearAllMocks();
  setLocale("en");
  testRequest = null;
  fixture.runMcpSignIn.mockResolvedValue({ phase: "succeeded", flowId: "00000000-0000-4000-8000-000000000000", authorizationUrl: null });
  fixture.api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/mcp/servers") return Promise.resolve({ servers: [famulor] });
    if (path === "/api/mcp/servers/famulor/test") {
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
  await act(async () => root.render(createElement(FamulorCard)));
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

describe("Connecting Famulor from its card", () => {
  it("says it is loading Famulor's tools while the test runs, then shows why it failed in one line", async () => {
    await connect();
    expect(testRequest).not.toBeNull();
    expect(card().querySelector('[role="status"]')?.textContent).toContain(t("famulor.loadingTools"));
    expect(card().textContent).not.toContain("Waiting");
    expect(button("Cancel")).toBeTruthy();

    await act(async () => testRequest!.resolve({ ok: false, error: "The server did not answer in time." }));
    await settle();

    const alerts = [...card().querySelectorAll('[role="alert"]')].map((element) => element.textContent);
    expect(alerts).toEqual([
      t("famulor.testFailed", { reason: "The server did not answer in time." }),
    ]);
    expect(fixture.api.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    expect(button("Connect")).toBeTruthy();
  });

  it("keeps the reason when the test request itself is refused", async () => {
    await connect();
    await act(async () => { testRequest!.resolve(Promise.reject(new Error("Two MCP connection tests are already running."))); });
    await settle();
    expect(card().querySelector('[role="alert"]')?.textContent)
      .toBe(t("famulor.testFailed", { reason: "Two MCP connection tests are already running." }));
  });

  it("ends a reason that has no period of its own, like a proxy's 504", async () => {
    await connect();
    await act(async () => { testRequest!.resolve(Promise.reject(new Error("504 Gateway Timeout"))); });
    await settle();
    expect(card().querySelector('[role="alert"]')?.textContent)
      .toBe(t("famulor.testFailed", { reason: "504 Gateway Timeout." }));
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
