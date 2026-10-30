import { describe, expect, it } from "vitest";
import {
  CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN, CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, CLOUD_WELCOME_SHOWN, cloudSetupItems, cloudSetupStage,
  cloudWelcomeStage, welcomeStepHint, welcomeView, welcomeViewAfter, type CloudSetupFacts,
} from "./cloud-setup";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "./onboarding";

const owner = { hosted: false, canSave: true, cloudHome: true };
const record = (extra: Partial<OnboardingStatus> = {}): OnboardingStatus => ({ ...EMPTY_ONBOARDING, ...extra });
/** Set up before the welcome existed: its first-job question was answered. */
const before = (extra: Partial<OnboardingStatus> = {}) => record({ ...extra, hintsSeen: [CLOUD_INTENT_ASKED, ...(extra.hintsSeen ?? [])] });
const finished = (...steps: Array<"bring" | "engine" | "files">) => steps.map(welcomeStepHint);
const facts = (extra: Partial<CloudSetupFacts> = {}): CloudSetupFacts => ({
  viewer: owner, connected: true, enginesKnown: true, engineReady: false, onboarding: record(), ...extra,
});
const steps = (value: CloudSetupFacts) => cloudSetupItems(value).map((item) => `${item.id}:${item.status}`);

describe("cloudWelcomeStage", () => {
  it("is only for the owner's own session on a Cloud home, once the Cloud has answered", () => {
    expect(cloudWelcomeStage(facts())).toBe("pending");
    expect(cloudWelcomeStage(facts({ viewer: { hosted: false, canSave: true } }))).toBe("none");
    expect(cloudWelcomeStage(facts({ viewer: { ...owner, canSave: false } }))).toBe("none");
    expect(cloudWelcomeStage(facts({ viewer: null }))).toBe("none");
    expect(cloudWelcomeStage(facts({ connected: false }))).toBe("waiting");
    expect(cloudWelcomeStage(facts({ enginesKnown: false }))).toBe("waiting");
    expect(cloudWelcomeStage(facts({ onboarding: undefined }))).toBe("waiting");
  });

  it("never opens on a Cloud set up before it, and resumes on one that started it even after a chat", () => {
    expect(cloudWelcomeStage(facts({ onboarding: before() }))).toBe("none");
    expect(cloudWelcomeStage(facts({ onboarding: record({ firstTurnAt: "2026-10-01T08:00:00.000Z" }) }))).toBe("none");
    expect(cloudWelcomeStage(facts({ onboarding: record({ hintsSeen: finished("bring"), firstTurnAt: "2026-10-01T08:00:00.000Z" }) }))).toBe("pending");
  });

  it("once shown, stays open through a chat that finishes before its first step, say from a phone", () => {
    const turned = { firstTurnAt: "2026-10-16T08:00:00.000Z" };
    expect(cloudWelcomeStage(facts({ onboarding: record({ ...turned, hintsSeen: [CLOUD_WELCOME_SHOWN] }) }))).toBe("pending");
    expect(cloudWelcomeStage(facts({ onboarding: record({ ...turned, hintsSeen: [CLOUD_WELCOME_SHOWN, CLOUD_INTENT_ASKED] }) }))).toBe("pending");
    expect(cloudWelcomeStage(facts({ onboarding: record(turned) }))).toBe("none");
  });

  it("ends for good when done or skipped, and when setup is hidden", () => {
    expect(cloudWelcomeStage(facts({ onboarding: record({ hintsSeen: [CLOUD_WELCOME_DONE] }) }))).toBe("ended");
    expect(cloudWelcomeStage(facts({ onboarding: record({ hintsSeen: [CLOUD_SETUP_HIDDEN] }) }))).toBe("ended");
  });
});

describe("the welcome's order", () => {
  it("brings this computer's stuff first, before connecting an AI or anything that starts a chat", () => {
    expect(welcomeView(record())).toBe("bring");
    expect(welcomeView(undefined)).toBe("bring");
  });

  it("resumes at the first step not finished, and ends on done", () => {
    expect(welcomeView(record({ hintsSeen: finished("bring") }))).toBe("engine");
    expect(welcomeView(record({ hintsSeen: finished("bring", "engine") }))).toBe("files");
    expect(welcomeView(record({ hintsSeen: finished("engine") }))).toBe("bring");
    expect(welcomeView(record({ hintsSeen: finished("bring", "engine", "files") }))).toBe("done");
  });

  it("moves on to the next open step, back to an earlier one left open, or to done", () => {
    expect(welcomeViewAfter(record(), "bring")).toBe("engine");
    expect(welcomeViewAfter(record({ hintsSeen: finished("engine") }), "bring")).toBe("files");
    expect(welcomeViewAfter(record(), "files")).toBe("bring");
    expect(welcomeViewAfter(record({ hintsSeen: finished("bring", "engine") }), "files")).toBe("done");
  });
});

