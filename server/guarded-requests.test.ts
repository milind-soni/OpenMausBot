import { describe, expect, it } from "vitest";
import type { WireMessage } from "../shared/wire.ts";
import { assertRequestTarget, guardedRequestPath, requestNeedsInput, requestSourceForCard } from "./guarded-requests.ts";

const source: WireMessage = { id: "source", role: "user", kind: "text", text: "request", at: 1, parentId: null, sendId: "fixture-send-id-1234" };
const reply: WireMessage = { id: "reply", role: "bot", kind: "text", text: "reply", at: 2, parentId: source.id,
  turnId: "turn-one", requestMessageId: source.id, turnTerminal: true };
const path = (messages: WireMessage[], leaf: string | null = messages.at(-1)?.id ?? null) => guardedRequestPath(messages, leaf, source.sendId!);

describe("guarded request ancestry", () => {
  it("fences a replacement setup even when both provider turn ids are null and no text was appended", () => {
    const before = { messageId: source.id, activeLeafId: source.id, activeTurnId: null, executionId: "first-setup" };
    const target = { messageId: source.id, expectedActiveLeafId: source.id, expectedTurnId: null, expectedExecutionId: "first-setup" };
    expect(() => assertRequestTarget(before, target)).not.toThrow();
    expect(() => assertRequestTarget({ ...before, executionId: "replacement-setup" }, target)).toThrow();
    expect(() => assertRequestTarget({ ...before, activeTurnId: "newly-started-turn" }, target)).toThrow();
  });
  it("permits proven continuation turns without inventing another user message", () => {
    const resumed = { ...reply, id: "resumed", parentId: reply.id, turnId: "turn-two" };
    expect(path([source, reply, resumed])).toEqual([source, reply, resumed]);
  });
  it.each([
    [source, reply, { ...source, id: "later", parentId: reply.id, sendId: "different-send-id" }],
    [source, reply, { ...reply, id: "sibling", parentId: source.id }],
    [source, reply, { ...source, id: "duplicate" }],
    [{ ...source, steered: true }, reply],
    [{ ...source, peerAsk: { botId: "peer", name: "Peer" } }, reply],
    [source, { ...reply, parentId: "missing" }],
    [source, { ...reply, parentId: reply.id }],
  ] satisfies WireMessage[][])("rejects foreign, detached, ambiguous or cyclic provenance %#", (...messages) => {
    expect(() => path(messages)).toThrow();
  });
  it("refuses a detached final even when the selected leaf is on the original branch", () => {
    expect(() => path([source, reply, { ...reply, id: "detached" }], reply.id)).toThrow();
    expect(() => path([source, reply], source.id)).toThrow();
  });
  it("does not mistake an unrelated earlier branch for this request", () => {
    const old = { ...reply, id: "old", parentId: null };
    expect(path([old, source, reply])).toEqual([source, reply]);
  });
  it("bounds the response without returning a misleading partial transcript", () => {
    const messages = [source];
    for (let i = 0; i < 500; i++) messages.push({ ...reply, id: `reply-${i}`, parentId: messages.at(-1)!.id });
    expect(() => path(messages)).toThrow(/response limit/);
  });
  it("binds a reviewed card to its own original ancestor, not a newer human turn", () => {
    const card: WireMessage = { ...reply, id: "card", kind: "options" };
    const later: WireMessage = { ...source, id: "new-person", parentId: card.id };
    expect(requestSourceForCard([source, reply, card, later], card.id)).toBe(source.id);
    expect(requestSourceForCard([source, { ...card, parentId: "missing" }], card.id)).toBeUndefined();
  });
  it("keeps unsupported questions waiting for review in the workspace", () => {
    const card = { ...reply, card: { title: "Question", subtitle: "Choose in the workspace", options: [], requestId: "question-id" } };
    expect(requestNeedsInput(card)).toBe(true);
    expect(requestNeedsInput({ ...card, card: { ...card.card, answered: "done" } })).toBe(false);
  });
});
