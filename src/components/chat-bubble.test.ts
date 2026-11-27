import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@/lib/activity-runs";
import type { Message } from "@/state/store";
import { BOT_BUBBLE_FINISH, joinedCorners, plainBotBubble, SIMPLE_BOT_BUBBLE, SIMPLE_STACKED, SIMPLE_USER_BUBBLE, simpleRowLayout } from "./chat-bubble";

describe("simple row layout around routine messages", () => {
  it("never tucks an automation row under the bot message or card above it and keeps bubble joins broken", () => {
    const base = new Date(2026, 9, 21, 9, 0).getTime();
    const automation = { routineId: "inbox", runId: "run-1", name: "Inbox brief", trigger: "schedule" as const, executionThreadId: "run-thread", scheduledFor: base };
    const botReply: Message = { id: "b1", parentId: null, role: "bot", kind: "text", text: "Previous reply.", at: base + 1_000 };
    const botCard: Message = { id: "c1", parentId: "b1", role: "bot", kind: "options", at: base + 2_000, card: { title: "Question", subtitle: "Pick one", options: ["A"], requestId: "q1", requestType: "question", answered: "A" } };
    const routineAfterReply: Message = { id: "a1", parentId: "b1", role: "bot", kind: "text", text: "Routine reply.", at: base + 3_000, automation };
    const routineAfterCard: Message = { id: "a2", parentId: "c1", role: "bot", kind: "text", text: "Routine after card.", at: base + 4_000, automation };
    const items = (rows: Message[]): TranscriptItem[] => rows.map((message) => ({ kind: "message", id: message.id, message }));

    const afterReply = simpleRowLayout(items([botReply, routineAfterReply]), { botId: "pepper", showToolCalls: false, unreadIds: null });
    expect(afterReply.tucks).toEqual([false, false]);
    expect(afterReply.joins).toEqual([{ above: false, below: false }, { above: false, below: false }]);

    const afterCard = simpleRowLayout(items([botReply, botCard, routineAfterCard]), { botId: "pepper", showToolCalls: false, unreadIds: null });
    expect(afterCard.tucks).toEqual([false, true, false]);
  });
});

describe("a run of one sender's bubbles", () => {
  it("gives each bubble in the run a 6px tail at its bottom corner on its own side, and keeps the top corners round", () => {
    for (const join of [{ above: false, below: true }, { above: true, below: true }, { above: true, below: false }]) {
      expect(joinedCorners("start", join)).toBe("rounded-es-[6px]");
      expect(joinedCorners("end", join)).toBe("rounded-ee-[6px]");
    }
  });

  it("leaves a lone bubble round all over", () => {
    expect(joinedCorners("start", { above: false, below: false })).toBe("");
    expect(joinedCorners("end", { above: false, below: false })).toBe("");
  });

  it("pulls a bubble in the same run up from the 16px between senders to 4px", () => {
    expect(SIMPLE_STACKED).toBe("-mt-3");
  });
});

describe("a bot's bubble finish", () => {
  it("finishes every bot bubble recipe, in both modes, and never the person's own", () => {
    expect(BOT_BUBBLE_FINISH).toBe("bubble-finish");
    expect(SIMPLE_BOT_BUBBLE.split(" ")).toEqual(expect.arrayContaining(["bg-card", BOT_BUBBLE_FINISH]));
    expect(plainBotBubble(true).split(" ")).toContain(BOT_BUBBLE_FINISH);
    expect(plainBotBubble(false).split(" ")).toEqual(expect.arrayContaining(["bg-card", BOT_BUBBLE_FINISH]));
    expect(SIMPLE_USER_BUBBLE.split(" ")).not.toContain(BOT_BUBBLE_FINISH);
  });
});
