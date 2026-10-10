import { describe, expect, it } from "vitest";
import { CLOUD_INTENT_GIVEN, CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED, cloudSetupItems, cloudSetupStage, moveStatus, type CloudSetupFacts } from "./cloud-setup";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "./onboarding";

const owner = { hosted: false, canSave: true, cloudHome: true };
const record = (extra: Partial<OnboardingStatus> = {}): OnboardingStatus => ({ ...EMPTY_ONBOARDING, ...extra });
const facts = (extra: Partial<CloudSetupFacts> = {}): CloudSetupFacts => ({
  viewer: owner, connected: true, enginesKnown: true, engineReady: false, onboarding: record(), move: null, ...extra,
});
const idle = { phase: "idle" as const, suggest: true };
const steps = (value: CloudSetupFacts) => cloudSetupItems(value).map((item) => `${item.id}:${item.status}`);

describe("cloudSetupStage", () => {
  it("is only for the owner's own session on a Cloud home", () => {
    expect(cloudSetupStage(facts())).toBe("shown");
    // The desktop's own server and a self-hosted one say nothing of a Cloud home.
    expect(cloudSetupStage(facts({ viewer: { hosted: false, canSave: true } }))).toBe("none");
    // A guest's paired phone can neither sign engines in nor save the record.
    expect(cloudSetupStage(facts({ viewer: { ...owner, canSave: false } }))).toBe("none");
    expect(cloudSetupStage(facts({ viewer: null }))).toBe("none");
  });

  it("waits for the Cloud's answers instead of guessing", () => {
    expect(cloudSetupStage(facts({ connected: false }))).toBe("waiting");
    expect(cloudSetupStage(facts({ enginesKnown: false }))).toBe("waiting");
    expect(cloudSetupStage(facts({ onboarding: undefined }))).toBe("waiting");
  });

  it("with a first job given, waits for its routine: the bot's first turn only asks its questions", () => {
    const given = record({ hintsSeen: [CLOUD_INTENT_GIVEN], firstTurnAt: "2026-09-30T08:00:00.000Z" });
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: given }))).toBe("shown");
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: given, planned: true }))).toBe("done");
    expect(cloudSetupStage(facts({ onboarding: given, planned: true }))).toBe("shown");
  });

  it("goes away once an engine can run and a bot has finished a turn there, or once hidden", () => {
    const turned = record({ firstTurnAt: "2026-09-30T08:00:00.000Z" });
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: turned }))).toBe("done");
    // Either one alone is not enough.
    expect(cloudSetupStage(facts({ engineReady: true }))).toBe("shown");
    expect(cloudSetupStage(facts({ onboarding: turned }))).toBe("shown");
    expect(cloudSetupStage(facts({ onboarding: record({ hintsSeen: [CLOUD_SETUP_HIDDEN] }) }))).toBe("hidden");
    // Another hint, such as a finished guided tour step, is not Hide setup.
    expect(cloudSetupStage(facts({ onboarding: record({ hintsSeen: ["tour.composer"] }) }))).toBe("shown");
  });
});

describe("cloudSetupItems", () => {
  it("starts one step in: the Cloud exists", () => {
    expect(steps(facts())).toEqual(["cloud:done", "job:todo", "engine:todo"]);
  });

  it("connecting an AI is done when any engine can run", () => {
    expect(steps(facts({ engineReady: true }))).toContain("engine:done");
  });

  it("a first job is done once one is given, or once a turn has finished there", () => {
    expect(steps(facts({ onboarding: record({ hintsSeen: ["cloud-intent-asked"] }) }))).toContain("job:todo");
    expect(steps(facts({ onboarding: record({ hintsSeen: [CLOUD_INTENT_GIVEN] }) }))).toContain("job:done");
    expect(steps(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).toContain("job:done");
  });

  it("a given job adds its plan: done once its routine exists", () => {
    const given = record({ hintsSeen: [CLOUD_INTENT_GIVEN] });
    expect(steps(facts({ onboarding: given }))).toEqual(["cloud:done", "job:done", "engine:todo", "plan:todo"]);
    expect(steps(facts({ onboarding: given, engineReady: true, planned: true }))).toEqual(["cloud:done", "job:done", "engine:done", "plan:done"]);
    // Skipped, or a Cloud that has simply been used: no plan to approve.
    expect(steps(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).not.toContain("plan:todo");
  });

  it("bringing bots is listed only in the desktop app while main offers it, and is done after a move or skipped", () => {
    // A browser has no bridge; main has not answered; main does not offer it
    // (the Cloud is not empty, or this computer has nothing to bring).
    expect(steps(facts({ move: null }))).not.toContain("move:todo");
    expect(moveStatus({ phase: "idle", suggest: false }, record())).toBeNull();
    expect(steps(facts({ move: idle }))).toEqual(["cloud:done", "job:todo", "engine:todo", "move:todo"]);
    // Under way or stopped: it stays, with its progress or error.
    for (const phase of ["preparing", "uploading", "restarting", "failed"] as const) {
      expect(moveStatus({ phase, action: "move", suggest: false }, record())).toBe("todo");
    }
    expect(moveStatus({ phase: "done", action: "move", suggest: false }, record())).toBe("done");
    expect(moveStatus({ phase: "idle", suggest: false }, record({ hintsSeen: [CLOUD_SETUP_MOVE_SKIPPED] }))).toBe("skipped");
    expect(moveStatus({ phase: "idle", suggest: true }, record({ hintsSeen: [CLOUD_SETUP_MOVE_SKIPPED] }))).toBe("skipped");
    // Swapping back to a previous Cloud is not bringing bots over.
    expect(moveStatus({ phase: "done", action: "restore", suggest: false }, record())).toBeNull();
    expect(moveStatus({ phase: "replacing", action: "restore", suggest: false }, record())).toBeNull();
  });
});
