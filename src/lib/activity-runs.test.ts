import { describe, expect, it } from "vitest";

import { describeRun, groupActivityRuns, groupTranscript, isRecoveryActivity, isToolStep, roomTurnFolds, statusActivity } from "./activity-runs";
import type { Message } from "@/state/store";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok } });
/** `ok` absent, not `ok: undefined`: a default parameter would turn that back into a finished step. */
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });

describe("a reaction's own line", () => {
  it("draws no bubble in a conversation or a room: the reaction shows on the message it answered", () => {
    const asked = text("Shall I send it?");
    const reaction: Message = { id: `u${++seq}`, at: seq, role: "user", kind: "text", text: "👍", replyToId: asked.id, reaction: "👍" };
    const typed: Message = { id: `u${++seq}`, at: seq, role: "user", kind: "text", text: "👍", replyToId: asked.id };
    for (const items of [groupTranscript([asked, reaction, typed]), groupActivityRuns([asked, reaction, typed])]) {
      expect(items.map((item) => item.kind === "message" ? item.message.id : item.id)).toEqual([asked.id, typed.id]);
    }
  });
});

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

  it("never folds an opened-thread chip into a run — it is navigation, not work", () => {
    const opened: Message = { ...tool("Opened thread #QA PR 245 on Scout"),
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" } };
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), opened, tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("never folds a bot-to-bot chip into a run — it links to the other conversation", () => {
    const messaged: Message = { ...tool("Messaged @Ada"),
      comm: { groupId: "g1", withBotId: "ada", withName: "Ada", withColor: "blue" } };
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), messaged, tool("Write"), tool("Write")]);
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

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("keeps recovery visible between successful tool runs", () => {
    const recovery = tool("recovery: Automatic recovery: trying a backup once.");
    const messages = [tool("Read"), tool("Edit"), recovery, tool("Bash"), tool("Write")];
    expect(isRecoveryActivity(recovery)).toBe(true);
    expect(isRecoveryActivity(text("recovery: ordinary text"))).toBe(false);
    for (const group of [groupActivityRuns, groupTranscript]) {
      const items = group(messages);
      expect(items.map(item => item.kind)).toEqual(["run", "message", "run"]);
      expect(items[1]).toEqual({ kind: "message", message: recovery });
    }
  });

  it("keeps a stopped turn visible between successful tool runs", () => {
    const stopped = tool("stopped: Stopped");
    const messages = [tool("Read"), tool("Edit"), stopped, tool("Bash"), tool("Write")];
    expect(statusActivity(stopped)).toEqual({ kind: "stopped", text: "Stopped" });
    for (const group of [groupActivityRuns, groupTranscript]) {
      const items = group(messages);
      expect(items.map(item => item.kind)).toEqual(["run", "message", "run"]);
      expect(items[1]).toEqual({ kind: "message", message: stopped });
    }
  });

  it("keeps a model notice visible between successful tool runs", () => {
    const notice = tool("notice: OpenCode no longer offers opencode/x, so this conversation uses opencode/big-pickle.");
    const messages = [tool("Read"), tool("Edit"), notice, tool("Bash"), tool("Write")];
    expect(statusActivity(notice)).toEqual({
      kind: "notice", text: "OpenCode no longer offers opencode/x, so this conversation uses opencode/big-pickle.",
    });
    expect(isRecoveryActivity(notice)).toBe(false);
    expect(statusActivity(text("notice: ordinary text"))).toBeNull();
    for (const group of [groupActivityRuns, groupTranscript]) {
      const items = group(messages);
      expect(items.map(item => item.kind)).toEqual(["run", "message", "run"]);
      expect(items[1]).toEqual({ kind: "message", message: notice });
    }
  });

  it("keeps ordinary failed tools visible between successful runs", () => {
    const items = groupActivityRuns([
      tool("Read"),
      tool("Edit"),
      tool("Bash", false),
      tool("Write"),
      tool("Write"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
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

describe("isToolStep", () => {
  const opened: Message = { ...tool("Opened thread #QA PR 245 on Scout"),
    threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" } };
  const messaged: Message = { ...tool("Messaged @Ada"),
    comm: { groupId: "g1", withBotId: "ada", withName: "Ada", withColor: "blue" } };

  it("is true for a tool the bot ran, whether it is running, finished or failed", () => {
    const steps = [tool("Edit"), running("Bash"), tool("Bash", false)];
    expect(steps.filter((step) => isToolStep(step))).toEqual(steps);
    const step = tool("Edit");
    expect(isToolStep(step) && step.tool.name).toBe("Edit");
  });

  it("is false for what is not work: chips that link elsewhere, status rows and a failed turn", () => {
    const rows = [
      opened,
      messaged,
      tool("notice: the engine runs another model"),
      tool("recovery: Automatic recovery: trying a backup once."),
      tool("error: the CLI exited"),
    ];
    expect(rows.filter((row) => isToolStep(row))).toEqual([]);
  });

  it("does not ask for a provider item id: the chat still folds the harness's own chips", () => {
    const receipt = tool("approved Bash (full access): pnpm test");
    expect(receipt.tool).not.toHaveProperty("itemId");
    expect(isToolStep(receipt)).toBe(true);
    const items = groupActivityRuns([tool("Edit"), receipt, tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run"]);
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(3);
  });

  it("is false for anything that is not an activity row with a tool", () => {
    const noTool: Message = { id: "n1", at: 1, role: "bot", kind: "activity" };
    const notActivity: Message = { ...tool("Edit"), kind: "text" };
    expect([text("hi"), noTool, notActivity].filter((row) => isToolStep(row))).toEqual([]);
  });
});

describe("describeRun", () => {
  it("counts repeats and names the tools in order of first use", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("4 steps · Edit ×3, Bash");
  });

  it("names a single repeat without a multiplier", () => {
    expect(describeRun([tool("Edit"), tool("Bash")])).toBe("2 steps · Edit, Bash");
  });

  it("trims a long tail of tool names rather than running off the row", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Write"), tool("Grep"), tool("Read")])).toBe(
      "5 steps · Edit, Bash, Write +2 more",
    );
  });

  it("names steps by the label it is given, counting steps that read the same together", () => {
    const plain = ({ name }: { name: string }) => (name === "Bash" || name.includes(" ") ? "Run a command" : name);
    expect(describeRun([tool("Bash"), tool("ls -la"), tool("Edit")], plain)).toBe("3 steps · Run a command ×2, Edit");
  });
});

describe("groupTranscript", () => {
  const assistant = (
    body: string,
    turnId: string,
    turnTerminal = false,
    at = ++seq * 1_000,
  ): Message => ({
    id: `m${++seq}`,
    at,
    role: "bot",
    kind: "text",
    text: body,
    turnId,
    turnTerminal,
  });

  const step = (name: string, turnId: string, at = ++seq * 1_000): Message =>
    ({ id: `t${++seq}`, at, role: "bot", kind: "activity", tool: { name, ok: true }, turnId });

  it("keeps the bot's progress lines above the answer and folds only the settled turn's tool steps", () => {
    const user: Message = { id: "u1", at: 1_000, role: "user", kind: "text", text: "compare note-takers" };
    const ack = assistant("I'll check current pricing since this changes often.", "turn-1", false, 2_000);
    const search = step("WebSearch", "turn-1", 2_500);
    const read = step("WebFetch", "turn-1", 3_000);
    const helper = assistant("I'll spin up a research specialist for the details.", "turn-1", false, 3_500);
    const fetch = step("WebFetch", "turn-1", 4_000);
    const final = assistant("Here are the three best.", "turn-1", true, 30_000);

    const items = groupTranscript([user, ack, search, read, helper, fetch, final]);
    expect(items.map((item) => item.kind === "message" ? item.message.id : item.kind)).toEqual([user.id, ack.id, "turn", helper.id, final.id]);
    expect(items[2]).toMatchObject({ kind: "turn", id: "turn:turn-1", label: "Worked for 29s", messages: [search, read, fetch] });
  });

  it("shows just the answer for a turn with nothing to say: its steps fold, no line of it is hidden", () => {
    const user: Message = { id: "u2", at: 1_000, role: "user", kind: "text", text: "what time is it in Tokyo?" };
    const lookup = step("Bash", "turn-2", 1_500);
    const final = assistant("It's 9:30 PM in Tokyo.", "turn-2", true, 5_000);
    const items = groupTranscript([user, lookup, final]);
    expect(items.map((item) => item.kind)).toEqual(["message", "turn", "message"]);
    expect(items.flatMap((item) => item.kind === "message" ? [item.message.text] : [])).toEqual([user.text, final.text]);
    expect(groupTranscript([user, final]).map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("leaves a failed step and other rows that are not work where they were", () => {
    const failed: Message = { ...step("Bash", "turn-3"), tool: { name: "Bash", ok: false } };
    const ok = step("Read", "turn-3");
    const final = assistant("Done.", "turn-3", true);
    const items = groupTranscript([ok, failed, final]);
    expect(items.map((item) => item.kind === "message" ? item.message.id : item.kind)).toEqual(["turn", failed.id, final.id]);
  });

  it("folds a room member's working notes, so a room still reads as answers", () => {
    const first = assistant("I'm checking connected apps.", "turn-r", false, 2_000);
    const final = assistant("You have three tasks.", "turn-r", true, 5_000);
    const { byTerminalId, hiddenIds } = roomTurnFolds([first, final]);
    expect([...hiddenIds]).toEqual([first.id]);
    expect(byTerminalId.get(final.id)).toMatchObject({ messages: [first] });
  });

  it("keeps every message visible until the turn settles", () => {
    const first = assistant("Checking.", "turn-live");
    const second = assistant("Still checking.", "turn-live");
    expect(groupTranscript([first, second]).map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("keeps a lone terminal message as the answer", () => {
    const only = assistant("I could not finish, but here is what I found.", "turn-short", true);
    expect(groupTranscript([only])).toEqual([{ kind: "message", message: only }]);
  });

  it("does not fold steps from a different turn", () => {
    const older = step("Read", "turn-old");
    const progress = step("Edit", "turn-new");
    const final = assistant("Done.", "turn-new", true);
    expect(groupTranscript([older, progress, final]).map((item) => item.kind === "turn" ? item.messages.map((m) => m.id) : item.kind)).toEqual([
      "message",
      [progress.id],
      "message",
    ]);
  });
});
