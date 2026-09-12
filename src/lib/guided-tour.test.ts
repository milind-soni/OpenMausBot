import { describe, expect, it } from "vitest";
import { EMPTY_ONBOARDING } from "./onboarding";
import { ANCHOR_EFFECTS, currentStep, stepNumber, TOUR_STEPS, withTourFinished, withTourReset } from "./guided-tour";

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
});
