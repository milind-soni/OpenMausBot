import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { withTourReset } from "@/lib/guided-tour";
import { dismissNotice, nextNotice, noticeSeen, PRO_NOTICE, STAR_NOTICE, usedBefore, type NoticeFacts } from "./notices";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (pro: boolean | null, star: boolean | null): NoticeFacts => ({ [PRO_NOTICE]: pro, [STAR_NOTICE]: star });
const none = () => false;

it("the Pro card's dismissal is new for this release: an earlier dismissal does not count", () => {
  expect(PRO_NOTICE).toBe("pro-introduction-dismissed-v3");
  for (const earlier of ["pro-introduction-dismissed", "pro-introduction-dismissed-v2"]) {
    storage.set(earlier, "1");
    expect(noticeSeen(record([earlier]), PRO_NOTICE), earlier).toBe(false);
  }
  expect(STAR_NOTICE).not.toBe(PRO_NOTICE);
});

it("shows one notice at a time, Pro first, then the star", () => {
  expect(nextNotice(facts(true, true), none)).toBe(PRO_NOTICE);
  expect(nextNotice(facts(true, true), id => id === PRO_NOTICE)).toBe(STAR_NOTICE);
  expect(nextNotice(facts(true, true), () => true)).toBeNull();
  // Someone who may not be offered a plan (a payer) goes straight to the star.
  expect(nextNotice(facts(false, true), none)).toBe(STAR_NOTICE);
  expect(nextNotice(facts(false, false), none)).toBeNull();
});

it("waits while an earlier notice's answer is unknown, so the star never shows before the Pro card", () => {
  expect(nextNotice(facts(null, true), none)).toBeNull();
  // Already dismissed: the unknown answer no longer matters.
  expect(nextNotice(facts(null, true), id => id === PRO_NOTICE)).toBe(STAR_NOTICE);
  expect(nextNotice(facts(true, null), id => id === PRO_NOTICE)).toBeNull();
});

it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, STAR_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", STAR_NOTICE] } });
  expect(storage.get(STAR_NOTICE)).toBe("1");
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(false);
  expect(noticeSeen(record([STAR_NOTICE]), STAR_NOTICE)).toBe(true);
  // Already in the record: nothing more to send.
  expect(dismissNotice(record([STAR_NOTICE]), STAR_NOTICE)).toBeNull();
  // Replaying the tour keeps both dismissals.
  expect(withTourReset(record([PRO_NOTICE, STAR_NOTICE, "tour.done"]))).toEqual([PRO_NOTICE, STAR_NOTICE]);
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), STAR_NOTICE)).toBe(false);
  expect(noticeSeen(record([STAR_NOTICE]), STAR_NOTICE)).toBe(true);
  expect(dismissNotice(record(), STAR_NOTICE)).toEqual({ onboarding: { hintsSeen: [STAR_NOTICE] } });
});

it("someone has used the app before when a conversation from before this launch has had a reply", () => {
  const launch = 1_000_000;
  const task = (createdAt: number, turns?: number) => ({ createdAt, ...(turns === undefined ? {} : { usage: { turns } }) });
  expect(usedBefore([], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 1)] }], launch)).toBe(true);
  // Brand new: the first conversation started in this launch.
  expect(usedBefore([{ tasks: [task(launch, 3)] }], launch)).toBe(false);
  // An earlier conversation nobody wrote in yet (a seeded bot's first thread).
  expect(usedBefore([{ tasks: [task(launch - 1, 0), task(launch - 1)] }, {}], launch)).toBe(false);
  expect(usedBefore([{}, { tasks: [task(launch + 5, 2), task(launch - 9, 2)] }], launch)).toBe(true);
});
