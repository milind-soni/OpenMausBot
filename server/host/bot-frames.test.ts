import { describe, expect, it } from "vitest";

import { createBotFrames, takesFrame, type BotFrameForm } from "./bot-frames.ts";

interface Bot { id: string; tasks?: Array<{ threadId: string; title: string }> }

function rig(wholeListeners: boolean) {
  const sent: Array<{ payload: Record<string, unknown>; frames?: BotFrameForm }> = [];
  const wired: Array<string | undefined> = [];
  const state = { wholeListeners, seq: 0 };
  const frames = createBotFrames<Bot>({
    broadcast: (payload, options) => { state.seq += 1; sent.push({ payload, ...(options ? { frames: options.frames } : {}) }); },
    wire: (bot, onlyThreadId) => {
      wired.push(onlyThreadId);
      return { id: bot.id, name: "Maus", tasks: (bot.tasks ?? []).filter((task) => onlyThreadId === undefined || task.threadId === onlyThreadId) };
    },
    wholeListeners: () => state.wholeListeners,
    lastSeq: () => state.seq,
  });
  return { frames, sent, wired, state };
}

const bot: Bot = { id: "b1", tasks: [{ threadId: "t1", title: "One" }, { threadId: "t2", title: "Two" }, { threadId: "t3", title: "Three" }] };

describe("bot frames", () => {
  it("sends one thread's change as the bot with that thread alone, and builds no whole bot when nobody takes one", () => {
    const { frames, sent, wired } = rig(false);
    frames.send(bot, "t2");
    expect(sent).toEqual([{ frames: "thread", payload: { kind: "bot", tasksPartial: true, bot: { id: "b1", name: "Maus", tasks: [{ threadId: "t2", title: "Two" }] } } }]);
    expect(wired).toEqual(["t2"]);
  });

  it("also sends the whole bot, unmarked, while a stream that takes only whole frames is open", () => {
    const { frames, sent } = rig(true);
    frames.send(bot, "t2", { messages: [] });
    expect(sent.map((frame) => frame.frames)).toEqual(["thread", "whole"]);
    expect(sent[0]!.payload).toMatchObject({ tasksPartial: true, bot: { messages: [] } });
    expect(sent[1]!.payload).toEqual({ kind: "bot", bot: { id: "b1", name: "Maus", tasks: bot.tasks, messages: [] } });
  });

  it("sends the whole bot to every stream when the change names no thread, or one the bot does not have", () => {
    const { frames, sent } = rig(false);
    frames.send(bot);
    frames.send(bot, "gone");
    frames.send({ id: "b2" }, "t1");
    expect(sent.map((frame) => frame.frames)).toEqual([undefined, undefined, undefined]);
    expect(sent.every((frame) => !("tasksPartial" in frame.payload))).toBe(true);
    expect((sent[0]!.payload.bot as Bot).tasks).toHaveLength(3);
  });

  it("gives each stream exactly one form of a thread's change", () => {
    for (const form of ["thread", "whole"] as const) {
      expect(takesFrame(true, form)).toBe(form === "thread");
      expect(takesFrame(false, form)).toBe(form === "whole");
    }
    expect(takesFrame(true, undefined)).toBe(true);
    expect(takesFrame(false, undefined)).toBe(true);
  });

  it("does not let a whole-frame stream resume across a whole frame that was never built", () => {
    const { frames, state } = rig(true);
    frames.send(bot, "t1");
    expect(frames.resumable(0, false)).toBe(true);
    state.wholeListeners = false;
    frames.send(bot, "t1");
    const skippedAt = state.seq;
    expect(frames.resumable(skippedAt - 1, false)).toBe(false);
    expect(frames.resumable(skippedAt, false)).toBe(true);
    expect(frames.resumable(0, true)).toBe(true);
  });
});
