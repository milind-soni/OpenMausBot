import { describe, expect, it } from "vitest";
import { createBoatHealth, DEAD_COMPUTER, unansweredStatus } from "./boat-health.ts";

const clock = () => {
  let at = 1_000_000;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cloud computer health", () => {
  it("counts only gateway failures as no answer, never the relay's account-wide 503", () => {
    expect([502, 504, 522, 524].map(unansweredStatus)).toEqual([true, true, true, true]);
    expect([200, 400, 404, 409, 429, 500, 503].map(unansweredStatus)).toEqual([false, false, false, false, false, false, false]);
  });

  it("one failed command only starts a probe, and a probe that answers clears it", async () => {
    const time = clock(), health = createBoatHealth(time.now);
    const heard: string[] = [];
    health.onNotResponding((boxId) => heard.push(boxId));
    let probes = 0;
    health.suspect("bx_a", async () => { probes += 1; return true; });
    await settle();
    expect(probes).toBe(1);
    expect(health.notRespondingSince("bx_a")).toBeNull();
    expect(health.answeredWithin("bx_a", 1_000)).toBe(true);
    expect(heard).toEqual([]);
  });

  it("a probe the provider refused counts neither way", async () => {
    const time = clock(), health = createBoatHealth(time.now);
    health.unanswered("bx_a");
    health.suspect("bx_a", async () => null);
    await settle();
    expect(health.answeredWithin("bx_a", 60_000)).toBe(false);
    time.advance(30_000);
    health.unanswered("bx_a");
    time.advance(31_000);
    health.unanswered("bx_a");
    expect(health.notRespondingSince("bx_a")).not.toBeNull();
  });

  it("remembers when a person last opened a computer's desktop", () => {
    const time = clock(), health = createBoatHealth(time.now);
    health.personUsed("bx_a");
    time.advance(DEAD_COMPUTER.personGraceMs);
    expect(health.personUsedWithin("bx_a", DEAD_COMPUTER.personGraceMs)).toBe(true);
    time.advance(1);
    expect(health.personUsedWithin("bx_a", DEAD_COMPUTER.personGraceMs)).toBe(false);
  });

  it("probes at most once per gap however many commands fail", async () => {
    const time = clock(), health = createBoatHealth(time.now);
    let probes = 0;
    const probe = async () => { probes += 1; return false; };
    for (let i = 0; i < 10; i++) health.suspect("bx_a", probe);
    await settle();
    expect(probes).toBe(1);
    time.advance(DEAD_COMPUTER.probeGapMs - 1);
    health.suspect("bx_a", probe);
    await settle();
    expect(probes).toBe(1);
    time.advance(1);
    health.suspect("bx_a", probe);
    await settle();
    expect(probes).toBe(2);
  });

  it("three probes with no answer inside a minute are not yet a dead computer", () => {
    const time = clock(), health = createBoatHealth(time.now);
    const heard: string[] = [];
    health.onNotResponding((boxId) => heard.push(boxId));
    for (let i = 0; i < 5; i++) { health.unanswered("bx_a"); time.advance(10_000); }
    expect(health.notRespondingSince("bx_a")).toBeNull();
    expect(heard).toEqual([]);
  });

  it("three probes with no answer over a minute or more mark it not responding, reported once per gap", () => {
    const time = clock(), health = createBoatHealth(time.now);
    const heard: Array<[string, number]> = [];
    health.onNotResponding((boxId, since) => heard.push([boxId, since]));
    const first = time.now();
    health.unanswered("bx_a");
    time.advance(30_000);
    health.unanswered("bx_a");
    time.advance(30_000);
    health.unanswered("bx_a");
    expect(health.notRespondingSince("bx_a")).toBe(first);
    expect(heard).toEqual([["bx_a", first]]);
    time.advance(30_000);
    health.unanswered("bx_a");
    expect(heard).toHaveLength(1);
    time.advance(DEAD_COMPUTER.reportGapMs);
    health.unanswered("bx_a");
    expect(heard).toHaveLength(2);
  });

  it("an answer in between starts the count again", () => {
    const time = clock(), health = createBoatHealth(time.now);
    health.unanswered("bx_a");
    time.advance(40_000);
    health.unanswered("bx_a");
    health.answered("bx_a");
    time.advance(40_000);
    health.unanswered("bx_a");
    expect(health.notRespondingSince("bx_a")).toBeNull();
  });

  it("knows whether another computer answered recently", () => {
    const time = clock(), health = createBoatHealth(time.now);
    health.answered("bx_a");
    expect(health.otherAnsweredWithin("bx_a", DEAD_COMPUTER.witnessMs)).toBe(false);
    health.answered("bx_b");
    expect(health.otherAnsweredWithin("bx_a", DEAD_COMPUTER.witnessMs)).toBe(true);
    time.advance(DEAD_COMPUTER.witnessMs + 1);
    expect(health.otherAnsweredWithin("bx_a", DEAD_COMPUTER.witnessMs)).toBe(false);
  });
});
