import { afterEach, describe, expect, it, vi } from "vitest";

import { chatSessionOperationKey, createChatSessionMemory, createChatToolApproval, SESSION_KEYS_PER_THREAD_MAX, SESSION_THREADS_MAX } from "./chat-tool-approval.ts";

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

  it("remembers a session allow only for the exact operation the card carried", async () => {
    const remember = vi.fn();
    const open = vi.fn();
    const gate = createChatToolApproval({
      signal: new AbortController().signal, open, resolved: vi.fn(), openQuestion: vi.fn(), resolvedQuestion: vi.fn(), remember,
    });
    const once = gate.ask("fx_write", "note", "fx_write\n{\"note\":\"one\"}");
    const session = gate.ask("fx_write", "note", "fx_write\n{\"note\":\"two\"}");
    const plain = gate.ask("fx_write", "note");
    const ids = open.mock.calls.map(([request]) => request.id as string);

    expect(gate.answer(ids[0]!, "allow")).toBe("allowed-once");
    expect(gate.answer(ids[1]!, "allow", undefined, true)).toBe("allowed-once");
    expect(gate.answer(ids[2]!, "allow", undefined, true)).toBe("allowed-once");
    expect(remember).toHaveBeenCalledExactlyOnceWith("fx_write\n{\"note\":\"two\"}");
    await expect(Promise.all([once, session, plain])).resolves.toEqual([true, true, true]);

    const server = "fx\nabc\nwrite";
    const same = chatSessionOperationKey("fx_write", { note: "one", extra: true }, server);
    expect(same).toBe(chatSessionOperationKey("fx_write", { extra: true, note: "one" }, server));
    expect(chatSessionOperationKey("fx_write", { note: "one", extra: true }, "fx\ndef\nwrite")).not.toBe(same);
    expect(chatSessionOperationKey("fx_write", { note: "one" }, undefined)).toBeNull();
    expect(chatSessionOperationKey("computer_click", { x: 1 }, server)).toBeNull();
    expect(chatSessionOperationKey("browser_navigate", { url: "https://example.test" }, server)).toBeNull();
    expect(chatSessionOperationKey("composio_gmail_send_email", { to: "a@example.test" }, server)).toBeNull();
    expect(chatSessionOperationKey("ask_user", { questions: [] }, server)).toBeNull();
  });
});

describe("chat session memory", () => {
  it("drops one thread's grants on forget and every grant on clear", () => {
    const memory = createChatSessionMemory();
    memory.remember("a", "k1");
    memory.remember("b", "k1");
    memory.forget("a");
    expect(memory.has("a", "k1")).toBe(false);
    expect(memory.has("b", "k1")).toBe(true);
    memory.forget("missing");
    memory.clear();
    expect(memory.has("b", "k1")).toBe(false);
    expect(memory.threadCount).toBe(0);
  });

  it("keeps at most the newest threads and grants", () => {
    const memory = createChatSessionMemory();
    for (let index = 0; index <= SESSION_THREADS_MAX; index += 1) memory.remember(`t${index}`, "k");
    expect(memory.threadCount).toBe(SESSION_THREADS_MAX);
    expect(memory.has("t0", "k")).toBe(false);
    expect(memory.has(`t${SESSION_THREADS_MAX}`, "k")).toBe(true);
    // Using a thread again keeps it from being the oldest.
    memory.remember("t1", "k");
    memory.remember("fresh", "k");
    expect(memory.has("t1", "k")).toBe(true);
    expect(memory.has("t2", "k")).toBe(false);

    for (let index = 0; index <= SESSION_KEYS_PER_THREAD_MAX; index += 1) memory.remember("many", `k${index}`);
    expect(memory.has("many", "k0")).toBe(false);
    expect(memory.has("many", `k${SESSION_KEYS_PER_THREAD_MAX}`)).toBe(true);
  });
});
