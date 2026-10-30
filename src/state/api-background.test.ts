import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudAsleep, markCloudAsleep, resetCloudPowerForTests } from "../lib/cloud-power";
import { api, ApiError } from "./store";

afterEach(() => { vi.unstubAllGlobals(); resetCloudPowerForTests(); });

describe("api() and a Cloud home that sleeps", () => {
  it("marks background polls, and leaves every other request as before", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api("/api/team-map", { background: true });
    await api("/api/threads");
    await api("/api/upload", { method: "PUT", headers: { "x-omb-sha256": "abc" } });
    const sent = fetch.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sent[0].get("x-omb-background")).toBe("1");
    expect(sent[0].get("content-type")).toBe("application/json");
    expect(sent[1].get("x-omb-background")).toBeNull();
    expect(sent[1].get("content-type")).toBe("application/json");
    expect(sent[2].get("content-type")).toBeNull();
    expect(sent[2].get("x-omb-sha256")).toBe("abc");
  });

  it("never sends a background poll while the home sleeps; anything else wakes it", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    markCloudAsleep(undefined);
    await expect(api("/api/team-map", { background: true })).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    await api("/api/threads");
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/auth/session", "/api/threads"]);
    expect(cloudAsleep()).toBe(false);
  });

  it("goes quiet on the home's asleep answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "asleep" }), { status: 503, headers: { "x-omb-cloud-power": "asleep" } })));
    await expect(api("/api/sync")).rejects.toBeInstanceOf(ApiError);
    expect(cloudAsleep()).toBe(true);
  });

  it("holds background requests while the page is hidden, one per path, and sends them once it shows", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const page = hiddenPage();
    vi.stubGlobal("document", page);
    // A poll that ticks twice while hidden asks once; other paths each wait; the person's own request goes at once.
    const held = [api("/api/limit-resets", { background: true }), api("/api/limit-resets", { background: true }), api("/api/inbox", { background: true }),
      api("/api/inbox/a/read", { method: "POST", background: true })];
    await api("/api/threads");
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/threads"]);
    page.show();
    await Promise.all(held);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/threads", "/api/limit-resets", "/api/inbox", "/api/inbox/a/read"]);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get("x-omb-background")).toBe("1");
    expect(page.listeners.size).toBe(0);
  });

  it("refuses a held background request if the home fell asleep before the page showed, and lets a caller's signal end the wait", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const page = hiddenPage();
    vi.stubGlobal("document", page);
    const held = api("/api/limit-resets", { background: true });
    const controller = new AbortController();
    const mine = api("/api/team-map", { background: true, signal: controller.signal });
    controller.abort();
    await expect(mine).rejects.toMatchObject({ name: "AbortError" });
    markCloudAsleep(undefined);
    page.show();
    await expect(held).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

/** A hidden page's `document`, as far as api() reads it, that can be shown. */
function hiddenPage() {
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: "hidden" as DocumentVisibilityState,
    listeners,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    show() { page.visibilityState = "visible"; for (const listener of Array.from(listeners)) listener(); },
  };
  return page;
}
