import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatToolApproval } from "./chat-tool-approval.ts";

afterEach(() => vi.useRealTimers());

const questionFixtures = [{ question: "Ship the fixture?", options: [{ label: "Yes" }, { label: "No" }] }];

describe("chat tool approval lifecycle", () => {
  it("denies an unanswered request when its deadline expires and rejects late approval", async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved, openQuestion: vi.fn(), resolvedQuestion: vi.fn(), timeoutMs: 100 });
    const answer = gate.ask("audit_write", "Write the fixture receipt");
    const request = open.mock.calls[0][0];

    await vi.advanceTimersByTimeAsync(100);

    await expect(answer).resolves.toBe(false);
    expect(resolved).toHaveBeenCalledExactlyOnceWith(request, false, "timeout");
    expect(gate.answer(request.id, "allow")).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("denies a cancelled ask and never opens another one for the cancelled turn", async () => {
    const abort = new AbortController();
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: abort.signal, open, resolved, openQuestion: vi.fn(), resolvedQuestion: vi.fn() });
    const answer = gate.ask("audit_write", "Write the fixture receipt");
    const request = open.mock.calls[0][0];

    abort.abort();

    await expect(answer).resolves.toBe(false);
    expect(resolved).toHaveBeenCalledExactlyOnceWith(request, false, "system");
    expect(gate.answer(request.id, "allow")).toBe("unavailable");
    await expect(gate.ask("audit_write", "A later request")).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes every outstanding ask and permanently refuses future requests", async () => {
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved, openQuestion: vi.fn(), resolvedQuestion: vi.fn() });
    const first = gate.ask("audit_write", "First fixture receipt");
    const second = gate.ask("audit_write", "Second fixture receipt");
    const requests = open.mock.calls.map(([request]) => request);

    gate.close();
    gate.close();

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(resolved).toHaveBeenCalledTimes(2);
    for (const request of requests) {
      expect(resolved).toHaveBeenCalledWith(request, false, "system");
      expect(gate.answer(request.id, "allow")).toBe("unavailable");
    }
    await expect(gate.ask("audit_write", "Request after close")).resolves.toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("registers the request before publishing it so a synchronous harness approval works", async () => {
    const resolved = vi.fn();
    const answered = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal,
      open: (request) => answered(gate.answer(request.id, "allow")),
      resolved,
      openQuestion: vi.fn(),
      resolvedQuestion: vi.fn(),
    });

    await expect(gate.ask("audit_write", "Write the fixture receipt")).resolves.toBe(true);

    expect(answered).toHaveBeenCalledExactlyOnceWith("allowed-once");
    expect(resolved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool: "audit_write" }), true, "user");
    const request = resolved.mock.calls[0][0];
    expect(gate.answer(request.id, "allow")).toBe("unavailable");
  });
});

describe("Always allow this session", () => {
  it("keeps an allow for the exact tool the card named, for the conversation's later asks", async () => {
    const granted = new Set<string>();
    const open = vi.fn();
    const resolved = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved, openQuestion: vi.fn(), resolvedQuestion: vi.fn(), granted });
    const first = gate.ask("audit_write", "Write the fixture receipt", '["audit","write"]');
    const request = open.mock.calls[0][0];
    expect(request).toMatchObject({ grant: '["audit","write"]' });

    expect(gate.answer(request.id, "allow", undefined, true)).toBe("allowed-once");
    await expect(first).resolves.toBe(true);
    expect(granted).toEqual(new Set(['["audit","write"]']));

    // the same tool asks nothing more, in this turn or a later one sharing the set
    await expect(gate.ask("audit_write", "Write another receipt", '["audit","write"]')).resolves.toBe(true);
    const later = createChatToolApproval({ signal: new AbortController().signal, open, resolved, openQuestion: vi.fn(), resolvedQuestion: vi.fn(), granted });
    await expect(later.ask("audit_write", "Write a third receipt", '["audit","write"]')).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledTimes(1);

    // another tool, and a call that names no grant, still ask
    void later.ask("audit_delete", "Delete the receipt", '["audit","delete"]');
    void later.ask("computer_click", "Click on the person's screen");
    expect(open).toHaveBeenCalledTimes(3);
    expect(open.mock.calls[2][0]).not.toHaveProperty("grant");
    later.close();
  });

  it("keeps nothing for an allow once, a denial, a timeout or a gate without a conversation's set", async () => {
    vi.useFakeTimers();
    const granted = new Set<string>();
    const open = vi.fn();
    const gate = createChatToolApproval({ signal: new AbortController().signal, open, resolved: vi.fn(), openQuestion: vi.fn(), resolvedQuestion: vi.fn(), granted, timeoutMs: 100 });
    const once = gate.ask("audit_write", "Write", '["audit","write"]');
    expect(gate.answer(open.mock.calls[0][0].id, "allow")).toBe("allowed-once");
    await expect(once).resolves.toBe(true);
    const denied = gate.ask("audit_write", "Write", '["audit","write"]');
    expect(gate.answer(open.mock.calls[1][0].id, "deny", undefined, true)).toBe("rejected");
    await expect(denied).resolves.toBe(false);
    const expired = gate.ask("audit_write", "Write", '["audit","write"]');
    await vi.advanceTimersByTimeAsync(100);
    await expect(expired).resolves.toBe(false);
    expect(granted.size).toBe(0);

    const setless = vi.fn();
    const oneShot = createChatToolApproval({ signal: new AbortController().signal, open: setless, resolved: vi.fn(), openQuestion: vi.fn(), resolvedQuestion: vi.fn() });
    const answer = oneShot.ask("audit_write", "Write", '["audit","write"]');
    expect(setless.mock.calls[0][0]).not.toHaveProperty("grant");
    expect(oneShot.answer(setless.mock.calls[0][0].id, "allow", undefined, true)).toBe("allowed-once");
    await expect(answer).resolves.toBe(true);
  });
});

