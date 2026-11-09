// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { favoriteKey, favoriteModels, forgetFavoriteModelsForTest } from "@/lib/favorite-models";
import { FavoriteStar } from "./SimpleModelMenu";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  forgetFavoriteModelsForTest();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the star on a model", () => {
  it("toggles in place, says which way it will go, and is remembered", () => {
    flushSync(() => root.render(createElement(FavoriteStar, { instanceId: "openaiCompat", model: "qwen3:4b", name: "qwen3:4b" })));
    const star = host.querySelector<HTMLButtonElement>("[data-model-favorite]")!;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(star.getAttribute("aria-label")).toBe("Add qwen3:4b to favorites");
    flushSync(() => star.click());
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.getAttribute("aria-label")).toBe("Remove qwen3:4b from favorites");
    expect(favoriteModels().has(favoriteKey("openaiCompat", "qwen3:4b"))).toBe(true);
    expect(JSON.parse(localStorage.getItem("omb-favorite-models")!)).toEqual([favoriteKey("openaiCompat", "qwen3:4b")]);
    flushSync(() => star.click());
    expect(star.getAttribute("aria-pressed")).toBe("false");
  });
});
