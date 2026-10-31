import { describe, expect, it } from "vitest";
import { afterStep, READING_MS, readingTimeMs, SIDEBAR_TOUR_ORDER, sidebarTourPlan, sidebarTourStep } from "./sidebar-tour";
import { en, localeChoices, locales } from "@/locales";

const ids = (plan: ReturnType<typeof sidebarTourPlan>) => plan?.steps.map((step) => step.id);
const shown = { available: true, hidden: false }, hidden = { available: true, hidden: true }, none = { available: false, hidden: false };

describe("the tour of the rail of places", () => {
  it("points at the window's own rail beside the page: its places, its +, a right-click, then the button that hides it", () => {
    const plan = sidebarTourPlan({ rail: shown, asked: true, markable: true, drawn: false });
    expect(plan?.where).toBe("chrome");
    expect(ids(plan)).toEqual(["places", "add", "menu", "strip"]);
    expect(plan?.steps.map((step) => [step.anchor, step.rail])).toEqual([["rail-places", "places"], ["rail-add", "add"], ["rail-places", "places"], ["rail-toggle", "dim"]]);
  });

  it("waits for the window's rail to answer, and has nothing to show without a rail", () => {
    expect(sidebarTourPlan({ rail: null, asked: true, markable: true, drawn: false }), "not answered yet").toBeNull();
    expect(sidebarTourPlan({ rail: none, asked: true, markable: true, drawn: false })).toEqual({ where: null, steps: [] });
    expect(sidebarTourPlan({ rail: null, asked: false, markable: false, drawn: false }), "a browser").toEqual({ where: null, steps: [] });
  });

  it("with the rail hidden, only its button, which says what the rail holds", () => {
    const plan = sidebarTourPlan({ rail: hidden, asked: true, markable: true, drawn: false });
    expect(plan?.where).toBeNull();
    expect(ids(plan)).toEqual(["strip"]);
    expect(plan?.steps[0]?.copy).toBe("sidebarTour.stripHidden");
  });

  it("an app that can't mark the rail beside the page shows nothing yet; a rail drawn on the page (an older app's) needs no mark", () => {
    expect(sidebarTourPlan({ rail: shown, asked: true, markable: false, drawn: false })).toEqual({ where: null, steps: [] });
    const drawn = sidebarTourPlan({ rail: null, asked: false, markable: false, drawn: true });
    expect(drawn?.where).toBe("page");
    expect(ids(drawn), "no button to hide a rail drawn on the page").toEqual(["places", "add", "menu"]);
  });

  it("moves through the steps in order, from wherever it came back to, past steps it doesn't have", () => {
    const { steps } = sidebarTourPlan({ rail: shown, asked: true, markable: true, drawn: false })!;
    let at = 0;
    const seen: string[] = [];
    for (let step = sidebarTourStep(steps, at); step; step = sidebarTourStep(steps, at)) { seen.push(step.id); at = afterStep(step); }
    expect(seen).toEqual(SIDEBAR_TOUR_ORDER);
    expect(at).toBe(SIDEBAR_TOUR_ORDER.length);
    const onlyButton = sidebarTourPlan({ rail: hidden, asked: true, markable: true, drawn: false })!.steps;
    expect(sidebarTourStep(onlyButton, 1)?.id, "a tour that came back after the + step goes on to the button").toBe("strip");
    expect(sidebarTourStep(onlyButton, 4)).toBeNull();
  });
});

describe("reading time", () => {
  it("is 3 to 10 seconds, longer for more words, in any language", () => {
    expect(readingTimeMs("Hi")).toBe(READING_MS.min);
    expect(readingTimeMs("word ".repeat(200))).toBe(READING_MS.max);
    const short = readingTimeMs("Hide or show your places any time with this button.");
    const long = readingTimeMs("Add a place with the + button: buy a new Cloud that's always on, or connect your own server with its pairing link.");
    expect(short).toBeGreaterThanOrEqual(3_000);
    expect(long).toBeLessThanOrEqual(10_000);
    expect(long).toBeGreaterThan(short);
    expect(readingTimeMs("このボタンで、いつでも場所を表示したり隠したりできます。", "ja"), "words without spaces count too").toBeGreaterThan(READING_MS.min);
  });
});

it("every language the app ships has the tour's words of its own", () => {
  const keys = ["sidebarTour.places", "sidebarTour.add", "sidebarTour.menu", "sidebarTour.strip", "sidebarTour.stripHidden"] as const;
  const missing = localeChoices.flatMap(({ code }) => keys.filter((key) => !locales[code]?.[key] || (code !== "en" && locales[code]?.[key] === en[key])).map((key) => `${code}: ${key}`));
  expect(missing).toEqual([]);
});
