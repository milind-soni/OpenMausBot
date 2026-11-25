// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MausMotion, MausState } from "@/lib/mascot";
import { BotAvatar } from "./Avatar";
import { pictureTransform } from "./BotPicture";
import { REST_POSE, VIEW_SPAN } from "./mascot-motion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

let reducedMotion = false;
vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() { return query.includes("reduce") && reducedMotion; },
  addEventListener: () => {},
  removeEventListener: () => {},
}));

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  reducedMotion = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const bot = { name: "Atlas", color: "green" as const, avatarUrl: "/api/attachments/atlas.png", avatarCrop: "circle" as const };
const render = (state: MausState, animated?: boolean, beat?: { motion: MausMotion; motionKey: number }) =>
  act(() => root.render(createElement(BotAvatar, { bot, state, size: 44, ...(animated === undefined ? {} : { animated }), ...beat })));
const run = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const picture = () => host.querySelector<HTMLElement>('[data-avatar="picture"]')!;

function transformsOver(ms: number): Set<string> {
  const seen = new Set<string>();
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    run(50);
    seen.add(picture().style.transform);
  }
  return seen;
}

describe("a bot's own picture follows its state", () => {
  it("names the state it shows, in the same words as an object mascot", () => {
    render("working");
    expect(picture().dataset.pictureState).toBe("working");
    render("notifying");
    expect(picture().dataset.pictureState).toBe("waiting");
    render("excited");
    expect(picture().dataset.pictureState).toBe("idle");
  });

  it("moves while the bot works, as the mascot's body would", () => {
    render("working");
    const seen = transformsOver(1200);
    expect(seen.size).toBeGreaterThan(3);
    expect([...seen].some((transform) => transform.includes("translate("))).toBe(true);
  });

  it("holds still at rest, and stops once the work ends", () => {
    render("idle");
    expect(transformsOver(1000)).toEqual(new Set([""]));
    render("working");
    expect(transformsOver(600).size).toBeGreaterThan(1);
    render("idle");
    run(50);
    expect(transformsOver(600)).toEqual(new Set([""]));
  });

  it("holds still where the caller asks it to, and with reduced motion", () => {
    render("working", false);
    expect(transformsOver(1000)).toEqual(new Set([""]));
    act(() => root.unmount());
    root = createRoot(host);
    reducedMotion = true;
    render("working");
    expect(transformsOver(1000)).toEqual(new Set([""]));
  });
});

describe("a bot's own picture gives way to the mascot's glyph", () => {
  const glyph = () => host.querySelector<SVGGElement>("svg g");
  const photo = () => host.querySelector<HTMLImageElement>("img")!;
  function glyphPeak(ms: number) {
    let peak = { glyph: 0, photo: 1, markup: "" };
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      run(50);
      const layer = glyph();
      const shown = Number(layer?.style.opacity || 0);
      if (layer && shown > peak.glyph) peak = { glyph: shown, photo: Number(photo().style.opacity || 1), markup: layer.innerHTML };
    }
    return peak;
  }

  it("shows the \"!\" in the bot's colour while a reply waits for the person, and the picture fades for it", () => {
    render("notifying");
    const peak = glyphPeak(4500);
    expect(peak.glyph).toBe(1);
    expect(peak.photo).toBe(0);
    expect(peak.markup).toContain('fill="#009957"');
  });

  it("shows no glyph while the bot just works, or where the picture holds still", () => {
    render("working");
    expect(glyphPeak(4500).glyph).toBe(0);
    render("notifying", false);
    expect(glyphPeak(4500).glyph).toBe(0);
    expect(host.querySelector("svg")).toBeNull();
  });
});

describe("a bot's own picture plays the mascot's beats", () => {
  it("takes a beat's state while it plays, then rests again", () => {
    render("idle", undefined, { motion: "alert", motionKey: 1 });
    expect(picture().dataset.pictureState).toBe("waiting");
    expect(transformsOver(1000).size).toBeGreaterThan(3);
    run(600);
    expect(picture().dataset.pictureState).toBe("idle");
    expect(transformsOver(1000)).toEqual(new Set([""]));
  });

  it("ignores a beat where the picture holds still", () => {
    render("idle", false, { motion: "alert", motionKey: 2 });
    expect(picture().dataset.pictureState).toBe("idle");
    expect(transformsOver(1000)).toEqual(new Set([""]));
  });
});

describe("pictureTransform", () => {
  it("is empty at rest", () => {
    expect(pictureTransform(REST_POSE, 44)).toBe("");
  });

  it("scales the body's travel to the picture's size and squashes it on its bottom edge", () => {
    expect(pictureTransform({ ...REST_POSE, y: -3 }, VIEW_SPAN)).toBe("translate(0.00px, -3.00px)");
    expect(pictureTransform({ ...REST_POSE, y: -3 }, VIEW_SPAN / 2)).toBe("translate(0.00px, -1.50px)");
    expect(pictureTransform({ ...REST_POSE, rotate: 2 }, 44)).toBe("rotate(2.00deg)");
    expect(pictureTransform({ ...REST_POSE, sx: 1.1, sy: 0.9 }, 40)).toBe("translateY(20.00px) scale(1.1000, 0.9000) translateY(-20.00px)");
  });
});
