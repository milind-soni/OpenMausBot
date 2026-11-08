import { describe, expect, it, vi } from "vitest";
import { createScreenWake } from "./screen-wake";

function fakeDocument() {
  const listeners = new Map<string, Array<() => void>>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type: string, cb: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== cb));
    },
    dispatch: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
  };
  return doc;
}

function fakeWakeLock(doc: ReturnType<typeof fakeDocument>) {
  const releaseHandlers: Array<() => void> = [];
  const sentinel = {
    release: vi.fn(async () => {
      releaseHandlers.forEach((fn) => fn());
    }),
    addEventListener: (_type: string, fn: () => void) => {
      releaseHandlers.push(fn);
    },
  };
  const request = vi.fn(async () => {
    if (doc.visibilityState === "hidden") throw new DOMException("The page is hidden.", "NotAllowedError");
    return sentinel;
  });
  return { request, sentinel };
}

describe("screen wake lock", () => {
  it("requests a screen lock on acquire and releases it on release", async () => {
    const doc = fakeDocument();
    const lock = fakeWakeLock(doc);
    const wake = createScreenWake({ wakeLock: lock, doc });
    wake.acquire();
    await vi.waitFor(() => expect(lock.request).toHaveBeenCalledWith("screen"));
    expect(wake.held).toBe(true);
    wake.release();
    expect(lock.sentinel.release).toHaveBeenCalledOnce();
    expect(wake.held).toBe(false);
  });

  it("does nothing when the Wake Lock API is absent", () => {
    const wake = createScreenWake({ wakeLock: undefined, doc: fakeDocument() });
    expect(() => {
      wake.acquire();
      wake.release();
    }).not.toThrow();
    expect(wake.held).toBe(false);
  });

  it("re-requests the lock when the page becomes visible after the browser dropped it", async () => {
    const doc = fakeDocument();
    const lock = fakeWakeLock(doc);
    const wake = createScreenWake({ wakeLock: lock, doc });
    wake.acquire();
    await vi.waitFor(() => expect(wake.held).toBe(true));
    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    expect(lock.request).toHaveBeenCalledOnce();
    await lock.sentinel.release();
    expect(wake.held).toBe(false);
    doc.visibilityState = "visible";
    doc.dispatch("visibilitychange");
    await vi.waitFor(() => expect(lock.request).toHaveBeenCalledTimes(2));
    expect(wake.held).toBe(true);
  });

  it("does not re-request while the page stays hidden", async () => {
    const doc = fakeDocument();
    const lock = fakeWakeLock(doc);
    const wake = createScreenWake({ wakeLock: lock, doc });
    wake.acquire();
    await vi.waitFor(() => expect(wake.held).toBe(true));
    await lock.sentinel.release();
    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    expect(lock.request).toHaveBeenCalledOnce();
  });

  it("retries on visible after a request the hidden page rejected", async () => {
    const doc = fakeDocument();
    const lock = fakeWakeLock(doc);
    doc.visibilityState = "hidden";
    const wake = createScreenWake({ wakeLock: lock, doc });
    wake.acquire();
    await vi.waitFor(() => expect(lock.request).toHaveBeenCalledOnce());
    expect(wake.held).toBe(false);
    doc.visibilityState = "visible";
    doc.dispatch("visibilitychange");
    await vi.waitFor(() => expect(lock.request).toHaveBeenCalledTimes(2));
    expect(wake.held).toBe(true);
  });

  it("stops re-requesting once released", async () => {
    const doc = fakeDocument();
    const lock = fakeWakeLock(doc);
    const wake = createScreenWake({ wakeLock: lock, doc });
    wake.acquire();
    await vi.waitFor(() => expect(wake.held).toBe(true));
    wake.release();
    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    doc.visibilityState = "visible";
    doc.dispatch("visibilitychange");
    expect(lock.request).toHaveBeenCalledOnce();
  });
});
