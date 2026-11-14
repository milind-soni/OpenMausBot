import { describe, expect, it } from "vitest";

import type { ModelSelection } from "../../shared/wire.ts";
import type { HandoffView, HostTurnResult } from "../coordinator.ts";
import { createHandoffLimits } from "./handoff-limits.ts";

const claude: ModelSelection = { instanceId: "claude", model: "claude-opus" };

function world(options: { carries?: boolean; enabled?: boolean; ran?: ModelSelection } = {}) {
  const calls: string[] = [];
  const limits = createHandoffLimits({
    store: {
      projectBotForTask: () => ({ modelSelection: options.ran ?? claude }) as never,
      bot: () => ({ modelSelection: claude }) as never,
    },
    limitClock: { noteLimit: (engine, resetsAt) => { calls.push(`limit ${engine} ${resetsAt}`); } },
    takeover: {
      noteSignedOut: (engine) => { calls.push(`signed-out ${engine}`); },
      holdModel: (selection, scope, resetsAt) => { calls.push(`${scope} ${selection.model} ${resetsAt}`); },
      heldAtStart: () => (options.carries === false ? null : { scope: "engine" }),
    },
    enabled: () => options.enabled ?? true,
    engineName: (engine) => (engine === "codex" ? "Codex" : engine),
  });
  return { limits, calls };
}

const job = { botId: "lead", threadId: "lead-job", parentId: "chief-turn" } as HandoffView;
const refused = (refusedBy: HostTurnResult["refusedBy"], okToolCalls = 0): HostTurnResult =>
  ({ ok: false, text: "This Claude account has reached its usage limit", refusedBy, evidence: { okToolCalls, toolCalls: 1 } as never });

describe("a hand-off job its AI's limit refused", () => {
  it("holds the refusal and runs again with a note to carry on, with no no-progress strike", () => {
    const { limits, calls } = world();
    const carried = limits.carriedOn(job, refused({ scope: "engine", resetsAt: 9 }));
    expect(calls).toEqual(["limit claude 9"]);
    expect(carried?.cap?.note).toMatch(/another AI carries this request on now/);
    expect(carried?.evidence).not.toHaveProperty("okToolCalls");
    expect(limits.carriedOn(job, refused({ scope: "model" }, 2))?.evidence?.okToolCalls).toBe(2);
    expect(limits.carriedOn(job, refused({ scope: "signed-out" }))).toBeDefined();
    expect(calls.slice(1)).toEqual(["model claude-opus undefined", "signed-out claude"]);
  });

  it("fails as before when no AI can carry it on, when failover is off, or when it is not a teammate's own job", () => {
    const stuck = world({ carries: false });
    expect(stuck.limits.carriedOn(job, refused({ scope: "engine" }))).toBeUndefined();
    expect(stuck.calls).toEqual(["limit claude undefined"]);
    const off = world({ enabled: false });
    expect(off.limits.carriedOn(job, refused({ scope: "engine" }))).toBeUndefined();
    expect(off.limits.carriedOn({ ...job, groupId: "room" }, refused({ scope: "engine" }))).toBeUndefined();
    const { limits, calls } = world();
    expect(limits.carriedOn({ ...job, parentId: undefined }, refused({ scope: "engine" }))).toBeUndefined();
    expect(limits.carriedOn(job, { ok: false, text: "crashed" })).toBeUndefined();
    expect([...off.calls, ...calls]).toEqual([]);
  });
});

describe("the AI a job ran on", () => {
  it("is named only when it is not the teammate's own", () => {
    expect(world().limits.servedBy(job)).toEqual({});
    expect(world({ ran: { instanceId: "codex", model: "gpt-5" } }).limits.servedBy(job)).toEqual({ servedBy: "Codex gpt-5" });
    expect(world({ ran: { ...claude, model: "claude-sonnet" } }).limits.servedBy(job)).toEqual({ servedBy: "claude claude-sonnet" });
  });
});
