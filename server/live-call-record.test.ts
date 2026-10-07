import { describe, expect, it, vi } from "vitest";

import type { LiveCallRecord } from "../shared/wire.ts";
import { recordLiveCall, spokenLineFields, type LiveCallRecordDeps } from "./live-call-record.ts";
import type { Message } from "./store.ts";

const record = (extra: Partial<LiveCallRecord> = {}): LiveCallRecord => ({
  callId: "call-1", botId: "bot1", client: "ios", startedAt: 1_000, endedAt: 103_000, seconds: 102, endReason: "hung-up", ...extra,
});

describe("spokenLineFields", () => {
  it("stamps a spoken line with its call, and only a spoken line", () => {
    expect(spokenLineFields("call", "call-1")).toEqual({ via: "call", callId: "call-1" });
    expect(spokenLineFields("call", undefined)).toEqual({ via: "call" });
    expect(spokenLineFields("call", "")).toEqual({ via: "call" });
    expect(spokenLineFields("api", "call-1")).toEqual({});
    expect(spokenLineFields(undefined, "call-1")).toEqual({});
  });
});

describe("recordLiveCall", () => {
  function chat(exists = true) {
    const appended: Message[] = [];
    const deps = {
      chatExists: vi.fn((_botId: string, _threadId: string) => exists),
      appendMessage: vi.fn((_threadId: string, message: Omit<Message, "id" | "at">) => {
        const full: Message = { id: `row${appended.length + 1}`, at: 1, ...message };
        appended.push(full);
        return full;
      }),
    } satisfies LiveCallRecordDeps;
    return { deps, appended };
  }

  it("writes one bot row: the record, and a line clients without the row can show", () => {
    const { deps, appended } = chat();
    const row = recordLiveCall(deps, { threadId: "t1", botName: "Ada", record: record() });
    expect(deps.appendMessage).toHaveBeenCalledWith("t1", { role: "bot", kind: "call", text: "Call with Ada · 1:42", call: record() });
    expect(appended).toEqual([row]);
  });

  it("writes nothing when the call's chat or bot was deleted during the call", () => {
    const { deps, appended } = chat(false);
    expect(recordLiveCall(deps, { threadId: "t1", botName: "Ada", record: record({ endReason: "deleted" }) })).toBeNull();
    expect(deps.chatExists).toHaveBeenCalledWith("bot1", "t1");
    expect(appended).toEqual([]);
  });
});
