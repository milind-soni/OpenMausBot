import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "./store.ts";

let home: string;
let mdb: typeof import("./message-db.ts");
let roomThreadSummaries: typeof import("./message-db-thread-summaries.ts").roomThreadSummaries;
let at = 1_000;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-thread-summaries-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OMB_DATA_DIR", join(home, "data"));
  mdb = await import("./message-db.ts");
  ({ roomThreadSummaries } = await import("./message-db-thread-summaries.ts"));
});

afterEach(() => {
  mdb.closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

let next = 0;
function add(threadId: string, message: Partial<Message> & Pick<Message, "role" | "kind">): Message {
  at += 1_000;
  const full = { id: `m${++next}`, at, ...message } as Message;
  mdb.appendMessage(threadId, full);
  return full;
}
const person = (text: string, extra: Partial<Message> = {}) => ({ role: "user" as const, kind: "text" as const, text, ...extra });
const answer = (botId: string, text: string, extra: Partial<Message> = {}) =>
  ({ role: "bot" as const, kind: "text" as const, text, from: { botId, name: botId, color: "blue" }, turnId: `t${next}`, turnTerminal: true, ...extra });

describe("room thread summaries", () => {
  it("reads each thread's first line, its reply count, its last reply and who replied", () => {
    const first = add("a", person("Plan the launch", { sender: { id: "ana@example.com", name: "Ana" } }));
    add("a", answer("kiwi", "On it"));
    add("a", { role: "bot", kind: "text", text: "thinking out loud", from: { botId: "kiwi", name: "Kiwi", color: "blue" }, turnId: "t-mid" });
    add("a", { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } } as Partial<Message> & Pick<Message, "role" | "kind">);
    add("a", person("asked for Ana", { peerAsk: { botId: "kiwi", name: "Kiwi" } }));
    add("a", person("[peer context]", { aside: true }));
    add("a", answer("pip", "Here is the plan"));
    add("a", person("Thanks", { sender: { id: "ana@example.com", name: "Ana" } }));
    const last = add("a", answer("kiwi", "Done"));

    const [summary] = roomThreadSummaries(["a"]);
    expect(summary).toEqual({
      threadId: "a",
      first: { text: "Plan the launch", speaker: { person: { id: "ana@example.com", name: "Ana" } }, at: first.at },
      replies: 4,
      lastReplyAt: last.at,
      repliers: [{ botId: "kiwi" }, { person: { id: "ana@example.com", name: "Ana" } }, { botId: "pip" }],
    });
  });

  it("keeps the threads in the order asked, with an empty one and a bot-first one", () => {
    add("b", answer("kiwi", "Good morning, here is the brief"));
    const summaries = roomThreadSummaries(["empty", "b"]);
    expect(summaries.map((row) => row.threadId)).toEqual(["empty", "b"]);
    expect(summaries[0]).toEqual({ threadId: "empty", first: null, replies: 0, lastReplyAt: null, repliers: [] });
    expect(summaries[1]).toMatchObject({ first: { text: "Good morning, here is the brief", speaker: { botId: "kiwi" } }, replies: 0, lastReplyAt: null, repliers: [] });
  });

  it("clips a long first line and names the person with no sender by nothing", () => {
    add("c", person("x".repeat(900)));
    const [summary] = roomThreadSummaries(["c"]);
    expect(summary.first?.text).toHaveLength(400);
    expect(summary.first?.clipped).toBe(true);
    expect(summary.first?.speaker).toEqual({ person: {} });
  });

  it("caps repliers at five, newest first", () => {
    add("d", person("Who is here?"));
    for (const bot of ["b1", "b2", "b3", "b4", "b5", "b6"]) add("d", answer(bot, `I am ${bot}`));
    const [summary] = roomThreadSummaries(["d"]);
    expect(summary.replies).toBe(6);
    expect(summary.repliers).toEqual(["b6", "b5", "b4", "b3", "b2"].map((botId) => ({ botId })));
  });

  it("lists a thread whose only lines a webhook or a bot's post put there, and counts a later post as a reply", () => {
    const hook = add("f", { role: "bot", kind: "text", text: "Deploy finished", from: { botId: "kiwi", name: "Kiwi", color: "blue" }, webhookPost: true });
    const post = add("f", { role: "bot", kind: "text", text: "Posted the notes", from: { botId: "pip", name: "Pip", color: "blue" }, peerPost: {} });
    const [summary] = roomThreadSummaries(["f"]);
    expect(summary).toEqual({ threadId: "f", first: { text: "Deploy finished", speaker: { botId: "kiwi" }, at: hook.at }, replies: 1, lastReplyAt: post.at, repliers: [{ botId: "pip" }] });
  });

  it("counts a person's own follow-up as a reply but not their first line", () => {
    add("e", person("one"));
    add("e", person("two"));
    const [summary] = roomThreadSummaries(["e"]);
    expect(summary.replies).toBe(1);
    expect(summary.repliers).toEqual([{ person: {} }]);
  });
});
