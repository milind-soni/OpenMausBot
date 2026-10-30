import { describe, expect, it } from "vitest";
import { EMPTY_ONBOARDING } from "./onboarding";
import en from "@/locales/en.json";
import { ANCHOR_EFFECTS, currentStep, stepNumber, TOUR_STEPS, tourSteps, withTourFinished, withTourReset } from "./guided-tour";

const withDone = (ids: string[]) => ({ ...EMPTY_ONBOARDING, hintsSeen: ids });
const step = (id: string) => TOUR_STEPS.find((s) => s.id === id)!;

describe("guided tour", () => {
  it("starts at the composer and ends back on the chat", () => {
    expect(currentStep(undefined)?.id).toBe("tour.composer");
    expect(TOUR_STEPS.at(-1)?.id).toBe("tour.done");
    expect(TOUR_STEPS.at(-1)?.anchor).toBe("composer");
  });

  it("resumes at the first unfinished step", () => {
    expect(currentStep(withDone(["tour.composer", "tour.model"]))?.id).toBe("tour.computer");
    expect(currentStep(withDone(TOUR_STEPS.map((s) => s.id)))).toBeNull();
    expect(currentStep(withDone(["spot.composer"]))?.id).toBe("tour.composer");
  });

  it("numbers steps without counting the closing card", () => {
    expect(stepNumber(TOUR_STEPS[0]!)).toEqual({ current: 1, total: TOUR_STEPS.length - 1 });
    expect(stepNumber(TOUR_STEPS.at(-1)!).current).toBe(TOUR_STEPS.length - 1);
  });

  it("resets and finishes without touching other hints", () => {
    const record = withDone(["spot.approval", "tour.composer"]);
    expect(withTourReset(record)).toEqual(["spot.approval"]);
    const finished = withTourFinished(record);
    expect(finished).toContain("spot.approval");
    for (const s of TOUR_STEPS) expect(finished).toContain(s.id);
    expect(new Set(finished).size).toBe(finished.length);
  });

  it("goes through the Tools menu rather than straight to the pages", () => {
    expect(step("tour.tools").onExit).toBe("openTools");
    expect(step("tour.apps").onExit).toBe("openApps");
    expect(step("tour.automations").onEnter).toBe("openTools");
    expect(step("tour.automations").onExit).toBe("openAutomations");
    for (const s of TOUR_STEPS.filter((x) => x.anchor?.startsWith("nav-"))) expect(s.skipIfMissing).toBe(true);
  });

  it("rebuilds the scene on enter so a reload mid-tour resumes cleanly", () => {
    expect(step("tour.computer-browser").onEnter).toBe("openComputer");
    expect(step("tour.computer-browser").fallbackAnchor).toBe("computer-tabs");
    expect(step("tour.apps").onEnter).toBe("openTools");
    expect(step("tour.apps-panel").onEnter).toBe("openApps");
    expect(step("tour.automations-page").onEnter).toBe("openAutomations");
  });

  it("closes everything it opened and returns to the chat", () => {
    expect(step("tour.computer").onExit).toBe("openComputer");
    expect(step("tour.computer-browser").onExit).toBe("closeComputer");
    expect(step("tour.apps-panel").onExit).toBe("closeApps");
    expect(step("tour.automations-page").onExit).toBe("backToChat");
  });

  it("knows which effects the control's own click performs", () => {
    for (const s of TOUR_STEPS) {
      if (s.onExit && ANCHOR_EFFECTS.has(s.onExit)) expect(s.anchor).not.toBeNull();
    }
    expect(ANCHOR_EFFECTS.has("closeApps")).toBe(false);
  });

  it("keeps Advanced mode's steps exactly as they were", () => {
    expect(tourSteps(true)).toBe(TOUR_STEPS);
    expect(step("tour.model")).toEqual({ id: "tour.model", anchor: "model", placement: "below" });
    expect(step("tour.computer")).toEqual({ id: "tour.computer", anchor: "computer", placement: "below", onExit: "openComputer" });
  });

  it("walks Simple mode through the bot pill where the header's model chip and Computer button were", () => {
    const simple = tourSteps(false);
    expect(simple.map((s) => s.id)).toEqual(TOUR_STEPS.map((s) => s.id));
    expect(simple.map((s) => s.anchor)).toEqual([
      "composer", "bot-pill", "bot-pill", "computer-browser", "tools", "nav-apps", "apps-panel", "nav-automations", "automations-page", "composer",
    ]);
    // Simple's header renders neither "model" nor "computer"; a step that needs them would wait forever.
    for (const s of simple) expect(["model", "computer"]).not.toContain(s.anchor);
    for (const id of ["tour.model", "tour.computer"]) {
      const simpleStep = simple.find((s) => s.id === id)!;
      expect(simpleStep.skipIfMissing, id).toBe(true);
      expect((en as Record<string, string>)[simpleStep.copy!], id).toBeTruthy();
    }
    const simpleModel = (en as Record<string, string>)[simple.find((s) => s.id === "tour.model")!.copy!]!;
    expect(simpleModel, "Simple mode picks no model, so its tour never points at one").not.toMatch(/\bmodel\b/i);
    // The computer step still opens the Computer panel for the next step, as its Advanced button did.
    expect(simple.find((s) => s.id === "tour.computer")!.onExit).toBe("openComputer");
    expect(simple.find((s) => s.id === "tour.computer-browser")!.onEnter).toBe("openComputer");
  });

  it("resumes at the same step and number in either mode", () => {
    const record = withDone(["tour.composer"]);
    expect(currentStep(record, false)).toMatchObject({ id: "tour.model", anchor: "bot-pill" });
    expect(currentStep(record, true)).toMatchObject({ id: "tour.model", anchor: "model" });
    expect(currentStep(record)).toBe(step("tour.model"));
    expect(stepNumber(currentStep(record, false)!)).toEqual(stepNumber(step("tour.model")));
    expect(stepNumber(currentStep(record, false)!).current).toBe(2);
    expect(currentStep(withDone(TOUR_STEPS.map((s) => s.id)), false)).toBeNull();
  });
});
