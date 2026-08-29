import { describe, expect, it } from "vitest";

import { describeRun, groupActivityRuns } from "./activity-runs";
import type { Message } from "@/state/store";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok } });
/** a step with no verdict yet — `ok` absent, not `ok: undefined`, which a
 * default parameter would quietly turn back into a finished step */
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });

describe("groupActivityRuns", () => {
  it("folds consecutive tool steps into one run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), tool("Edit")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(3);
  });

  it("keeps text between runs, so a run never swallows what the bot said", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), text("Now the sitemap:"), tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("leaves a lone tool step as an ordinary message", () => {
    const items = groupActivityRuns([text("hi"), tool("Edit"), text("done")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
  });

  it("keeps a step that is still running out of the run, so live progress stays visible", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), running("Bash")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe("Bash");
  });

  it("hides internal repeated-call diagnostics from both runs and standalone rows", () => {
    const loopWarning = tool("Same call repeated 5× — Read File: notes.md — it may be stuck", false);
    const items = groupActivityRuns([tool("Grep"), loopWarning, tool("Read File"), text("Finished")]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(["run", "message"]);
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(2);
    expect(
      items.some((item) => item.kind === "message" && item.message.id === loopWarning.id),
    ).toBe(false);
  });

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("gives a run a stable id taken from its first step", () => {
    const steps = [tool("Edit"), tool("Edit")];
    const items = groupActivityRuns(steps);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
  });

  it("does not attribute consecutive room steps from different bots to one sender", () => {
    const roomTool = (name: string, botId: string): Message => ({
      ...tool(name),
      from: { botId, name: botId, color: "blue" },
    });

    expect(
      groupActivityRuns([
        roomTool("Read", "alice"),
        roomTool("Edit", "alice"),
        roomTool("Write", "bob"),
        roomTool("Bash", "bob"),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });

  it("keeps local calendar-day boundaries between activity runs", () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 1).getTime();
    const stepAt = (name: string, at: number): Message => ({ ...tool(name), at });

    expect(
      groupActivityRuns([
        stepAt("Read", beforeMidnight),
        stepAt("Edit", beforeMidnight),
        stepAt("Write", afterMidnight),
        stepAt("Bash", afterMidnight),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });
});

describe("describeRun", () => {
  it("summarizes a long failed run without leaking command text into a giant pill", () => {
    const messages = Array.from({ length: 28 }, (_, index) =>
      tool(
        `C:\\runtime\\pwsh.exe -Command "rg -n pendingPrompts queuedMessages ${index}"`,
        index >= 4,
      ),
    );

    expect(describeRun(messages)).toBe("28 actions · 24 completed · 4 failed");
    expect(describeRun(messages)).not.toContain("pwsh.exe");
  });

  it("summarizes a completed run without exposing its commands", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("4 actions completed");
  });

  it("summarizes active work by outcome", () => {
    expect(describeRun([tool("Edit"), running("Bash")])).toBe("2 actions · 1 completed · 1 running");
  });

  it("says how many steps failed, because that is the reason to open it", () => {
    expect(describeRun([tool("Edit"), tool("Bash", false)])).toBe("2 actions · 1 completed · 1 failed");
  });
});
