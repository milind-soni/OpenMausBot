// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
}));
vi.mock("../lib/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/session")>(),
  readSessionState: async () => ({ kind: "loopback" as const }),
}));

const { ServerPairingCard } = await import("./ServerPairingCard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let resolveConfig: (value: unknown) => void;
let rejectConfig: (error: unknown) => void;

const flush = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  setLocale("en");
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/auth/sessions") return { sessions: [], current: null };
    if (path === "/api/config") return new Promise((resolve, reject) => { resolveConfig = resolve; rejectConfig = reject; });
    if (path === "/api/auth/pairing") return { id: "offer-1", code: "ABCD-EFGH-IJKL", expiresAt: Date.now() + 300_000, url: "https://example.test/pair?code=ABCD-EFGH-IJKL", hint: null };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const renderCard = async (props: Parameters<typeof ServerPairingCard>[0] = {}) => {
  await act(async () => root.render(createElement(ServerPairingCard, { initialSession: { kind: "loopback" }, ...props })));
  await flush();
};

const createButton = () => host.querySelector<HTMLButtonElement>("[data-phone-pairing-action]")!;
const pairingCall = () => fixture.api.mock.calls.find(([path]) => path === "/api/auth/pairing");
const pairingScopes = () => {
  const [, init] = pairingCall() ?? [];
  return JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")).scopes as string[];
};

describe("ServerPairingCard waits for the pairing configuration", () => {
  it("keeps creation disabled until the config loads, then offers it", async () => {
    await renderCard();
    expect(createButton().disabled).toBe(true);
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(false);
  });

  it("keeps creation disabled when the config request fails", async () => {
    await renderCard();
    expect(createButton().disabled).toBe(true);
    await act(async () => {
      rejectConfig(new Error("config down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(true);
    expect(host.textContent).toContain("config down");
  });

  it("creates an admin-scoped invitation for the desktop owner", async () => {
    await renderCard();
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    await act(async () => { createButton().click(); });
    await flush();
    expect(pairingScopes()).toEqual(["admin", "client"]);
    expect(host.textContent).toContain("ABCD-EFGH-IJKL");
  });

  it("creates a client-scoped invitation when the client scope is picked", async () => {
    await renderCard();
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    const client = [...host.querySelectorAll('input[name="server-pairing-scope"]')].find((el) => el.closest("label")?.textContent?.includes("Chat and approvals only")) as HTMLInputElement;
    expect(client).not.toBeUndefined();
    await act(async () => { client.click(); });
    await act(async () => { createButton().click(); });
    await flush();
    expect(pairingScopes()).toEqual(["client"]);
    expect(host.textContent).toContain("ABCD-EFGH-IJKL");
  });
});
