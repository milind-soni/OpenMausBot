// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CachedChatImage } from "./CachedChatImage";
import { ChatCacheScope } from "../lib/chat-cache";

vi.mock("../lib/chat-cache", async original => ({
  ...await original<typeof import("../lib/chat-cache")>(),
  readChatCache: vi.fn(async () => new Blob(["cached"])),
}));

it("shows a stored attachment without contacting the server on remount", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached");
  try {
    for (let visit = 0; visit < 2; visit++) {
      const host = document.createElement("div");
      const root = createRoot(host);
      flushSync(() => root.render(createElement(ChatCacheScope.Provider, { value: "paired" },
        createElement(CachedChatImage, { src: "/api/attachments/example.png" }))));
      await vi.waitFor(() => expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:cached"));
      flushSync(() => root.unmount());
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("checks three distinct lazy images before intersection and downloads only misses", async () => {
  const { ChatImagePreloads } = await import("./CachedChatImage");
  const { readChatCache } = await import("../lib/chat-cache");
  const fetch = vi.fn(async (_src: string) => new Response(new Blob(["image"])));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.mocked(readChatCache).mockImplementation(async (_kind, _scope, key) =>
    key.includes("a.png") ? new Blob(["cached"]) : undefined);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const root = createRoot(document.createElement("div"));
  try {
    flushSync(() => root.render(createElement(ChatCacheScope.Provider, { value: "paired" },
      createElement(ChatImagePreloads.Provider, { value: new Set<string>() },
        ["a", "b", "b", "c", "d"].map((name, key) => createElement(CachedChatImage, {
          key, src: "/api/attachments/" + name + ".png", loading: "lazy",
        }))))));
    await vi.waitFor(() => expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "/api/attachments/b.png", "/api/attachments/c.png",
    ]));
  } finally {
    flushSync(() => root.unmount());
    vi.mocked(readChatCache).mockResolvedValue(new Blob(["cached"]));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("shares one download for the same external Markdown image in two saved messages", async () => {
  const { readChatCache } = await import("../lib/chat-cache");
  vi.mocked(readChatCache).mockResolvedValue(undefined);
  const fetch = vi.fn(async () => new Response(new Blob(["image"])));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:remote");
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(ChatCacheScope.Provider, { value: "paired" },
      ["one", "two"].map(id => createElement(CachedChatImage, { key: id,
        src: `/api/threads/t/messages/${id}/file?preview=1&ref=0`, version: "https://images.example/flower.png" })))));
    await vi.waitFor(() => expect(host.querySelectorAll('img[src="blob:remote"]')).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    vi.mocked(readChatCache).mockResolvedValue(new Blob(["cached"]));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
