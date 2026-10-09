import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import {
  announcerBaseline,
  latestFailure,
  latestReply,
  nextAnnouncement,
  replySummary,
  type TranscriptSnapshot,
} from "./transcript-announcer";

const text = (id: string, role: Message["role"], body: string, from?: string): Message => ({
  id,
  role,
  kind: "text",
  at: 1,
  text: body,
  ...(from ? { from: { botId: from.toLowerCase(), name: from, color: "green" as const } } : {}),
});

// Play a sequence of transcript states through the announcer the way the
// hook does, and collect what a screen reader would hear.
function play(states: TranscriptSnapshot[]): string[] {
  let memory = announcerBaseline(states[0]!);
  const heard: string[] = [];
  for (const state of states.slice(1)) {
    const next = nextAnnouncement(state, memory);
    memory = next.memory;
    if (next.text) heard.push(next.text);
  }
  return heard;
}

describe("nextAnnouncement", () => {
  const reply = (id: string, words = "Here is the plan. Step one is easy.") => ({ id, name: "Pepper", text: words });

  it("says nothing while the bot works, then announces the finished reply once", () => {
    const heard = play([
      { busy: false, reply: reply("old") },
      { busy: true, reply: reply("old") },
      // an in-between reply while tools still run stays quiet
      { busy: true, reply: reply("mid", "Looking now.") },
      { busy: true, reply: reply("mid", "Looking now.") },
      { busy: false, reply: reply("new") },
      // re-renders after the turn add nothing
      { busy: false, reply: reply("new") },
      { busy: false, reply: reply("new") },
    ]);
    expect(heard).toEqual(["Pepper replied: Here is the plan."]);
  });

  it("does not read history aloud when a thread opens or older messages load", () => {
    expect(play([
      { busy: false },
      { busy: false, reply: reply("history") },
      { busy: false, reply: reply("older") },
    ])).toEqual([]);
  });

  it("announces a reply that finishes after the thread was opened mid-turn", () => {
    expect(play([
      { busy: true, reply: reply("old") },
      { busy: false, reply: reply("new") },
    ])).toEqual(["Pepper replied: Here is the plan."]);
  });

  it("stays quiet when a turn ends without a new reply", () => {
    expect(play([
      { busy: false, reply: reply("old") },
      { busy: true, reply: reply("old") },
      { busy: false, reply: reply("old") },
    ])).toEqual([]);
  });

  it("announces a new approval once, even though the bot is still busy", () => {
    const approval = { id: "ask-1", name: "Pepper" };
    expect(play([
      { busy: true },
      { busy: true, approval },
      { busy: true, approval },
      { busy: true },
      { busy: true, approval: { id: "ask-2", name: "Pepper" } },
    ])).toEqual(["Pepper needs your approval", "Pepper needs your approval"]);
  });

  it("does not announce an approval that was already open when the thread opened", () => {
    const approval = { id: "ask-1", name: "Pepper" };
    expect(play([{ busy: true, approval }, { busy: true, approval }])).toEqual([]);
  });

  it("announces a failed turn once, and stays quiet when the person stopped it", () => {
    expect(play([
      { busy: false },
      { busy: true },
      { busy: false, failure: { id: "f1", name: "Pepper", cause: "The model timed out." } },
      { busy: false, failure: { id: "f1", name: "Pepper", cause: "The model timed out." } },
    ])).toEqual(["Pepper failed: The model timed out."]);

    expect(play([
      { busy: false },
      { busy: true },
      {
        busy: false,
        reply: { id: "c", name: "Pepper", text: "The request was cancelled by the client." },
        failure: { id: "f2", name: "Pepper", cause: "The request was cancelled by the client." },
      },
    ])).toEqual([]);
  });

  it("prefers a finished reply over an older failure", () => {
    expect(play([
      { busy: false, failure: { id: "old", name: "Pepper", cause: "Earlier." } },
      { busy: true, failure: { id: "old", name: "Pepper", cause: "Earlier." } },
      { busy: false, reply: reply("new"), failure: { id: "old", name: "Pepper", cause: "Earlier." } },
    ])).toEqual(["Pepper replied: Here is the plan."]);
  });
});

describe("latestReply", () => {
  it("picks the newest bot text and names its speaker", () => {
    const messages = [text("a", "bot", "First."), text("b", "user", "hi"), text("c", "bot", "Second.", "Eli")];
    expect(latestReply(messages, (m) => m.from?.name ?? "Pepper")).toEqual({ id: "c", name: "Eli", text: "Second." });
  });

  it("skips a client-abort sentence and reads the reply before it", () => {
    const messages = [
      text("a", "bot", "Here is the plan."),
      text("b", "bot", "The request was cancelled by the client."),
    ];
    expect(latestReply(messages, () => "Pepper")?.id).toBe("a");
  });

  it("skips activity rows and empty text", () => {
    const messages: Message[] = [
      text("a", "bot", "Answer."),
      { id: "tool", role: "bot", kind: "activity", at: 2, tool: { name: "Bash", ok: true } },
      text("blank", "bot", "   "),
    ];
    expect(latestReply(messages, () => "Pepper")?.id).toBe("a");
    expect(latestReply([], () => "Pepper")).toBeUndefined();
  });
});

describe("latestFailure", () => {
  it("reads the newest error row and skips a stop stored under another name", () => {
    const messages: Message[] = [
      text("a", "bot", "Earlier."),
      { id: "fail", role: "bot", kind: "activity", at: 2, tool: { name: "error: The model timed out.", ok: false } },
      { id: "stop", role: "bot", kind: "activity", at: 3, tool: { name: "stopped: Stopped", ok: false } },
    ];
    expect(latestFailure(messages, () => "Pepper")).toEqual({ id: "fail", name: "Pepper", cause: "The model timed out." });
  });
});

describe("replySummary", () => {
  it("keeps only the first sentence, without markdown", () => {
    expect(replySummary("**Done.** I updated `README.md` and ran the tests.")).toBe("Done.");
    expect(replySummary("## Summary\n\nSee [the docs](https://x.test) for more. Then rest.")).toBe("Summary See the docs for more.");
    expect(replySummary("تم الأمر؟ ثم تفاصيل")).toBe("تم الأمر؟");
    expect(replySummary("完了。次はテストです。")).toBe("完了。");
    expect(replySummary("结束！后面还有。")).toBe("结束！");
  });

  it("drops code blocks and caps a long first sentence at a word", () => {
    expect(replySummary("```sh\nls -la\n```\nAll files are listed")).toBe("All files are listed");
    const long = replySummary(`${"word ".repeat(60)}end.`);
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/wor…$/);
  });

  it("is empty for a reply with nothing speakable", () => {
    expect(replySummary("```\ncode\n```")).toBe("");
  });

  it("falls back to the plain phrase when the reply has nothing speakable", () => {
    const heard = play([
      { busy: true },
      { busy: false, reply: { id: "r", name: "Pepper", text: "```\ncode\n```" } },
    ]);
    expect(heard).toEqual(["Pepper replied"]);
  });
});
