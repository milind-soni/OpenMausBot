import { describe, expect, it } from "vitest";

import { changedRoutineRefusalText } from "../cloud-lending.ts";
import { addServerLinePacks } from "../server-lines.ts";
import type { RoutineRunStatus } from "../../shared/routines.ts";
import { createRefusedLending } from "./refused-lending.ts";

type Run = { id: string; startedAt?: number };

function fixture(over: { device?: "PC" | "Mac" | "computer" | null; status?: (id: string) => RoutineRunStatus | undefined; language?: string } = {}) {
  let current: Run | undefined = { id: "run_1" };
  const refused = createRefusedLending({
    runOf: () => current, statusOf: (id) => over.status?.(id) ?? "running",
    lentDevice: () => (over.device === undefined ? "PC" : over.device), language: () => over.language,
  });
  return { refused, now: (run: Run | undefined) => { current = run; } };
}

const SAID = changedRoutineRefusalText("Morning plan", "PC");
const FAILS = { text: SAID, partial: false, lendingRefused: true };

describe("a routine's run refused the lent computer (server/host/refused-lending.ts)", () => {
  it("a run refused a use of the computer fails, once, with the very sentence the bot was given, reading as not finished", () => {
    const { refused } = fixture();
    refused.refused("t", "run_1", "Morning plan", true);
    expect(refused.ending("t", null)).toEqual(FAILS);
    expect(refused.ending("t", null)).toBeNull();
    const mac = fixture({ device: "Mac" });
    mac.refused.refused("t", "run_1", "Morning plan", true);
    expect(mac.refused.ending("t", null)).toEqual({ ...FAILS, text: changedRoutineRefusalText("Morning plan", "Mac") });
  });

  it("a run that only listed the computers ends as it would, and its report carries the sentence under its reply, once", () => {
    const { refused } = fixture();
    refused.refused("t", "run_1", "Morning plan", false);
    expect(refused.ending("t", null)).toBeNull();
    expect(refused.notes.has("run_1")).toBe(true);
    expect(refused.notes.take("run_1", undefined)).toBe(SAID);
    expect(refused.notes.has("run_1")).toBe(false);
    expect(refused.notes.take("run_1", undefined)).toBeNull();
  });

  it("a use refused after a listing, or before one, is a use", () => {
    for (const order of [[false, true], [true, false]]) {
      const { refused } = fixture();
      for (const used of order) refused.refused("t", "run_1", "Morning plan", used);
      expect(refused.ending("t", null)).toEqual(FAILS);
    }
  });

  it("forgets the refusal once a later call in the same run gets the computer (the person saved the routine meanwhile)", () => {
    const { refused } = fixture();
    refused.refused("t", "run_1", "Morning plan", true);
    refused.allowed("t");
    expect(refused.ending("t", null)).toBeNull();
    expect(refused.notes.has("run_1")).toBe(false);
  });

  it("stays quiet for a run never refused, and when nothing is lent, since then the refusal cost it nothing", () => {
    expect(fixture().refused.ending("t", null)).toBeNull();
    const none = fixture({ device: null });
    none.refused.refused("t", "run_1", "Morning plan", true);
    expect(none.refused.ending("t", null)).toBeNull();
  });

  it("leaves a refused hand-off as it was when the computer was never refused, and says both, its own first, when it was", () => {
    expect(fixture().refused.ending("t", "Nothing was sent.")).toBe("Nothing was sent.");
    const used = fixture();
    used.refused.refused("t", "run_1", "Morning plan", true);
    expect(used.refused.ending("t", "Nothing was sent.")).toEqual({ ...FAILS, text: `${SAID} Nothing was sent.` });
    const listed = fixture();
    listed.refused.refused("t", "run_1", "Morning plan", false);
    expect(listed.refused.ending("t", "Nothing was sent.")).toEqual({ text: `${SAID} Nothing was sent.`, partial: false });
    expect(listed.refused.notes.has("run_1")).toBe(false);
  });

  it("keeps the instruction whole within a failed run's 500 characters: a long name gives way, and so does a long hand-off", () => {
    const { refused } = fixture();
    refused.refused("t", "run_1", "Plan ".repeat(60), true);
    const ended = refused.ending("t", "Rooms couldn't hand this on. ".repeat(30)) as { text: string };
    expect(ended.text.length).toBeLessThanOrEqual(500);
    expect(ended.text).toContain("Open it and save it to make it yours again.");
    expect(ended.text).toContain("…\" can't use your PC");
  });

  it("is never another run's: a refusal for a run that is no longer this conversation's, or a later run here, says nothing", () => {
    const late = fixture();
    late.refused.refused("t", "run_0", "Morning plan", true);
    expect(late.refused.ending("t", null)).toBeNull();
    const next = fixture();
    next.refused.refused("t", "run_1", "Morning plan", true);
    next.now({ id: "run_2" });
    expect(next.refused.ending("t", null)).toBeNull();
  });

  it("forgets the refusal of a run that ended without saying it", () => {
    const status = new Map<string, RoutineRunStatus>([["run_1", "failed"]]);
    const { refused, now } = fixture({ status: (id) => status.get(id) });
    refused.refused("t", "run_1", "Morning plan", true);
    now({ id: "run_2" });
    refused.refused("t", "run_2", "Evening plan", true);
    now({ id: "run_1" });
    expect(refused.ending("t", null)).toBeNull();
    now({ id: "run_2" });
    expect(refused.ending("t", null)).toEqual({ ...FAILS, text: changedRoutineRefusalText("Evening plan", "PC") });
  });

  it("is not a retry's: the same run started again after its refused attempt ends as that attempt did not", () => {
    const { refused, now } = fixture();
    now({ id: "run_1", startedAt: 1 });
    refused.refused("t", "run_1", "Morning plan", true);
    now({ id: "run_1", startedAt: 2 });
    expect(refused.ending("t", null)).toBeNull();
    now({ id: "run_1", startedAt: 1 });
    expect(refused.ending("t", null), "taken once, by the attempt that ended").toBeNull();
  });

  it("reads in the language of the chat: the run's for a failure, the chat it reports to for the line under a reply", () => {
    // A pack of its own: the catalogs themselves are the locale tests' to read (scripts/ci-scope.test.ts).
    addServerLinePacks({ xx: { "server.runs.lentComputerUnconfirmed": "{name} · {device}" } });
    const { refused } = fixture({ language: "xx" });
    refused.refused("t", "run_1", "Plano da manhã", true);
    expect(refused.ending("t", null)).toEqual({ ...FAILS, text: "Plano da manhã · PC" });
    const listed = fixture();
    listed.refused.refused("t", "run_1", "Plano da manhã", false);
    listed.refused.ending("t", null);
    expect(listed.refused.notes.take("run_1", "xx")).toBe("Plano da manhã · PC");
  });
});
