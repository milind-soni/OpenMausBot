import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { callRecordIsPartial, callRecordLines } from "./call-record";

let at = 0;
const msg = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at: ++at, ...fields }) as Message;
const spoken = (id: string, text: string, callId: string) => msg(id, { role: "user", text, via: "call", callId });
// A step is a tool the provider ran, so it carries the provider's item id.
const step = (id: string, request: string, name: string, extra: Partial<NonNullable<Message["tool"]>> = {}) =>
  msg(id, { kind: "activity", requestMessageId: request, tool: { name, ok: true, itemId: `item-${id}`, ...extra } });
// A chip the harness writes itself inside a turn: nothing the provider ran is behind it.
const chip = (id: string, request: string, name: string, extra: Partial<NonNullable<Message["tool"]>> = {}) =>
  msg(id, { kind: "activity", requestMessageId: request, tool: { name, ok: true, ...extra } });
const approval = (id: string, request: string, extra: Partial<NonNullable<Message["card"]>> = {}) =>
  msg(id, {
    kind: "options",
    requestMessageId: request,
    card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: `req-${id}`, tool: "Bash", ...extra },
  });
const callRow = (id: string, callId: string) => msg(id, {
  kind: "call",
  text: "Call with Ada · 0:42",
  call: { callId, botId: "b", client: "ios", startedAt: 0, endedAt: 42_000, seconds: 42, endReason: "hung-up" },
});
const ids = (transcript: Message[], callId: string) => callRecordLines(transcript, callId).map((line) => `${line.kind}:${line.id}`);

