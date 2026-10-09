// What a server knows of its person's plan: the desktop app's answer (at
// spawn, then over its private port), OMB_PRO_PLAN on a server it did not
// start, and a Cloud home, which always counts. The rule itself is
// electron/pro-plan.mjs's table (electron/pro-plan.node-test.mjs).
import { describe, expect, it } from "vitest";
import { PRO_PLAN_MESSAGE, proPlanEnvironment, proPlanMessage } from "../electron/pro-plan.mjs";
import { ProPlan } from "./pro-plan.ts";

describe("ProPlan", () => {
  it("is Pro on a server the desktop app did not start only with OMB_PRO_PLAN=1", () => {
    expect(new ProPlan({ cloudHome: false, env: {} }).liveCallsAllowed()).toBe(false);
    expect(new ProPlan({ cloudHome: false, env: { OMB_PRO_PLAN: "1" } }).liveCallsAllowed()).toBe(true);
    expect(new ProPlan({ cloudHome: false, env: { OMB_PRO_PLAN: "true" } }).liveCallsAllowed()).toBe(false);
  });

  it("starts with the answer the desktop app spawned it with, and takes each change after", () => {
    const logs: string[] = [];
    const plan = new ProPlan({ cloudHome: false, env: proPlanEnvironment(false), log: (line) => logs.push(line) });
    expect(plan.liveCallsAllowed()).toBe(false);
    expect(plan.receive(proPlanMessage(true))).toBe(true);
    expect(plan.liveCallsAllowed()).toBe(true);
    // the same answer again is not news
    expect(plan.receive(proPlanMessage(true))).toBe(true);
    expect(plan.receive(proPlanMessage(false))).toBe(true);
    expect(plan.liveCallsAllowed()).toBe(false);
    expect(logs).toEqual(["[pro-plan] the desktop app says Pro", "[pro-plan] the desktop app says not Pro"]);
  });

  it("lets other private messages pass, and refuses a malformed one without changing the answer", () => {
    const plan = new ProPlan({ cloudHome: false, env: proPlanEnvironment(true), log: () => {} });
    expect(plan.receive({ type: "openmausbot:managed-composio", access: null })).toBe(false);
    expect(plan.receive(undefined)).toBe(false);
    expect(() => plan.receive({ type: PRO_PLAN_MESSAGE, pro: "no" })).toThrow(/Pro plan/);
    expect(plan.liveCallsAllowed()).toBe(true);
  });

  it("always counts a Cloud home as Pro", () => {
    const plan = new ProPlan({ cloudHome: true, env: {}, log: () => {} });
    expect(plan.liveCallsAllowed()).toBe(true);
    plan.receive(proPlanMessage(false));
    expect(plan.liveCallsAllowed()).toBe(true);
  });
});
