import { describe, expect, it } from "vitest";
import { CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED, cloudSetupItems, cloudSetupStage, moveStatus, type CloudSetupFacts } from "./cloud-setup";
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
  it("signing in is done when any engine can run", () => {
    expect(steps(facts())).toEqual(["engine:todo", "try:todo"]);
    expect(steps(facts({ engineReady: true }))).toEqual(["engine:done", "try:todo"]);
  });

  it("trying something is done only by the server's record of a finished turn", () => {
    expect(steps(facts({ onboarding: record({ hintsSeen: ["cloud-first-turn"] }) }))).toContain("try:todo");
    expect(steps(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).toContain("try:done");
  });

  it("bringing bots is listed only in the desktop app while main offers it, and is done after a move or skipped", () => {
    // A browser has no bridge; main has not answered; main does not offer it
    // (the Cloud is not empty, or this computer has nothing to bring).
    expect(steps(facts({ move: null }))).not.toContain("move:todo");
    expect(moveStatus({ phase: "idle", suggest: false }, record())).toBeNull();
    expect(steps(facts({ move: idle }))).toEqual(["engine:todo", "move:todo", "try:todo"]);
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

  it("lending is listed only where it is offered, and done when the Cloud lists a lent computer", () => {
    expect(steps(facts())).not.toContain("lend:todo");
    expect(steps(facts({ lend: { lent: null } }))).toEqual(["engine:todo", "try:todo", "lend:todo"]);
    expect(steps(facts({ lend: { lent: false } }))).toContain("lend:todo");
    expect(steps(facts({ lend: { lent: true } }))).toContain("lend:done");
  });

  it("keeps the order: sign in, bring bots, try something, lend", () => {
    expect(cloudSetupItems(facts({ move: idle, lend: { lent: false } })).map((item) => item.id)).toEqual(["engine", "move", "try", "lend"]);
  });
});
