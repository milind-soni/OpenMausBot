// Every way an answer can fail to arrive is a deny.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASK_TIMEOUT_MS,
  DENY_TIMEOUT_NOTE,
  DUPLICATE_ASK_ID_NOTE,
  QUESTION_TIMEOUT_NOTE,
  createApprovalGate,
  type Ask,
  type AskResolution,
} from "./approval-gate.ts";

function gateWith(timeoutMs?: number) {
  const opened: Ask[] = [];
  const resolved: Array<{ ask: Ask; resolution: AskResolution }> = [];
  const gate = createApprovalGate({
    onOpen: (ask) => opened.push(ask),
    onResolve: (ask, resolution) => resolved.push({ ask, resolution }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { gate, opened, resolved };
}

describe("createApprovalGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens an ask and resolves it with the user's allow", async () => {
    const { gate, opened, resolved } = gateWith();
    const pending = gate.ask({ kind: "permission", tool: "notes__read", summary: "{}" });
    expect(opened).toHaveLength(1);
    expect(gate.pending()).toBe(1);
    expect(gate.answer(opened[0]!.id, "allow")).toBe("allowed-once");
    await expect(pending).resolves.toEqual({ behavior: "allow", message: undefined, source: "user" });
    expect(resolved[0]!.resolution.source).toBe("user");
    expect(gate.pending()).toBe(0);
  });

  it("resolves a deny, with the reason", async () => {
    const { gate, opened } = gateWith();
    const pending = gate.ask({ kind: "permission", tool: "t", summary: "s" });
    expect(gate.answer(opened[0]!.id, "deny", "not today")).toBe("rejected");
    await expect(pending).resolves.toMatchObject({ behavior: "deny", message: "not today", source: "user" });
  });

  it("answers a question", async () => {
    const { gate, opened } = gateWith();
    const pending = gate.ask({ kind: "question", tool: "ask_user", summary: "which one?", choices: ["a", "b"] });
    expect(opened[0]!.choices).toEqual(["a", "b"]);
    expect(gate.answer(opened[0]!.id, "answer", "b")).toBe("answered");
    await expect(pending).resolves.toMatchObject({ behavior: "answer", message: "b" });
  });

  it("treats an allow on a question as an answer — a question has no allow", async () => {
    const { gate, opened } = gateWith();
    const pending = gate.ask({ kind: "question", tool: "ask_user", summary: "?" });
    expect(gate.answer(opened[0]!.id, "allow", "yes")).toBe("answered");
    await expect(pending).resolves.toMatchObject({ behavior: "answer", message: "yes" });
  });

  it("is unavailable for an id nothing is waiting on — never an allow", () => {
    const { gate } = gateWith();
    expect(gate.answer("never-opened", "allow")).toBe("unavailable");
  });

  it("is unavailable for an id that was already answered", async () => {
    const { gate, opened } = gateWith();
    const pending = gate.ask({ kind: "permission", tool: "t", summary: "s" });
    gate.answer(opened[0]!.id, "allow");
    await pending;
    expect(gate.answer(opened[0]!.id, "allow")).toBe("unavailable");
  });

  it("denies a permission nobody answers in time, and says so", async () => {
    const { gate, resolved } = gateWith(1_000);
    const pending = gate.ask({ kind: "permission", tool: "t", summary: "s" });
    vi.advanceTimersByTime(1_000);
    await expect(pending).resolves.toEqual({ behavior: "deny", message: DENY_TIMEOUT_NOTE, source: "timeout" });
    expect(resolved[0]!.resolution.source).toBe("timeout");
  });

  it("answers a question nobody answers in time with the best-judgment note", async () => {
    const { gate } = gateWith(1_000);
    const pending = gate.ask({ kind: "question", tool: "ask_user", summary: "?" });
    vi.advanceTimersByTime(1_000);
    await expect(pending).resolves.toEqual({ behavior: "answer", message: QUESTION_TIMEOUT_NOTE, source: "timeout" });
  });

  it("defaults to the CLI broker's fifteen minutes", async () => {
    const { gate } = gateWith();
    const pending = gate.ask({ kind: "permission", tool: "t", summary: "s" });
    vi.advanceTimersByTime(ASK_TIMEOUT_MS - 1);
    expect(gate.pending()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toMatchObject({ source: "timeout" });
  });

  it("drains everything still open with the system reply when the turn ends", async () => {
    const { gate, resolved } = gateWith();
    const permission = gate.ask({ kind: "permission", tool: "t", summary: "s" });
    const question = gate.ask({ kind: "question", tool: "q", summary: "?" });
    gate.drain();
    await expect(permission).resolves.toMatchObject({ behavior: "deny", source: "system" });
    await expect(question).resolves.toMatchObject({ behavior: "answer", source: "system" });
    expect(resolved).toHaveLength(2);
    expect(gate.pending()).toBe(0);
  });

  it("denies a duplicate id outright rather than merging two asks", async () => {
    const { gate, opened, resolved } = gateWith();
    const first = gate.ask({ id: "same", kind: "permission", tool: "t", summary: "s" });
    const second = gate.ask({ id: "same", kind: "permission", tool: "t2", summary: "s2" });
    await expect(second).resolves.toEqual({ behavior: "deny", message: DUPLICATE_ASK_ID_NOTE, source: "system" });
    // the first is untouched and still answerable
    expect(opened).toHaveLength(1);
    expect(gate.answer("same", "allow")).toBe("allowed-once");
    await expect(first).resolves.toMatchObject({ behavior: "allow" });
    expect(resolved.filter((r) => r.resolution.source === "user")).toHaveLength(1);
  });

  it("resolves each ask exactly once even if answered and timed out", async () => {
    const { gate, opened, resolved } = gateWith(1_000);
    const pending = gate.ask({ kind: "permission", tool: "t", summary: "s" });
    gate.answer(opened[0]!.id, "allow");
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toMatchObject({ behavior: "allow", source: "user" });
    expect(resolved).toHaveLength(1);
  });
});
