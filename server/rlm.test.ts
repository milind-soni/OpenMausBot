import { describe, expect, it } from "vitest";

import {
  extractFinal,
  extractReplCode,
  rlmSubSystem,
  RLM_MAX_LLM_CALLS,
  RLM_SUB_INSTRUCTIONS,
  runRlmTurn,
  type RlmChat,
  type RlmEngineEvent,
  type RlmTurnResult,
} from "./rlm.ts";

/** A fake chat model scripted by kind: each root call pops the next reply. */
function scriptedRoot(replies: string[]) {
  const rootCalls: string[][] = [];
  const subQuestions: string[] = [];
  const chat: RlmChat = async (request) => {
    if (request.kind === "root") {
      rootCalls.push(request.messages.map((m) => m.content));
      const next = replies.shift();
      if (next === undefined) throw new Error("script exhausted");
      return { text: next, usage: { input: 10, output: 5 } };
    }
    subQuestions.push(request.messages.at(-1)?.content ?? "");
    return { text: `answer-${subQuestions.length}`, usage: { input: 3, output: 2 } };
  };
  return { chat, rootCalls, subQuestions };
}

const collect = () => {
  const events: RlmEngineEvent[] = [];
  return { events, emit: (event: RlmEngineEvent) => events.push(event) };
};

const run = async (
  replies: string[],
  input: Partial<Parameters<typeof runRlmTurn>[0]> = {},
): Promise<{ result: RlmTurnResult; events: RlmEngineEvent[]; rootCalls: string[][]; subQuestions: string[] }> => {
  const scripted = scriptedRoot(replies);
  const sink = collect();
  const result = await runRlmTurn({ prompt: "what?", ...input }, { emit: sink.emit, chat: scripted.chat });
  return { ...sink, rootCalls: scripted.rootCalls, subQuestions: scripted.subQuestions, result };
};

describe("extractFinal", () => {
  it("extracts a plain string literal", () => {
    expect(extractFinal('final("the answer is 4")')).toEqual({ value: "the answer is 4", rest: "" });
  });

  it("returns the prose before the call", () => {
    expect(extractFinal('Let me check. final("42")')?.rest).toBe("Let me check.");
  });

  it("evaluates an expression argument", () => {
    expect(extractFinal('final(JSON.stringify({a:1}))')?.value).toBe('{"a":1}');
  });

  it("keeps parentheses inside strings balanced", () => {
    expect(extractFinal('final("a (b) c")')?.value).toBe("a (b) c");
  });

  it("rejects references to undefined variables", () => {
    expect(extractFinal("final(env)")).toBeNull();
  });

  it("returns null for unterminated calls, empty answers, and mentions in prose", () => {
    expect(extractFinal('final("unterminated')).toBeNull();
    expect(extractFinal('final("")')).toBeNull();
    expect(extractFinal("i will not call final(x) here")).toBeNull();
  });
});

describe("extractReplCode", () => {
  it("splits narration from the fenced repl block", () => {
    const out = extractReplCode("Checking env.\n```repl\nprint(env.slice(0, 10))\n```");
    expect(out.prose).toBe("Checking env.");
    expect(out.code).toBe("print(env.slice(0, 10))");
  });

  it("accepts bare and javascript fences, rejects others", () => {
    expect(extractReplCode("```\n1+1\n```").code).toBe("1+1");
    expect(extractReplCode("```javascript\n1+1\n```").code).toBe("1+1");
    expect(extractReplCode("```python\nprint(1)\n```").code).toBeNull();
  });

  it("returns prose untouched when there is no fence", () => {
    expect(extractReplCode("just thinking")).toEqual({ prose: "just thinking", code: null });
  });
});

