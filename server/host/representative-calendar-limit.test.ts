import { describe, expect, it } from "vitest";

import { representativePrompt, type Busy, type Question } from "./representative.ts";

const NOW = Date.UTC(2026, 9, 27);
const HOUR = 60 * 60_000;
const input: Question = {
  person: { key: "p_ben", name: "Ben" }, bot: { id: "bens-chief" },
  team: "Acme", asker: "Cleo", question: "When is Ben free this week?", shared: { notes: [], work: [] },
};
const slots = (count: number): Busy[] => Array.from({ length: count }, (_, index) => ({
  start: NOW + (index * 2 + 1) * HOUR, end: NOW + (index * 2 + 2) * HOUR,
}));
const prompt = (busy: Busy[]) => representativePrompt(input, busy, "UTC", NOW);

describe("the representative's bounded calendar facts", () => {
  it("does not call omitted busy periods free when the list is truncated", () => {
    const result = prompt(slots(81));
    expect(result).not.toContain("free at every other time");
    expect(result).toContain("additional busy times are omitted");
    expect(result).toContain("availability outside these intervals is unknown");
    expect(result).toContain("Mon 2 Nov 15:00–16:00");
    expect(result).not.toContain("Mon 2 Nov 17:00–18:00");
  });

  it("keeps the partial-data warning when the provider returns slots out of order", () => {
    const busy = slots(81).reverse();
    const original = structuredClone(busy);
    expect(prompt(busy)).toContain("availability outside these intervals is unknown");
    expect(busy).toEqual(original);
  });

  it("retains complete availability at the exact limit", () => {
    expect(prompt(slots(80))).toContain("free at every other time");
    expect(prompt(slots(80))).not.toContain("additional busy times are omitted");
  });

  it("does not count expired intervals against the limit", () => {
    const expired = Array.from({ length: 100 }, () => ({ start: NOW - HOUR, end: NOW }));
    expect(prompt([...expired, ...slots(80)])).toContain("free at every other time");
  });
});
