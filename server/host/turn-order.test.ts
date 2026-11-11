import { describe, expect, it } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import { createTurnOrder, type TurnOrderDeps } from "./turn-order.ts";

const first = (over: Partial<TurnOrderDeps>) => createTurnOrder({
  turn: () => undefined, unattended: () => false, running: () => [], roomLine: () => false, ...over,
})("t");
const node = (over: Partial<HandoffView>) => over as HandoffView;

describe("a person's own work", () => {
  it("is their line, in a chat or a room", () => {
    expect(first({ turn: () => ({ kind: "person", personLine: true }) })).toBe(true);
    expect(first({ roomLine: () => true })).toBe(true);
  });

  it("is a turn going on from what they answered on a card, not what a bot or a default answered", () => {
    expect(first({ running: () => [node({ answer: "the password is saved" })] })).toBe(true);
    expect(first({ running: () => [node({ answer: "Tuesday", answeredBy: { kind: "bot", botId: "b" } })] })).toBe(false);
    expect(first({ running: () => [node({ answer: "Tuesday", answeredBy: { kind: "default" } })] })).toBe(false);
  });

  it("is a turn going on from a line of theirs, unless a bot drives it", () => {
    expect(first({ turn: () => ({ kind: "continuation", personLine: true }) })).toBe(true);
    expect(first({ turn: () => ({ kind: "continuation", personLine: true }), unattended: () => true })).toBe(false);
    expect(first({ turn: () => ({ kind: "continuation" }) })).toBe(false);
  });

  it("is not a hand-off, a teammate's results coming back, a routine or a webhook", () => {
    for (const kind of ["handoff", "routine", "webhook"] as const) expect(first({ turn: () => ({ kind, personLine: true }) }), kind).toBe(false);
    expect(first({ running: () => [node({ status: "running" })] })).toBe(false);
  });
});
