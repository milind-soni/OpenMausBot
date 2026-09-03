// What the context diagnostics event may and may not carry.
//
// This event lands in the canonical NDJSON log — the file people paste into
// bug reports — so the tests that matter most are the ones proving what is
// ABSENT from it.
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { summarizeRuntime } from "../../src/lib/inspector.ts";
import type { Message } from "../store.ts";
import { prepareTurnContext } from "./prepare-turn.ts";

const SECRET = "sk-ant-abcdefghijklmnop0123456789";

let seq = 0;
const text = (role: Message["role"], body: string): Message => ({
  id: `m${(seq += 1)}`,
  at: seq,
  role,
  kind: "text",
  text: body,
});

/** The event exactly as dispatch builds it from an accepted plan. */
const eventFor = (messages: Message[], over: Record<string, unknown> = {}) => {
  const prepared = prepareTurnContext({
    activeMessages: messages,
    allMessages: messages,
    excludeMessageIds: [],
    text: "what now?",
    userName: "Omkar",
    rewound: false,
    externallyUpdated: false,
    instanceId: "i1",
    lastInstanceId: "i1",
    resumeCursors: { i1: "s1" },
    ownership: "vendor-session",
    model: "claude-opus-5",
    ...over,
  });
  const plan = prepared.plan;
  return {
    eventId: "e1",
    provider: "claude",
    threadId: "t1",
    createdAt: new Date().toISOString(),
    type: "context.prepared",
    ownership: plan.ownership,
    mode: plan.mode,
    sourceItems: plan.diagnostics.sourceItems,
    sentItems: plan.diagnostics.sentItems,
    estimatedInputTokens: plan.diagnostics.estimatedInputTokens,
    historyTokens: plan.budget.historyTokens,
    contextWindow: plan.budget.contextWindow,
    limitsSource: plan.budget.limitsSource,
    compacted: plan.diagnostics.compacted,
    clipped: plan.diagnostics.clipped,
  } satisfies Extract<RuntimeEvent, { type: "context.prepared" }>;
};

describe("context.prepared carries metadata and nothing else", () => {
  const history = [
    text("user", `my API key is ${SECRET} and my address is 12 Rowan Lane`),
    text("bot", "Noted — I will not repeat it."),
  ];

  it("leaks no prompt, history, memory, path, or credential", () => {
    const serialized = JSON.stringify(eventFor(history));
    for (const forbidden of [SECRET, "Rowan Lane", "my API key", "what now?", "Noted"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("is made only of counts, enums, and booleans", () => {
    for (const [key, value] of Object.entries(eventFor(history))) {
      if (["eventId", "provider", "threadId", "createdAt", "type", "ownership", "mode", "limitsSource"].includes(key)) {
        expect(typeof value, key).toBe("string");
        continue;
      }
      expect(["number", "boolean"], key).toContain(typeof value);
    }
  });

  it("reports counts that describe the projection honestly", () => {
    const event = eventFor(history);
    expect(event.sourceItems).toBe(2);
    expect(event.sentItems).toBe(2);
    expect(event.estimatedInputTokens).toBeGreaterThan(0);
    expect(event.estimatedInputTokens).toBeLessThanOrEqual(event.historyTokens);
  });

  it("says when the window was guessed rather than declared", () => {
    expect(eventFor(history).limitsSource).toBe("pattern");
    expect(eventFor(history, { model: "nothing-recognisable" }).limitsSource).toBe("default");
  });

  it("reports clipping when history did not fit", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      text(i % 2 === 0 ? "user" : "bot", `turn ${i}: ${"detail ".repeat(120)}`));
    const event = eventFor(many, { model: "ollama/qwen3:8b" });
    expect(event.clipped).toBe(true);
    expect(event.sentItems).toBeLessThan(event.sourceItems);
  });

  it("distinguishes resume from replay", () => {
    expect(eventFor(history).mode).toBe("resume-preferred");
    expect(eventFor(history, { rewound: true }).mode).toBe("replay-required");
  });
});

describe("the inspector row", () => {
  const base = eventFor([]);

  it("names who owns the context in words a person can read", () => {
    const labels = (["vendor-session", "omb-replay", "omb-loop"] as const).map(
      (ownership) => summarizeRuntime({ ...base, ownership } as RuntimeEvent).summary,
    );
    expect(labels[0]).toContain("vendor session");
    expect(labels[1]).toContain("OpenMaus replay");
    expect(labels[2]).toContain("OpenMaus managed");
  });

  it("shows a guessed window, and stays quiet when the driver declared one", () => {
    expect(summarizeRuntime({ ...base, limitsSource: "pattern" } as RuntimeEvent).summary).toContain("window pattern");
    expect(summarizeRuntime({ ...base, limitsSource: "catalog" } as RuntimeEvent).summary).not.toContain("window");
  });

  it("flags compacted and clipped turns", () => {
    const summary = summarizeRuntime({ ...base, compacted: true, clipped: true } as RuntimeEvent).summary;
    expect(summary).toContain("compacted");
    expect(summary).toContain("clipped");
  });
});
