import { describe, expect, it } from "vitest";

import type { ContextMessage, HandedState } from "../delta-context.ts";
import type { BotRecord, Message, TaskRecord } from "../store.ts";
import type { CompactConversationInput } from "./conversation-compaction.ts";
import { createResumeCheck } from "./resume-check.ts";

const messages: Message[] = ["ask one", "answer one", "ask two", "answer two"].map((text, index) =>
  ({ id: `m${index}`, at: index, role: index % 2 ? "bot" : "user", kind: "text", text }) as Message);
const handedAll = (extra: Partial<HandedState> = {}): HandedState => ({ session: "session-1", config: "config", through: "m3", ids: [], ...extra });

function setup(task: Partial<TaskRecord> = {}, options: { record?: Record<string, unknown>; folder?: string; strict?: boolean; keep?: string[]; rules?: string; selection?: Record<string, unknown> } = {}) {
  const bot = { id: "b1", name: "Bot", soul: "soul", modelSelection: options.selection ?? { instanceId: "claude", model: "model" } } as unknown as BotRecord;
  const live = { threadId: "t1", resumeCursors: { claude: "session-1" }, lastInstanceId: "claude", handedMessages: { claude: handedAll() }, ...task } as unknown as TaskRecord;
  const check = createResumeCheck({
    store: { taskByThread: () => live, activePath: () => messages } as never,
    directContext: (_bot, _thread, all): ContextMessage[] => all.map((m) => ({ id: m.id, role: m.role === "user" ? "user" : "assistant", text: m.text ?? "", ...(options.keep?.includes(m.id) ? { keep: true } : {}) })),
    latestCompaction: () => options.record as never,
    context: () => undefined,
    everyBotRules: () => options.rules,
    sectionPrompt: () => "",
    folderToFollow: () => options.folder,
    externalMarker: (id) => id?.startsWith("__external__") ? id : undefined,
    strictResume: () => options.strict ?? true,
    currentBot: () => bot,
  });
  const input = (over: Partial<CompactConversationInput> = {}) => ({ bot, threadId: "t1",
    instance: { instanceId: bot.modelSelection.instanceId, driverKind: bot.modelSelection.instanceId === "codex" ? "codex" : "claudeAgent" }, model: "model", excludedIds: new Set<string>(), manual: true, generation: "g", ...over }) as unknown as CompactConversationInput;
  return { live, bot, check, input, resumes: (over: Partial<CompactConversationInput> = {}, session = "session-1") => check.nextTurnResumes(input(over), session) };
}

