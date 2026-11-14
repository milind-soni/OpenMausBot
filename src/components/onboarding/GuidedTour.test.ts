import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, WELCOME_VERSION } from "@/lib/onboarding";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: store.state, dispatch: vi.fn() }) }));
vi.mock("./Spotlight", () => ({ Spotlight: () => null }));
import { GuidedTour } from "./GuidedTour";
import { Spotlight } from "./Spotlight";

function render() {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = GuidedTour();
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  return tree as { type?: unknown } | null;
}

beforeEach(() => {
  fixture.values = [];
  vi.stubGlobal("window", {});
  const welcomed = { ...EMPTY_ONBOARDING, completedAt: "2026-10-23T00:00:00.000Z", version: WELCOME_VERSION };
  store.state = { config: { onboarding: welcomed }, welcomeOpen: false, tourOpen: false, computerOpen: false, pluginsOpen: false };
});

describe("the app tour", () => {
  it("never starts by itself once the welcome is done, now or after a reload, though none of its steps were seen", () => {
    expect(render()).toBeNull();
    fixture.values = [];
    expect(render(), "after a reload").toBeNull();
  });

  it("still starts from Settings' Replay app tour, and not over the welcome", () => {
    store.state = { ...store.state, tourOpen: true };
    expect(render()?.type).toBe(Spotlight);
    store.state = { ...store.state, welcomeOpen: true };
    expect(render()).toBeNull();
  });
});
