// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CachedChatImage, ImageCacheScope } from "./CachedChatImage";

it.each([
  { scope: "session", status: 304, immediate: false },
  { scope: "session", status: 403, immediate: false },
  { scope: "loopback", status: 304, immediate: true },
  { scope: "loopback", status: 503, immediate: true },
])("renders a cached image for $scope with update status $status", async ({ scope, status, immediate }) => {
  const cached = { blob: new Blob(["cached"]), saved: Date.now(), etag: '"image"' };
  function lookup<T>(result: T) {
    const request = { result, onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  }
  const store = {
    get: () => lookup(cached),
    delete: vi.fn(),
    index: () => ({ openCursor: () => lookup(null) }),
  };
  const db = { transaction: () => ({ objectStore: () => store }) };
  vi.stubGlobal("indexedDB", { open: () => lookup(db) });
  vi.stubGlobal("IDBKeyRange", { upperBound: () => ({}) });
  const result = Promise.withResolvers<Response>();
  const fetchImage = vi.fn(() => result.promise);
  vi.stubGlobal("fetch", fetchImage);
  const url = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached");
  const host = document.createElement("div");
  const root = createRoot(host);
  const src = "/api/attachments/example.png";
  try {
    flushSync(() => root.render(createElement(ImageCacheScope.Provider, { value: scope },
      createElement(CachedChatImage, { src }))));
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledWith(src, expect.objectContaining({
      headers: { "If-None-Match": cached.etag },
    })));
    if (immediate) await vi.waitFor(() => expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:cached"));
    else expect(url).not.toHaveBeenCalled();
    result.resolve(new Response(null, { status }));
    await vi.waitFor(() => expect(host.querySelector("img")?.getAttribute("src")).toBe(status === 304 || immediate ? "blob:cached" : src));
    expect(url).toHaveBeenCalledTimes(status === 304 || immediate ? 1 : 0);
  } finally {
    flushSync(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