describe("whether the next turn carries on a session", () => {
  it("does when every message was delivered to it", () => {
    expect(setup().resumes()).toBe(true);
  });

  it("is about the session the conversation holds, and no other", () => {
    expect(setup().resumes({}, "another")).toBe(false);
    expect(setup({ resumeCursors: {} }).resumes()).toBe(false);
  });

  it("does not after a rewind, or after an update from outside every engine", () => {
    expect(setup({ rewound: true }).resumes()).toBe(false);
    expect(setup({ lastInstanceId: "__external__:1" }).resumes()).toBe(false);
  });

  it("does not for an engine that was not the last one to answer, nor a conversation whose engine has no cursor of its own", () => {
    expect(setup({ lastInstanceId: "codex" }).resumes()).toBe(false);
    expect(setup({ lastInstanceId: "codex", resumeCursors: { claude: "session-1", codex: "x" } }).resumes()).toBe(false);
  });

  it("does for an older conversation with no last engine recorded and one cursor, as the turn itself does", () => {
    expect(setup({ lastInstanceId: undefined }).resumes()).toBe(true);
    expect(setup({ lastInstanceId: undefined, resumeCursors: { claude: "session-1", codex: "x" } }).resumes()).toBe(false);
  });

  it("does not when the thread follows its bot into another folder", () => {
    expect(setup({}, { folder: "/work" }).resumes()).toBe(false);
  });

  it("does not for a summary record whose anchors are on this branch and which was not applied yet, and does for one already applied", () => {
    const record = { id: "m4", firstKeptId: "m2", foldedThroughId: "m1", summary: "summary", by: "person", tokensBefore: 1 };
    const withRecord = [...messages, { id: "m4", at: 4, role: "bot", kind: "compaction", compaction: record } as Message];
    const unapplied = setup({}, { record });
    unapplied.live.resumeCursors = { claude: "session-1" };
    const check = createResumeCheck({
      store: { taskByThread: () => unapplied.live, activePath: () => withRecord } as never,
      directContext: (_bot, _thread, all) => all.map((m) => ({ id: m.id, role: m.role === "user" ? "user" as const : "assistant" as const, text: m.kind === "compaction" ? "" : m.text ?? "" })),
      latestCompaction: () => record as never, context: () => undefined, everyBotRules: () => undefined, sectionPrompt: () => "", folderToFollow: () => undefined, externalMarker: () => undefined, strictResume: () => true, currentBot: () => unapplied.bot,
    });
    expect(check.nextTurnResumes(unapplied.input(), "session-1")).toBe(false);
    unapplied.live.appliedCompactionId = "m4";
    expect(check.nextTurnResumes(unapplied.input(), "session-1")).toBe(true);
  });

  it("does for a summary record from another branch, as a turn resumes there", () => {
    const stale = { id: "m9", firstKeptId: "m2", foldedThroughId: "abandoned", summary: "obsolete", by: "harness", tokensBefore: 1 };
    expect(setup({}, { record: stale }).resumes()).toBe(true);
  });

  it("does not when the delivery ledger cannot say what the session holds, and does when it can", () => {
    expect(setup({ handedMessages: { claude: handedAll({ session: "other" }) } }).resumes()).toBe(false);
    expect(setup({ handedMessages: { claude: handedAll({ through: "gone" }) } }).resumes()).toBe(false);
    expect(setup({ handedMessages: {} }).resumes()).toBe(true);
    expect(setup({ handedMessages: { claude: handedAll({ through: "m1" }) } }).resumes()).toBe(true);
  });

  it("does not for a Codex thread that holds an effort the next turn would clear", () => {
    const codex = { lastInstanceId: "codex", resumeCursors: { codex: "session-1" }, handedMessages: { codex: handedAll({ effort: "high" }) } };
    expect(setup(codex, { selection: { instanceId: "codex", model: "model" } }).resumes()).toBe(false);
    expect(setup(codex, { selection: { instanceId: "codex", model: "model", effort: "high" } }).resumes()).toBe(true);
  });

  it("asks about the selection as it is now, not as it was when the compaction began", () => {
    const codex = { lastInstanceId: "codex", resumeCursors: { codex: "session-1" }, handedMessages: { codex: handedAll({ effort: "high" }) } };
    const f = setup(codex, { selection: { instanceId: "codex", model: "model", effort: "high" } });
    const began = f.input();
    expect(f.check.nextTurnResumes(began, "session-1")).toBe(true);
    f.bot.modelSelection = { instanceId: "codex", model: "model" };
    expect(f.check.nextTurnResumes(began, "session-1")).toBe(false);
    f.bot.modelSelection = { instanceId: "claude", model: "model" };
    expect(f.check.nextTurnResumes(began, "session-1")).toBe(false);
  });

  it("does not when a teammate's result the session has not seen changed the configuration it keeps", () => {
    const unseen = { handedMessages: { claude: handedAll({ through: "m1", config: "old" }) } };
    expect(setup(unseen, { keep: ["m3"] }).resumes()).toBe(false);
    expect(setup({ handedMessages: { claude: handedAll({ through: "m1", config: setup().check.sessionConfigFor({ id: "b1", name: "Bot" } as BotRecord, "claudeAgent", "model", undefined)("soul") }) } }, { keep: ["m3"] }).resumes()).toBe(true);
    expect(setup(unseen).resumes()).toBe(true);
  });

  it("is never true for a task that is gone", () => {
    const { check, input } = setup();
    const gone = createResumeCheck({ store: { taskByThread: () => undefined, activePath: () => messages } as never, directContext: () => [], latestCompaction: () => undefined, context: () => undefined,
      everyBotRules: () => undefined, sectionPrompt: () => "", folderToFollow: () => undefined, externalMarker: () => undefined, strictResume: () => true, currentBot: () => input().bot });
    expect(gone.nextTurnResumes(input(), "session-1")).toBe(false);
    expect(check.nextTurnResumes(input(), "session-1")).toBe(true);
  });

  it("hashes what a resumed session keeps from its launch, the model and effort only for Codex", () => {
    const { check } = setup({}, { rules: "be brief" });
    const bot = { id: "b1", name: "Bot" } as BotRecord;
    const claude = (model: string, effort?: string) => check.sessionConfigFor(bot, "claudeAgent", model, effort)("soul");
    expect(claude("a")).toBe(claude("b", "high"));
    const codex = (model: string, effort?: string) => check.sessionConfigFor(bot, "codex", model, effort)("soul");
    expect(codex("a")).not.toBe(codex("b"));
    expect(codex("a")).not.toBe(codex("a", "high"));
    expect(claude("a")).not.toBe(setup().check.sessionConfigFor(bot, "claudeAgent", "a", undefined)("soul"));
  });
});
