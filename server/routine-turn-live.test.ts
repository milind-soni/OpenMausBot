import { expect, it } from "vitest";

import { runTurnLive, type RunTurnFacts } from "./routine-turn-live.ts";

const IDLE: RunTurnFacts = { busy: false, settling: false, queued: false, pending: false, parked: false };
const live = (facts: Partial<RunTurnFacts>, run: { target: "bot" | "room-goal"; threadId: string } = { target: "bot", threadId: "thread-1" }) => runTurnLive(run, () => ({ ...IDLE, ...facts }));

it("takes a run's turn for gone only when nothing of it is left to carry on", () => {
  expect(live({})).toBe(false);
  for (const fact of ["busy", "settling", "queued", "pending"] as const) expect(live({ [fact]: true })).toBe(true);
});

it("keeps a turn parked for a computer alive: it resumes by itself when the computer is free, so the run is never started beside it", () => {
  expect(live({ parked: true })).toBe(true);
});

it("cannot tell for a room goal's run or one with no conversation", () => {
  expect(live({}, { target: "room-goal" as const, threadId: "thread-1" })).toBeNull();
  expect(runTurnLive({ target: "bot", threadId: undefined }, () => IDLE)).toBeNull();
});
