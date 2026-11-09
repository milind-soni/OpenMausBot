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
  fixture.api.mockImplementation(async (path: string, init?: { signal?: AbortSignal }) => {
    if (path === "/api/auth/sessions") return { sessions: [], current: null };
    if (path === "/api/config") return new Promise((resolve, reject) => { resolveConfig = resolve; rejectConfig = reject; init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true }); });
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

const device = { id: "d1", label: "MacBook", scopes: ["admin"], lastSeenAt: Date.now(), expiresAt: Date.now() + 3_600_000 };
const signOutButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) as HTMLButtonElement | undefined;
const installSessionsMock = (failOnCall: number | null) => {
  let sessionsCalls = 0;
  fixture.api.mockImplementation(async (path: string, init?: { signal?: AbortSignal }) => {
    if (path === "/api/auth/sessions") {
      sessionsCalls++;
      if (failOnCall !== null && sessionsCalls === failOnCall) throw new Error("sessions down");
      return { sessions: [device], current: null };
    }
    if (path === "/api/config") return new Promise((resolve, reject) => { resolveConfig = resolve; rejectConfig = reject; init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true }); });
    if (path === "/api/auth/pairing") return { id: "offer-1", code: "ABCD-EFGH-IJKL", expiresAt: Date.now() + 300_000, url: "https://example.test/pair?code=ABCD-EFGH-IJKL", hint: null };
    return {};
  });
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

  it("keeps a sessions error visible when a config retry succeeds", async () => {
    let rejectSessions: (error: unknown) => void;
    fixture.api.mockImplementationOnce(async () => new Promise((_, reject) => { rejectSessions = reject; }));
    await renderCard();
    await act(async () => {
      rejectConfig(new Error("config down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      rejectSessions(new Error("sessions down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(host.textContent).toContain("sessions down");
    const retry = host.querySelector<HTMLButtonElement>("[data-server-pairing-retry]");
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(false);
    expect(host.querySelector("[data-server-pairing-retry]")).toBeNull();
    expect(host.textContent).toContain("sessions down");
  });

  it("makes Retry available when the config request stalls", async () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(createElement(ServerPairingCard, { initialSession: { kind: "loopback" } })));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(fixture.api.mock.calls.some(([path]) => path === "/api/config")).toBe(true);
      expect(createButton().disabled).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(createButton().disabled).toBe(true);
      const retry = host.querySelector<HTMLButtonElement>("[data-server-pairing-retry]");
      expect(retry).not.toBeNull();
      await act(async () => { retry!.click(); });
      await act(async () => {
        resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(createButton().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves focus to the create button once it is enabled", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    const opener = document.createElement("button");
    document.body.append(opener);
    try {
      act(() => { opener.focus(); });
      await renderCard({ focusRequest: 1 });
      expect(createButton().disabled).toBe(true);
      expect(document.activeElement).toBe(opener);
      await act(async () => {
        resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      expect(document.activeElement).toBe(createButton());
    } finally {
      opener.remove();
      vi.unstubAllGlobals();
    }
  });

  it("cancels a focus request recorded with no focused element", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    try {
      await renderCard({ focusRequest: 1 });
      expect(document.activeElement).toBe(document.body);
      await act(async () => {
        resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      expect(createButton().disabled).toBe(false);
      expect(document.activeElement).toBe(document.body);
      expect(document.activeElement).not.toBe(createButton());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not reveal a body-origin request after focus moved away and back", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    try {
      await renderCard({ focusRequest: 1 });
      const scope = host.querySelector<HTMLInputElement>('input[name="server-pairing-scope"]');
      expect(scope).not.toBeNull();
      await act(async () => { scope!.focus(); });
      expect(document.activeElement).toBe(scope);
      await act(async () => { (document.activeElement as HTMLElement).blur(); });
      expect(document.activeElement).toBe(document.body);
      await act(async () => {
        resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      expect(document.activeElement).toBe(document.body);
      expect(document.activeElement).not.toBe(createButton());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not steal focus when the user moved focus while config loaded", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
    try {
      await renderCard({ focusRequest: 1 });
      const scope = host.querySelector<HTMLInputElement>('input[name="server-pairing-scope"]');
      expect(scope).not.toBeNull();
      await act(async () => { scope!.focus(); });
      expect(document.activeElement).toBe(scope);
      await act(async () => {
        resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
        await new Promise((r) => setTimeout(r, 0));
      });
      await flush();
      expect(document.activeElement).toBe(scope);
      expect(document.activeElement).not.toBe(createButton());
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("retries the config load after a failure and offers creation once it succeeds", async () => {
    await renderCard();
    expect(createButton().disabled).toBe(true);
    await act(async () => {
      rejectConfig(new Error("config down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(true);
    const retry = host.querySelector<HTMLButtonElement>("[data-server-pairing-retry]");
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(false);
    expect(host.querySelector("[data-server-pairing-retry]")).toBeNull();
    expect(host.textContent).not.toContain("config down");
  });

  it("issues one config request for rapid retries and disables Retry while it runs", async () => {
    await renderCard();
    await act(async () => {
      rejectConfig(new Error("config down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    const retry = host.querySelector<HTMLButtonElement>("[data-server-pairing-retry]");
    expect(retry).not.toBeNull();
    const configCalls = () => fixture.api.mock.calls.filter(([path]) => path === "/api/config").length;
    expect(configCalls()).toBe(1);
    await act(async () => {
      retry!.click();
      retry!.click();
    });
    expect(configCalls()).toBe(2);
    await flush();
    expect(retry!.disabled).toBe(true);
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(false);
  });

  it("offers the same retry in simple mode", async () => {
    await renderCard({ simple: true });
    await act(async () => {
      rejectConfig(new Error("config down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    const retry = host.querySelector<HTMLButtonElement>("[data-server-pairing-retry]");
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(createButton().disabled).toBe(false);
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

  it("keeps a config error visible when a device signs out", async () => {
    installSessionsMock(null);
    await renderCard();
    await act(async () => {
      rejectConfig(new Error("config down"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(host.textContent).toContain("config down");
    const signOut = signOutButton();
    expect(signOut).not.toBeUndefined();
    await act(async () => { signOut!.click(); });
    await flush();
    expect(host.textContent).toContain("config down");
  });

  it("keeps a sessions error visible when a code is created", async () => {
    installSessionsMock(1);
    await renderCard();
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    expect(host.textContent).toContain("sessions down");
    expect(createButton().disabled).toBe(false);
    await act(async () => { createButton().click(); });
    await flush();
    expect(host.textContent).toContain("ABCD-EFGH-IJKL");
    expect(host.textContent).toContain("sessions down");
  });

  it("clears a sessions error when a session reload succeeds", async () => {
    installSessionsMock(2);
    await renderCard();
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    const firstSignOut = signOutButton();
    expect(firstSignOut).not.toBeUndefined();
    await act(async () => { firstSignOut!.click(); });
    await flush();
    expect(host.textContent).toContain("sessions down");
    const secondSignOut = signOutButton();
    expect(secondSignOut).not.toBeUndefined();
    await act(async () => { secondSignOut!.click(); });
    await flush();
    expect(host.textContent).not.toContain("sessions down");
  });

  it("clears an action error when a later create succeeds", async () => {
    await renderCard();
    await act(async () => {
      resolveConfig({ membership: { pairingCodes: true }, computerName: "Mac" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    fixture.api.mockImplementationOnce(async () => { throw new Error("create down"); });
    await act(async () => { createButton().click(); });
    await flush();
    expect(host.textContent).toContain("create down");
    await act(async () => { createButton().click(); });
    await flush();
    expect(host.textContent).not.toContain("create down");
    expect(host.textContent).toContain("ABCD-EFGH-IJKL");
  });
});