describe("callRecordLines", () => {
  it("lists the steps and approvals of the turns a call's spoken requests started, in order", () => {
    const transcript = [
      spoken("m1", "check the build", "c1"),
      step("s1", "m1", "Bash", { spoken: "running a command" }),
      approval("o1", "m1", { answered: "allow" }),
      msg("b1", { text: "The build is green.", requestMessageId: "m1" }),
      callRow("r1", "c1"),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1", "approval:o1"]);
  });

  it("lists only its own call's work: never a typed message's, never another call's", () => {
    const transcript = [
      spoken("m1", "first call", "c1"),
      step("s1", "m1", "Read"),
      callRow("r1", "c1"),
      msg("m2", { role: "user", text: "typed in between" }),
      step("s2", "m2", "Write"),
      spoken("m3", "second call", "c2"),
      step("s3", "m3", "Edit"),
      callRow("r2", "c2"),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1"]);
    expect(ids(transcript, "c2")).toEqual(["step:s3"]);
  });

  it("keeps listing the steps of a turn still running when the call ended", () => {
    const transcript = [
      spoken("m1", "draft the report", "c1"),
      step("s1", "m1", "Read"),
      callRow("r1", "c1"),
      step("s2", "m1", "Write", { ok: undefined }),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1", "step:s2"]);
  });

  it("leaves out what is not work: status rows, failed turns, chips that link elsewhere, questions", () => {
    const transcript = [
      spoken("m1", "ask me something", "c1"),
      step("x1", "m1", "notice: the engine runs another model"),
      step("x2", "m1", "error: the engine stopped", { ok: false }),
      msg("x3", {
        kind: "activity",
        requestMessageId: "m1",
        tool: { name: "Sent to Ada", ok: true },
        comm: { groupId: "g1", withBotId: "b2", withName: "Ada", withColor: "blue" },
      }),
      approval("q1", "m1", { title: "Your bot has a question", options: ["Main", "Savings"], tool: undefined }),
    ];
    expect(callRecordLines(transcript, "c1")).toEqual([]);
  });

  it("lists a step only when the provider ran it: the harness's own chips inside a turn are not steps", () => {
    const transcript = [
      spoken("m1", "search the web and run the tests", "c1"),
      step("s1", "m1", "WebSearch", { spoken: "searching the web" }),
      step("s2", "m1", "Bash", { spoken: "running the tests" }),
      // what the harness writes beside them, each with no provider item behind it
      chip("h1", "m1", "approved WebSearch (web search): weather in Pune"),
      chip("h2", "m1", "approved Bash (saved command): pnpm test"),
      chip("h3", "m1", "approved Bash (full access): pnpm test"),
      chip("h4", "m1", "Approve for me: Claude's automatic reviewer is not available for Haiku 4.5, so this bot asks before each action."),
      chip("h5", "m1", "The provider rejected this action despite Full access.", { ok: false }),
      chip("h6", "m1", "generated image could not be attached — invalid image", { ok: false }),
      chip("h7", "m1", "retrying — attempt 2/3 in 5s — the engine dropped the connection"),
      callRow("r1", "c1"),
    ];
    // an auto-approved action is listed once, by its step, never by its receipt as well
    expect(ids(transcript, "c1")).toEqual(["step:s1", "step:s2"]);
  });

  it("is empty for a call nothing was asked on", () => {
    expect(callRecordLines([callRow("r1", "c1")], "c1")).toEqual([]);
  });

  it("leaves out an opened-thread chip: it links to another conversation, it is not work", () => {
    const transcript = [
      spoken("m1", "open a thread for the QA run", "c1"),
      step("s1", "m1", "Read"),
      msg("x1", {
        kind: "activity",
        requestMessageId: "m1",
        tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
        threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" },
      }),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1"]);
  });

  it("leaves out a structured question, even one that still names the tool it came through", () => {
    const transcript = [
      spoken("m1", "set the bot up", "c1"),
      approval("o1", "m1"),
      // a request id and a tool, like an approval: only questionRequest tells them apart
      approval("q1", "m1", {
        title: "Your bot has a question",
        subtitle: "Which model should it run on?",
        options: [],
        tool: "AskUserQuestion",
        questionRequest: { version: 1, questions: [{ question: "Which model should it run on?", options: [{ label: "Opus" }, { label: "Sonnet" }] }] },
      }),
    ];
    expect(ids(transcript, "c1")).toEqual(["approval:o1"]);
  });

  it("hands over each step's tool, a failed one too, and each approval's card as they are", () => {
    const transcript = [
      spoken("m1", "check the build", "c1"),
      step("s1", "m1", "Bash", { spoken: "running a command", summary: "pnpm test" }),
      step("s2", "m1", "Write", { ok: false }),
      approval("o1", "m1", { answered: "allow" }),
    ];
    expect(callRecordLines(transcript, "c1")).toEqual([
      { kind: "step", id: "s1", tool: { name: "Bash", ok: true, itemId: "item-s1", spoken: "running a command", summary: "pnpm test" } },
      { kind: "step", id: "s2", tool: { name: "Write", ok: false, itemId: "item-s2" } },
      { kind: "approval", id: "o1", card: expect.objectContaining({ requestId: "req-o1", tool: "Bash", answered: "allow" }) },
    ]);
  });

  it("keeps listing what a turn still running at hang-up asks and does afterwards", () => {
    const transcript = [
      spoken("m1", "deploy it", "c1"),
      step("s1", "m1", "Bash", { ok: undefined }),
      callRow("r1", "c1"),
      approval("o1", "m1"),
      step("s2", "m1", "Bash"),
      msg("b1", { text: "Deployed.", requestMessageId: "m1" }),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1", "approval:o1", "step:s2"]);
  });

  it("lists only its own call's work where typed lines and the other call's lines interleave with it", () => {
    const transcript = [
      spoken("m1", "first call, first request", "c1"),
      step("s1", "m1", "Read"),
      msg("t1", { role: "user", text: "typed while the first call runs" }),
      step("s2", "t1", "Write"),
      spoken("m2", "first call, second request", "c1"),
      step("s3", "m2", "Edit"),
      callRow("r1", "c1"),
      msg("t2", { role: "user", text: "typed between the calls" }),
      step("s4", "t2", "Grep"),
      spoken("m3", "second call, first request", "c2"),
      step("s5", "m3", "Bash"),
      approval("o1", "m3"),
      msg("t3", { role: "user", text: "typed while the second call runs" }),
      step("s6", "t3", "Glob"),
      spoken("m4", "second call, second request", "c2"),
      step("s7", "m4", "Read"),
      callRow("r2", "c2"),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1", "step:s3"]);
    expect(ids(transcript, "c2")).toEqual(["step:s5", "approval:o1", "step:s7"]);
  });

  // A steered line starts no turn: the turn it joins keeps the request it began
  // with, and the server stamps that request on everything the turn adds.
  it("credits a typed line steered into a call's turn to the call: the turn is one request", () => {
    const transcript = [
      spoken("m1", "draft the report", "c1"),
      step("s1", "m1", "Read"),
      msg("t1", { role: "user", text: "keep it short", steered: true }),
      step("s2", "m1", "Write"),
      callRow("r1", "c1"),
    ];
    expect(ids(transcript, "c1")).toEqual(["step:s1", "step:s2"]);
  });

  it("credits a spoken line steered into another request's turn to that request, not to its own call", () => {
    const intoTypedTurn = [
      msg("m1", { role: "user", text: "refactor the parser" }),
      step("s1", "m1", "Edit"),
      { ...spoken("m2", "the lexer too", "c1"), steered: true },
      step("s2", "m1", "Write"),
      callRow("r1", "c1"),
    ];
    expect(callRecordLines(intoTypedTurn, "c1")).toEqual([]);

    const intoAnEarlierCallsTurn = [
      spoken("m1", "refactor the parser", "c1"),
      step("s1", "m1", "Edit"),
      callRow("r1", "c1"),
      { ...spoken("m2", "and the lexer", "c2"), steered: true },
      step("s2", "m1", "Write"),
      callRow("r2", "c2"),
    ];
    expect(ids(intoAnEarlierCallsTurn, "c1")).toEqual(["step:s1", "step:s2"]);
    expect(ids(intoAnEarlierCallsTurn, "c2")).toEqual([]);
  });
});

// The chat loads the newest page of a long conversation and the rest on
// request. A call's work is read from what is loaded, so a call that began
// before the oldest loaded message may have lines in the part not loaded yet.
describe("callRecordIsPartial", () => {
  const call = { startedAt: 1_000 };
  const loaded = (...times: number[]) => times.map((time, index) => msg(`l${index}`, { at: time }));

  it("is false when nothing older is left to load, however the call began", () => {
    expect(callRecordIsPartial(loaded(5_000, 6_000), call, false)).toBe(false);
  });

  it("is true when older messages remain and the oldest one loaded came after the call began", () => {
    expect(callRecordIsPartial(loaded(5_000, 6_000), call, true)).toBe(true);
  });

  it("is false when the loaded messages reach back before the call began, though older ones remain", () => {
    expect(callRecordIsPartial(loaded(400, 5_000, 6_000), call, true)).toBe(false);
    // a message at the very moment the call began is the oldest line it could hold
    expect(callRecordIsPartial(loaded(1_000, 5_000), call, true)).toBe(false);
  });

  it("is false for a transcript with nothing in it", () => {
    expect(callRecordIsPartial([], call, true)).toBe(false);
  });
});