describe("cloudSetupStage", () => {
  it("is only for the owner's own session on a Cloud home", () => {
    expect(cloudSetupStage(facts())).toBe("shown");
    expect(cloudSetupStage(facts({ viewer: { hosted: false, canSave: true } }))).toBe("none");
    expect(cloudSetupStage(facts({ viewer: { ...owner, canSave: false } }))).toBe("none");
    expect(cloudSetupStage(facts({ viewer: null }))).toBe("none");
  });

  it("waits for the Cloud's answers instead of guessing", () => {
    expect(cloudSetupStage(facts({ connected: false }))).toBe("waiting");
    expect(cloudSetupStage(facts({ enginesKnown: false }))).toBe("waiting");
    expect(cloudSetupStage(facts({ onboarding: undefined }))).toBe("waiting");
  });

  it("gives way to the welcome while it is on screen, so there are never two checklists", () => {
    expect(cloudSetupStage(facts({ welcomeShown: true }))).toBe("welcome");
    expect(cloudSetupStage(facts({ welcomeShown: true, engineReady: true }))).toBe("welcome");
    expect(cloudSetupStage(facts({ welcomeShown: false }))).toBe("shown");
  });

  it("after the welcome, goes once an engine can run, or once a job given at its end has its routine", () => {
    const ended = record({ hintsSeen: [CLOUD_WELCOME_DONE] });
    expect(cloudSetupStage(facts({ onboarding: ended }))).toBe("shown");
    expect(cloudSetupStage(facts({ onboarding: ended, engineReady: true }))).toBe("done");
    const given = record({ hintsSeen: [CLOUD_WELCOME_DONE, CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN] });
    expect(cloudSetupStage(facts({ onboarding: given, engineReady: true }))).toBe("shown");
    expect(cloudSetupStage(facts({ onboarding: given, engineReady: true, planned: true }))).toBe("done");
  });

  it("before the welcome, with a first job given, waits for its routine: the bot's first turn only asks its questions", () => {
    const given = before({ hintsSeen: [CLOUD_INTENT_GIVEN], firstTurnAt: "2026-09-30T08:00:00.000Z" });
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: given }))).toBe("shown");
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: given, planned: true }))).toBe("done");
    expect(cloudSetupStage(facts({ onboarding: given, planned: true }))).toBe("shown");
  });

  it("before the welcome, goes away once an engine can run and a bot has finished a turn there, or once hidden", () => {
    const turned = record({ firstTurnAt: "2026-09-30T08:00:00.000Z" });
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: turned }))).toBe("done");
    expect(cloudSetupStage(facts({ engineReady: true, onboarding: before() }))).toBe("shown");
    expect(cloudSetupStage(facts({ onboarding: turned }))).toBe("shown");
    expect(cloudSetupStage(facts({ onboarding: record({ hintsSeen: [CLOUD_SETUP_HIDDEN] }) }))).toBe("hidden");
  });
});

describe("cloudSetupItems", () => {
  it("while the welcome is open, is its steps in short, one in: the Cloud exists", () => {
    expect(steps(facts())).toEqual(["cloud:done", "move:todo", "engine:todo", "files:todo"]);
  });

  it("takes each of the welcome's steps from the Cloud: brought, started fresh or skipped, and an AI step only once passed there", () => {
    expect(steps(facts({ onboarding: record({ hintsSeen: finished("bring") }) }))).toContain("move:done");
    expect(steps(facts({ onboarding: record({ hintsSeen: [...finished("bring"), CLOUD_SETUP_MOVE_SKIPPED] }) }))).toContain("move:skipped");
    expect(steps(facts({ engineReady: true }))).toContain("engine:todo");
    expect(steps(facts({ engineReady: true, onboarding: record({ hintsSeen: finished("engine") }) }))).toContain("engine:done");
    expect(steps(facts({ onboarding: record({ hintsSeen: finished("engine") }) }))).toContain("engine:skipped");
    expect(steps(facts({ onboarding: record({ hintsSeen: finished("files") }) }))).toContain("files:done");
  });

  it("after the welcome, lists what it brought and the AI, and a job only when one was given", () => {
    const ended = record({ hintsSeen: [...finished("bring"), CLOUD_WELCOME_DONE] });
    expect(steps(facts({ onboarding: ended }))).toEqual(["cloud:done", "engine:todo", "move:done"]);
    const given = record({ hintsSeen: [CLOUD_WELCOME_DONE, CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN] });
    expect(steps(facts({ onboarding: given }))).toEqual(["cloud:done", "job:done", "engine:todo", "plan:todo"]);
  });

  it("before the welcome, starts one step in: the Cloud exists", () => {
    expect(steps(facts({ onboarding: before() }))).toEqual(["cloud:done", "job:todo", "engine:todo"]);
  });

  it("before the welcome, connecting an AI is done when any engine can run", () => {
    expect(steps(facts({ onboarding: before(), engineReady: true }))).toContain("engine:done");
  });

  it("before the welcome, a first job is done once one is given, or once a turn has finished there", () => {
    expect(steps(facts({ onboarding: before() }))).toContain("job:todo");
    expect(steps(facts({ onboarding: before({ hintsSeen: [CLOUD_INTENT_GIVEN] }) }))).toContain("job:done");
    expect(steps(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).toContain("job:done");
  });

  it("before the welcome, a given job adds its plan: done once its routine exists", () => {
    const given = before({ hintsSeen: [CLOUD_INTENT_GIVEN] });
    expect(steps(facts({ onboarding: given }))).toEqual(["cloud:done", "job:done", "engine:todo", "plan:todo"]);
    expect(steps(facts({ onboarding: given, engineReady: true, planned: true }))).toEqual(["cloud:done", "job:done", "engine:done", "plan:done"]);
    expect(steps(facts({ onboarding: record({ firstTurnAt: "2026-09-30T08:00:00.000Z" }) }))).not.toContain("plan:todo");
  });
});
