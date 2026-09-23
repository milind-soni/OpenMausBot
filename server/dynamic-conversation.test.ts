import { describe, expect, it } from "vitest";
import { dynamicReplyBudget, dynamicBudgetNotice, dynamicControlRequest, parseDynamicPrivateDecision, runDynamicConversation, type DynamicControl, type DynamicMessage } from "./dynamic-conversation.ts";

const control = (decision: Record<string, unknown>, text = "") => text + `<openmaus-goal>${JSON.stringify(decision)}</openmaus-goal>`;
const completed = control({ status: "completed", detail: "The exchange is complete." });
const next = (name: string, text = "") => control({ status: "continue", next: name, instruction: "Address the outstanding question." }, text);

async function conversation(script: string[], options: { cancelledAt?: number; queuedAt?: number; busy?: string; failAt?: number } = {}) {
  const messages: DynamicMessage[] = [{ id: "human", role: "user", kind: "text", text: "Discuss the request." }];
  const phases: DynamicControl[] = [];
  const notices: number[] = [];
  const result = await runDynamicConversation({
    request: "Discuss the request.", routerId: "a",
    getMembers: () => [{ id: "a", name: "Ada", busy: options.busy === "a" }, { id: "b", name: "Bo", busy: options.busy === "b" }],
    getConversation: () => messages, getReplyCount: () => dynamicReplyBudget(messages).count,
    isCancelled: () => options.cancelledAt !== undefined && phases.length >= options.cancelledAt,
    hasNewMessage: () => options.queuedAt !== undefined && phases.length >= options.queuedAt,
    onBudget: ({ count }) => { if (dynamicBudgetNotice(count) && !notices.includes(count)) notices.push(count); },
    step: async (speaker, step) => {
      const replyText = script[phases.length] ?? completed;
      phases.push(step.controlContext);
      if (options.failAt === phases.length) return { replyText: "", outcome: "provider_failed", stopReason: "Fixture provider failed" };
      const parsed = parseDynamicPrivateDecision(replyText);
      if (!step.silent && parsed.visibleText.trim()) messages.push({ id: `reply-${phases.length}`, kind: "text", role: "bot", text: parsed.visibleText, from: { botId: speaker.id, name: speaker.name } });
      return { replyText, outcome: "settled" };
    },
  });
  return { result, phases, messages, notices };
}

describe("dynamic conversations", () => {
  it("routes a question to the relevant member, returns to a previous speaker, and uses one shared ending check", async () => {
    const run = await conversation([next("b", "What did you find?"), next("a", "The dependency is confirmed."), "That resolves it." + completed, completed]);
    expect(run.result).toMatchObject({ status: "completed", replies: 3, calls: 4 });
    expect(run.phases.map(phase => [phase.phase, phase.speaker.id])).toEqual([["route_or_reply", "a"], ["reply", "b"], ["reply", "a"], ["ending", "a"]]);
    expect(run.phases[3].contributions).toEqual([{ id: "a", publicReplies: 2 }, { id: "b", publicReplies: 1 }]);
  });
  it("can route without publishing a separate coordinator answer", async () => {
    const run = await conversation([next("b"), "Here is my answer." + completed, completed]);
    expect(run.messages.filter(message => message.role === "bot").map(message => message.from?.botId)).toEqual(["b"]);
    expect(run.result).toMatchObject({ replies: 1, calls: 3, status: "completed" });
  });
  it("allows an ending check to find an unanswered contribution", async () => {
    const run = await conversation(["My part is done." + completed, next("b"), "And here is the missing part." + completed, completed]);
    expect(run.result).toMatchObject({ replies: 2, calls: 4, status: "completed" });
  });
  it("does not force a public reply when none is needed", async () => {
    expect((await conversation([completed])).result).toMatchObject({ replies: 0, calls: 1, status: "completed" });
  });
  it("skips busy members when choosing the coordinator", async () => {
    const run = await conversation(["Answered." + completed, completed], { busy: "a" });
    expect(run.phases.every(phase => phase.speaker.id === "b")).toBe(true);
  });
  it("bounds invalid and outsider routing decisions", async () => {
    const run = await conversation([next("outsider"), next("outsider"), next("outsider")]);
    expect(run.result).toMatchObject({ status: "paused", replies: 0, calls: 2 });
  });
  it("interrupts between turns and yields to a queued human message", async () => {
    expect((await conversation([next("b", "Question?")], { cancelledAt: 1 })).result.status).toBe("stopped");
    expect((await conversation([next("b", "Question?")], { queuedAt: 1 })).result.status).toBe("yielded");
  });
  it("surfaces a provider failure instead of inventing completion", async () => {
    expect((await conversation([], { failAt: 1 })).result).toMatchObject({ status: "paused", detail: "Fixture provider failed" });
  });
  it("warns from reply 16 onward and stops after reply 22 without a 23rd request", async () => {
    const run = await conversation(Array.from({ length: 30 }, (_, index) => next(index % 2 ? "a" : "b", `Contribution ${index}.`)));
    expect(run.result).toMatchObject({ status: "limit-reached", replies: 22, calls: 22 });
    expect(run.notices).toEqual([16, 17, 18, 19, 20, 21, 22]);
    expect(run.phases[16]).toMatchObject({ wrapUp: true, remaining: 6 });
    expect(run.phases[21]).toMatchObject({ wrapUp: true, remaining: 1 });
  });
  it("accepts validated private JSON without consuming ordinary JSON answers", () => {
    expect(parseDynamicPrivateDecision('{"status":"completed","detail":"done"}').visibleText).toBe("");
    expect(parseDynamicPrivateDecision('{"answer":42}').visibleText).toBe('{"answer":42}');
  });
  it("deduplicates public turns and excludes private work, notices and posted invitations", () => {
    const messages: DynamicMessage[] = [
      { id: "u", role: "user", kind: "text" },
      ...["1", "2"].map(id => ({ id, role: "bot", kind: "text", text: "split output", turnId: "one-turn" })),
      { id: "post", role: "bot", kind: "text", text: "invitation", peerPost: {} },
      { id: "notice", role: "bot", kind: "text", text: "wrap up", systemNotice: {} },
      { id: "tool", role: "bot", kind: "activity", text: "private check" },
    ];
    expect(dynamicReplyBudget(messages)).toEqual({ count: 1, lastUserMessageId: "u" });
    expect(dynamicReplyBudget([...messages, { id: "new", role: "user", kind: "text" }])).toEqual({ count: 0, lastUserMessageId: "new" });
  });
  it("keeps the mutable control record separate from the shared policy", async () => {
    const run = await conversation(["Done." + completed, completed]);
    const text = dynamicControlRequest(run.phases[1]);
    expect(text).toContain('"phase":"ending"');
    expect(text).toContain("Return only the control envelope");
    expect(text).not.toContain("Done.");
  });
});