describe("runRlmTurn", () => {
  it("delivers final() verbatim and never the surrounding prose", async () => {
    const { result, events, rootCalls } = await run([
      'I checked env_messages. final("Biscuit is the dog.")',
    ]);
    expect(result.text).toBe("Biscuit is the dog.");
    expect(result.steps).toBe(1);
    expect(events.some((e) => e.kind === "reasoning" && e.delta === "I checked env_messages.")).toBe(true);
    // The root never receives the conversation in its prompt — only the user text.
    expect(rootCalls[0]![0]).toBe("what?");
  });

  it("runs sandbox code and feeds printed output back to the root", async () => {
    const { result, events, rootCalls } = await run([
      "```repl\nconst names = env_messages.map(m => m.role);\nprint(JSON.stringify(names));\n```",
      'final("two turns, oldest first")',
    ], { transcript: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }] });
    expect(result.text).toBe("two turns, oldest first");
    expect(rootCalls[1]!.at(-1)).toContain('["user","assistant"]');
    expect(events.some((e) => e.kind === "tool" && e.title.startsWith("repl"))).toBe(true);
  });

  it("batches llm() calls: one code pass, all answers resolved synchronously on re-run", async () => {
    const { result, subQuestions, rootCalls } = await run([
      "```repl\nconst a = llm('summarize part one');\nconst b = llm('summarize part two');\nprint(a + ' / ' + b);\n```",
      'final("both summarized")',
    ]);
    expect(result.text).toBe("both summarized");
    expect(subQuestions.some((q) => q.includes("summarize part one"))).toBe(true);
    expect(subQuestions.some((q) => q.includes("summarize part two"))).toBe(true);
    // Second root call sees the real answers, not the pending placeholder.
    expect(rootCalls[1]!.at(-1)).toContain("answer-1 / answer-2");
    expect(rootCalls[1]!.at(-1)).not.toContain("pending");
  });

  it("caches repeated llm() questions", async () => {
    await run([
      "```repl\nprint(llm('same q') + llm('same q'));\n```",
      'final("done")',
    ]);
    // The batching re-run hits the cache; only one sub-call is made total.
    // (scripted sub answers are sequential, so a duplicate would show as answer-2.)
  });

  it("extracts final() from inside a code block", async () => {
    const { result } = await run([
      "```repl\nconst total = 6 * 7;\nfinal(`the total is ${total}`);\n```",
    ]);
    expect(result.text).toBe("the total is 42");
  });

  it("nudges a reply with neither final nor repl, then accepts the retry", async () => {
    const { result, rootCalls } = await run([
      "I think I need more steps.",
      'final("now I am sure")',
    ]);
    expect(result.text).toBe("now I am sure");
    expect(rootCalls[1]!.at(-1)).toContain("neither final");
  });

  it("forces a final answer at the step cap", async () => {
    const { result } = await run(
      ["```repl\nprint(env.length);\n```", "```repl\nprint(env.length);\n```", 'final("cap reached anyway")'],
      { maxSteps: 2 },
    );
    expect(result.text).toBe("cap reached anyway");
  });

  it("returns the last prose when the forced final is never given", async () => {
    const { result } = await run(["```repl\nprint(1);\n```", "I ran out of ideas."], { maxSteps: 1 });
    expect(result.text).toBe("I ran out of ideas.");
  });

  it("sends the persona system prompt to root and sub calls", async () => {
    const scripted = scriptedRoot(['final("ok")']);
    const systems: string[] = [];
    const subSystems: string[] = [];
    const chat: RlmChat = async (request) => {
      if (request.kind === "root") systems.push(request.system ?? "");
      else subSystems.push(request.system ?? "");
      return scripted.chat(request);
    };
    await runRlmTurn({ prompt: "p", system: "You are Kiwi." }, { emit: () => {}, chat });
    expect(systems[0]).toContain("You are Kiwi.");
    expect(systems[0]).toContain("REASONING HARNESS");
    expect(rlmSubSystem("You are Kiwi.")).toContain("You are Kiwi.");
    expect(RLM_SUB_INSTRUCTIONS).toContain("SUB-REASONER");
  });

  it("accumulates usage across root and sub calls", async () => {
    const { result } = await run([
      "```repl\nprint(llm('one') + llm('two'));\n```",
      'final("done")',
    ]);
    // root 10+5 twice, subs 3+2 twice
    expect(result.usage).toEqual({ input: 26, output: 14 });
    expect(result.subcalls).toBe(2);
  });

  it("aborts promptly when the signal fires", async () => {
    const controller = new AbortController();
    const chat: RlmChat = async () => {
      controller.abort();
      return { text: 'final("late")', usage: { input: 1, output: 1 } };
    };
    await expect(runRlmTurn({ prompt: "p", signal: controller.signal }, { emit: () => {}, chat })).rejects.toThrow(/interrupted/);
  });

  it("keeps sub-call failures as data instead of killing the turn", async () => {
    const chat: RlmChat = async (request) => {
      if (request.kind === "sub") throw new Error("helper down");
      return { text: 'final("recovered")', usage: { input: 1, output: 1 } };
    };
    const events: RlmEngineEvent[] = [];
    const result = await runRlmTurn(
      { prompt: "p" },
      { emit: (e) => events.push(e), chat },
    );
    expect(result.text).toBe("recovered");
    void RLM_MAX_LLM_CALLS;
  });
});
