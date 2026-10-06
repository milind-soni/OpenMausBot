import { describe, expect, it } from "vitest";
import type { OptionCardData, WireMessage } from "../shared/wire.ts";
import { assertChannelCardTarget, assertChannelOutboundLease } from "./channel-card-guard.ts";
import { channelCardFingerprint, type ChannelAnswerTarget, type ChannelSnapshot } from "./channel-conversation.ts";

function fixture(question = false) {
  const source: WireMessage = { id: "source", role: "user", kind: "text", at: 1, sendId: "send", requestPending: true };
  const card: OptionCardData = { title: "Confirm", subtitle: "Run command", options: ["Allow", "Deny"],
    requestId: "request", requestType: question ? "question" : "permission", ...(question ? {} : { tool: "Bash" }) };
  const message: WireMessage = { id: "card", role: "bot", kind: "options", at: 2, parentId: source.id,
    turnId: "turn", requestMessageId: source.id, card };
  const snapshot: ChannelSnapshot = { messageId: source.id, activeLeafId: message.id, activeTurnId: "turn",
    executionId: "execution", phase: "waiting", messages: [source, message] };
  const target: ChannelAnswerTarget = { threadId: "thread", sendId: "send", requestId: "request", cardMessageId: message.id,
    cardFingerprint: channelCardFingerprint(card), messageId: source.id, activeLeafId: message.id,
    activeTurnId: "turn", executionId: "execution" };
  return { source, card, message, snapshot, target };
}

describe("channel card authorization boundary", () => {
  it("requires the private outbound capability to own this bot, thread and live execution", () => {
    const { target } = fixture();
    const capability = { botId: "bot", threadId: target.threadId, generation: target.executionId! };
    expect(() => assertChannelOutboundLease(target, "bot", capability, true)).not.toThrow();
    expect(() => assertChannelOutboundLease(target, "bot", undefined, true)).toThrow();
    expect(() => assertChannelOutboundLease(target, "bot", capability, false)).toThrow();
    for (const field of ["botId", "threadId", "generation"] as const) {
      expect(() => assertChannelOutboundLease(target, "bot", { ...capability, [field]: "foreign" }, true)).toThrow();
    }
  });
  it("accepts an exact live once-only approval or denial", () => {
    const { snapshot, target, message } = fixture();
    expect(assertChannelCardTarget(snapshot, target, "allow")).toBe(message);
    expect(assertChannelCardTarget(snapshot, target, "deny")).toBe(message);
  });
  it.each(["activeLeafId", "activeTurnId", "executionId", "messageId"] as const)("rejects a stale %s", field => {
    const { snapshot, target } = fixture();
    expect(() => assertChannelCardTarget({ ...snapshot, [field]: "replacement" }, target, "allow")).toThrow();
  });
  it.each(["settled", "working", "untracked"])("never revives a %s approval", phase => {
    const { snapshot, target } = fixture();
    expect(() => assertChannelCardTarget({ ...snapshot, phase }, target, "allow")).toThrow();
  });
  it.each(["activeTurnId", "executionId"] as const)("requires a nonnull live %s", field => {
    const { snapshot, target } = fixture();
    expect(() => assertChannelCardTarget({ ...snapshot, [field]: null }, { ...target, [field]: null }, "allow")).toThrow();
  });
  it("rejects changed, settled, missing, or duplicate cards before dispatch", () => {
    for (const patch of [{ subtitle: "Changed command" }, { answered: "allow" }, { dismissed: true }, { expired: true }, { requestId: "other" }]) {
      const { snapshot, target, card } = fixture();
      Object.assign(card, patch);
      expect(() => assertChannelCardTarget(snapshot, target, "allow")).toThrow();
    }
    const { snapshot, target, message } = fixture();
    snapshot.messages.push({ ...message, id: "duplicate" });
    expect(() => assertChannelCardTarget(snapshot, target, "allow")).toThrow();
  });
  it("rejects a canceled source, foreign turn, and unproven request", () => {
    for (const mutation of [
      (value: ReturnType<typeof fixture>) => { value.source.requestCancelled = true; },
      (value: ReturnType<typeof fixture>) => { value.source.requestPending = false; },
      (value: ReturnType<typeof fixture>) => { value.source.sendId = "other"; },
      (value: ReturnType<typeof fixture>) => { value.message.turnId = "foreign"; },
      (value: ReturnType<typeof fixture>) => { value.message.requestMessageId = "foreign"; },
      (value: ReturnType<typeof fixture>) => { delete value.message.turnId; },
    ]) {
      const value = fixture(); mutation(value);
      expect(() => assertChannelCardTarget(value.snapshot, value.target, "allow")).toThrow();
    }
  });
  it.each(["skillRequest", "routineRequest", "profileRequest", "modelRequest", "teamSetupRequest", "teamMemoryRequest"] as const)("rejects native %s reviews even if the fingerprint matches", field => {
    const { snapshot, target, card } = fixture();
    Object.assign(card, { [field]: {} });
    target.cardFingerprint = channelCardFingerprint(card);
    expect(() => assertChannelCardTarget(snapshot, target, "allow")).toThrow(/workspace/);
  });
  it("allows a proven outbound hold, but refuses changed outbound calls", () => {
    const { snapshot, target, card, message } = fixture();
    card.outboundRequest = { tool: "gmail_send", app: "gmail", calls: [{ app: "gmail", label: "Send email" }] };
    target.cardFingerprint = channelCardFingerprint(card);
    expect(assertChannelCardTarget(snapshot, target, "allow")).toBe(message);
    card.outboundRequest.calls![0].label = "Changed recipient";
    expect(() => assertChannelCardTarget(snapshot, target, "allow")).toThrow();
  });
  it("never interprets question answers as permission grants or permission text as questions", () => {
    const question = fixture(true), approval = fixture();
    expect(() => assertChannelCardTarget(question.snapshot, question.target, "allow")).toThrow();
    expect(() => assertChannelCardTarget(question.snapshot, question.target, "deny")).toThrow();
    expect(() => assertChannelCardTarget(approval.snapshot, approval.target, "answer")).toThrow();
  });
  it("allows the same persistent question after provider completion or restart", () => {
    const { snapshot, target, message } = fixture(true);
    for (const phase of ["settled", "untracked"]) {
      expect(assertChannelCardTarget({ ...snapshot, phase, activeTurnId: null, executionId: null }, target, "answer")).toBe(message);
    }
  });
  it("does not continue a question into a replacement execution or later foreign turn", () => {
    const { snapshot, target, message } = fixture(true);
    expect(() => assertChannelCardTarget({ ...snapshot, executionId: "replacement" }, target, "answer")).toThrow();
    snapshot.messages.push({ ...message, id: "later", kind: "text", card: undefined, turnId: "new-turn" });
    expect(() => assertChannelCardTarget({ ...snapshot, activeTurnId: null }, target, "answer")).toThrow();
  });
});