describe("chat tool question lifecycle", () => {
  it("resolves the person's reply verbatim and registers before publishing", async () => {
    const reply = "The user answered your questions.\n\nQ: Ship the fixture?\nA: Yes";
    const answered = vi.fn();
    const resolvedQuestion = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal,
      open: vi.fn(),
      resolved: vi.fn(),
      openQuestion: (request) => answered(gate.answer(request.id, "answer", reply)),
      resolvedQuestion,
    });

    await expect(gate.question("ask_user", "Ship the fixture?", questionFixtures)).resolves.toBe(reply);

    expect(answered).toHaveBeenCalledExactlyOnceWith("answered");
    expect(resolvedQuestion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool: "ask_user" }), true, "user");
    const request = resolvedQuestion.mock.calls[0][0];
    expect(gate.answer(request.id, "answer", "a late reply")).toBe("unavailable");
  });

  it("resolves null when its deadline expires and rejects a late answer", async () => {
    vi.useFakeTimers();
    const openQuestion = vi.fn();
    const resolvedQuestion = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal, open: vi.fn(), resolved: vi.fn(), openQuestion, resolvedQuestion, timeoutMs: 100,
    });
    const answer = gate.question("ask_user", "Ship the fixture?", questionFixtures);
    const request = openQuestion.mock.calls[0][0];

    await vi.advanceTimersByTimeAsync(100);

    await expect(answer).resolves.toBeNull();
    expect(resolvedQuestion).toHaveBeenCalledExactlyOnceWith(request, false, "timeout");
    expect(gate.answer(request.id, "answer", "late")).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves null when the turn aborts and never opens another ask", async () => {
    const abort = new AbortController();
    const openQuestion = vi.fn();
    const resolvedQuestion = vi.fn();
    const gate = createChatToolApproval({
      signal: abort.signal, open: vi.fn(), resolved: vi.fn(), openQuestion, resolvedQuestion,
    });
    const answer = gate.question("ask_user", "Ship the fixture?", questionFixtures);
    const request = openQuestion.mock.calls[0][0];

    abort.abort();

    await expect(answer).resolves.toBeNull();
    expect(resolvedQuestion).toHaveBeenCalledExactlyOnceWith(request, false, "system");
    await expect(gate.question("ask_user", "A later ask", questionFixtures)).resolves.toBeNull();
    expect(openQuestion).toHaveBeenCalledTimes(1);
  });

  it("closes an outstanding question as unanswered", async () => {
    const openQuestion = vi.fn();
    const resolvedQuestion = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal, open: vi.fn(), resolved: vi.fn(), openQuestion, resolvedQuestion,
    });
    const answer = gate.question("ask_user", "Ship the fixture?", questionFixtures);
    const request = openQuestion.mock.calls[0][0];

    gate.close();

    await expect(answer).resolves.toBeNull();
    expect(resolvedQuestion).toHaveBeenCalledExactlyOnceWith(request, false, "system");
    expect(gate.answer(request.id, "answer", "late")).toBe("unavailable");
  });

  it("keeps a question pending for an allow or a blank reply, then denies on request", async () => {
    const openQuestion = vi.fn();
    const resolvedQuestion = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal, open: vi.fn(), resolved: vi.fn(), openQuestion, resolvedQuestion,
    });
    const answer = gate.question("ask_user", "Ship the fixture?", questionFixtures);
    const request = openQuestion.mock.calls[0][0];

    expect(gate.answer(request.id, "allow")).toBe("unavailable");
    expect(gate.answer(request.id, "answer", "   ")).toBe("unavailable");
    expect(gate.answer(request.id, "deny")).toBe("rejected");

    await expect(answer).resolves.toBeNull();
    expect(resolvedQuestion).toHaveBeenCalledExactlyOnceWith(request, false, "user");
  });

  it("never lets a reply settle a permission card", async () => {
    const open = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal, open, resolved: vi.fn(), openQuestion: vi.fn(), resolvedQuestion: vi.fn(),
    });
    const allowed = gate.ask("audit_write", "Write the fixture receipt");
    const request = open.mock.calls[0][0];

    expect(gate.answer(request.id, "answer", "Yes, write it")).toBe("unavailable");
    expect(gate.answer(request.id, "allow")).toBe("allowed-once");

    await expect(allowed).resolves.toBe(true);
  });
});
