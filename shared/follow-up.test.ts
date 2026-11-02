import { describe, expect, it } from "vitest";

import { followUpChoices, parseFollowUp, resolveFollowUp } from "./follow-up.ts";

describe("a message sent while a bot works", () => {
  it("is an ordinary send when nothing runs, whatever key or setting", () => {
    for (const alternate of [false, true]) {
      for (const preferred of ["steer", "queue"] as const) {
        expect(resolveFollowUp({ running: false, alternate, preferred, canSteer: true })).toBeNull();
        expect(resolveFollowUp({ running: false, alternate, preferred, canSteer: false })).toBeNull();
      }
    }
  });

  it("does the setting on Enter and the other one with Ctrl/⌘, steering by default", () => {
    expect(resolveFollowUp({ running: true, alternate: false, canSteer: true })).toBe("steer");
    expect(resolveFollowUp({ running: true, alternate: true, canSteer: true })).toBe("queue");
    expect(resolveFollowUp({ running: true, alternate: false, preferred: "steer", canSteer: true })).toBe("steer");
    expect(resolveFollowUp({ running: true, alternate: true, preferred: "steer", canSteer: true })).toBe("queue");
    expect(resolveFollowUp({ running: true, alternate: false, preferred: "queue", canSteer: true })).toBe("queue");
    expect(resolveFollowUp({ running: true, alternate: true, preferred: "queue", canSteer: true })).toBe("steer");
  });

  it("always queues when the running turn cannot take steering", () => {
    for (const alternate of [false, true]) {
      for (const preferred of ["steer", "queue"] as const) {
        expect(resolveFollowUp({ running: true, alternate, preferred, canSteer: false })).toBe("queue");
      }
    }
  });

  it("offers what Enter does first, then the other one where steering works, then restart", () => {
    expect(followUpChoices("steer", true)).toEqual(["steer", "queue", "restart"]);
    expect(followUpChoices("queue", true)).toEqual(["queue", "steer", "restart"]);
    expect(followUpChoices("steer", false)).toEqual(["queue", "restart"]);
    expect(followUpChoices("queue", false)).toEqual(["queue", "restart"]);
  });

  it("reads the wire value: absent, one of the three, or refused", () => {
    expect(parseFollowUp(undefined)).toBeUndefined();
    expect(parseFollowUp(null)).toBeUndefined();
    for (const value of ["steer", "queue", "restart"]) expect(parseFollowUp(value)).toBe(value);
    for (const value of ["auto", "", true, 1, "Queue"]) expect(parseFollowUp(value)).toBeNull();
  });
});
