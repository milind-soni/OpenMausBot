import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { LiveCallRecord } from "../shared/wire.ts";
import { recordLiveCall, spokenLineFields, titleLiveCall, type LiveCallRecordDeps, type LiveCallTitleDeps } from "./live-call-record.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";
import { callTitleExcerpt } from "./thread-title.ts";

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

describe("titleLiveCall", () => {
  const spoken = (id: string, text: string, callId: string): Message => ({ id, role: "user", kind: "text", text, via: "call", callId, at: 1 });
  const callRow = (extra: Partial<LiveCallRecord> = {}): Message => ({ id: "row", role: "bot", kind: "call", text: "Call with Ada · 1:42", call: record(extra), at: 2 });
  /** A chat holding `messages` (the row last), whose title one-shot behaves as `title` does. The
   * excerpt and the scrub are the real ones: the harness hands exactly these in. */
  function chat(messages: Message[], title: LiveCallTitleDeps["title"]) {
    return {
      messagesFor: () => messages,
      patchMessage: vi.fn((_threadId: string, id: string, patch: Partial<Message>) => {
        const index = messages.findIndex((message) => message.id === id);
        if (index === -1) return null;
        messages[index] = { ...messages[index]!, ...patch };
        return messages[index]!;
      }),
      excerpt: callTitleExcerpt,
      title: vi.fn(title),
      scrub: redactSecretsInText,
    } satisfies LiveCallTitleDeps;
  }

  it("names the row from this call's spoken requests only, oldest first", async () => {
    const row = callRow();
    const messages: Message[] = [
      spoken("m0", "words from an earlier call", "call-0"),
      spoken("m1", "what is the weather in Pune", "call-1"),
      { id: "b1", role: "bot", kind: "text", text: "Sunny, 31 degrees.", requestMessageId: "m1", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "typed during the call", at: 1 },
      spoken("m3", "and tomorrow?", "call-1"),
      row,
    ];
    const deps = chat(messages, async () => "Pune weather check");
    await titleLiveCall(deps, { threadId: "t1", row });
    expect(deps.title).toHaveBeenCalledWith("bot1", "t1", "what is the weather in Pune\nand tomorrow?");
    expect(deps.patchMessage).toHaveBeenCalledWith("t1", "row", { call: { ...record(), title: "Pune weather check" } });
    expect(messages.at(-1)?.call?.title).toBe("Pune weather check");
  });

  it("changes nothing when titles are off or the engine cannot make one", async () => {
    const row = callRow();
    const deps = chat([spoken("m1", "what is the weather", "call-1"), row], () => null);
    await titleLiveCall(deps, { threadId: "t1", row });
    expect(deps.title).toHaveBeenCalledTimes(1);
    expect(deps.patchMessage).not.toHaveBeenCalled();
  });

  it("keeps the row untitled when the one-shot fails", async () => {
    const row = callRow();
    const deps = chat([spoken("m1", "what is the weather", "call-1"), row], () => Promise.reject(new Error("timed out")));
    await expect(titleLiveCall(deps, { threadId: "t1", row })).resolves.toBeUndefined();
    expect(deps.patchMessage).not.toHaveBeenCalled();
  });

  it("keeps the row untitled when the one-shot answers nothing usable", async () => {
    const row = callRow();
    const deps = chat([spoken("m1", "what is the weather", "call-1"), row], () => Promise.resolve(null));
    await titleLiveCall(deps, { threadId: "t1", row });
    expect(deps.patchMessage).not.toHaveBeenCalled();
  });

  it("never rejects, whichever part fails: the one-shot, reading the chat or writing the patch", async () => {
    const row = callRow();
    const boom = () => { throw new Error("boom"); };
    const asked = [spoken("m1", "what is the weather", "call-1"), row];
    // the one-shot throws instead of returning a promise
    await expect(titleLiveCall(chat(asked, boom), { threadId: "t1", row })).resolves.toBeUndefined();
    // the chat cannot be read
    const unreadable = { ...chat(asked, async () => "Weather"), messagesFor: boom };
    await expect(titleLiveCall(unreadable, { threadId: "t1", row })).resolves.toBeUndefined();
    // the patch cannot be written
    const unwritable = { ...chat(asked, async () => "Weather"), patchMessage: vi.fn(boom) };
    await expect(titleLiveCall(unwritable, { threadId: "t1", row })).resolves.toBeUndefined();
    expect(unwritable.patchMessage).toHaveBeenCalledTimes(1);
  });

  it("scrubs a secret-shaped title before it is saved", async () => {
    const key = "sk-ant-" + "e".repeat(90);
    const row = callRow();
    const messages = [spoken("m1", "deploy the site", "call-1"), row];
    const deps = chat(messages, async () => `Deploy with ${key}`);
    await titleLiveCall(deps, { threadId: "t1", row });
    expect(messages.at(-1)?.call?.title).toBeDefined();
    expect(messages.at(-1)?.call?.title).not.toContain(key);
  });

  it("starts no title on a shutdown, or for a call where nothing was asked", async () => {
    const shutdown = callRow({ endReason: "shutdown" });
    const exiting = chat([spoken("m1", "what is the weather", "call-1"), shutdown], async () => "Weather");
    await titleLiveCall(exiting, { threadId: "t1", row: shutdown });
    expect(exiting.title).not.toHaveBeenCalled();
    const quiet = callRow();
    const silent = chat([quiet], async () => "Weather");
    await titleLiveCall(silent, { threadId: "t1", row: quiet });
    expect(silent.title).not.toHaveBeenCalled();
  });

  it("leaves a row alone that is gone by the time its title arrives", async () => {
    const row = callRow();
    const messages = [spoken("m1", "what is the weather", "call-1"), row];
    const deps = chat(messages, async () => {
      messages.pop(); // the row was removed while the one-shot ran
      return "Weather";
    });
    await titleLiveCall(deps, { threadId: "t1", row });
    expect(deps.patchMessage).not.toHaveBeenCalled();
  });
});

describe("live-call-record.ts", () => {
  // server/steer-queue.ts imports this module at runtime: the store, the
  // title machinery and the harness reach it only through injected deps.
  it("imports nothing but a pure shared leaf at runtime", () => {
    const source = readFileSync(new URL("./live-call-record.ts", import.meta.url), "utf8");
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)(?:[^;"]*?\sfrom\s+)?"([^"]+)"/gm)].map((match) => match[1]);
    expect(runtimeImports).toEqual(["../shared/live-call.ts"]);
  });
});
