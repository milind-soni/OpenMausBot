// Characterization of the context handoff as it behaves TODAY, including its
// defects. Assertions named `DEFECT:` describe behaviour we intend to
// change; they exist so the change is visible in a diff, not so it is
// preserved. Each is paired with an `it.todo` naming the replacement.
import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { prepareTurnContext, type PrepareTurnContextInput } from "./prepare-turn.ts";

let seq = 0;
const text = (role: Message["role"], body: string, extra: Partial<Message> = {}): Message => ({
  id: `m${(seq += 1)}`,
  at: seq,
  role,
  kind: "text",
  text: body,
  ...extra,
});
const activity = (name: string, extra: Partial<Message> = {}): Message => ({
  id: `m${(seq += 1)}`,
  at: seq,
  role: "bot",
  kind: "activity",
  tool: { name, ok: true },
  ...extra,
});

const prepare = (over: Partial<PrepareTurnContextInput> = {}) => {
  const active = over.activeMessages ?? [];
  return prepareTurnContext({
    activeMessages: active,
    allMessages: over.allMessages ?? active,
    excludeMessageIds: [],
    text: "what now?",
    userName: "Omkar",
    rewound: false,
    externallyUpdated: false,
    instanceId: "claude",
    lastInstanceId: "claude",
    resumeCursors: { claude: "s1" },
    ownership: "vendor-session",
    ...over,
  });
};

describe("prepareTurnContext — history projection", () => {
  it("replays settled text turns from the active branch, oldest first", () => {
    const out = prepare({
      activeMessages: [text("user", "my dog is Biscuit"), text("bot", "Noted — Biscuit.")],
      rewound: true,
    });
    expect(out.transcript).toEqual([
      { role: "user", text: "my dog is Biscuit" },
      { role: "assistant", text: "Noted — Biscuit." },
    ]);
  });

  it("excludes the ids the caller asked to withhold", () => {
    const current = text("user", "the message being sent now");
    const out = prepare({
      activeMessages: [text("user", "earlier"), current],
      excludeMessageIds: [current.id],
      rewound: true,
    });
    expect(out.transcript.map((t) => t.text)).toEqual(["earlier"]);
  });

  it("attributes a flat reply by quoting its target, resolved across a fork", () => {
    const quoted = text("bot", "the deploy finished at 14:02");
    const replying = text("user", "which region?", { replyToId: quoted.id });
    const out = prepare({
      // `quoted` is deliberately absent from the active branch: a flat reply
      // may point across a fork, and its target resolves from full storage.
      activeMessages: [replying],
      allMessages: [quoted, replying],
      rewound: true,
    });
    expect(out.transcript[0].text).toContain("[replying to Assistant:");
    expect(out.transcript[0].text).toContain("the deploy finished at 14:02");
    expect(out.transcript[0].text).toContain("which region?");
  });

  it("sizes history against the target model's window, with no fixed message count", () => {
    // Was a defect: a flat `.slice(-40)` that never consulted message size
    // or the model, so 40 long turns overflowed a small window while 40
    // short ones wasted a large one.
    const many = Array.from({ length: 100 }, (_, i) => text(i % 2 === 0 ? "user" : "bot", `turn ${i}`));
    expect(prepare({ activeMessages: many, rewound: true, model: "claude-opus-5" }).transcript.length)
      .toBeGreaterThan(40);

    // and size IS consulted now: the same count of enormous turns does not fit
    const huge = Array.from({ length: 100 }, (_, i) => text(i % 2 === 0 ? "user" : "bot", "x".repeat(40_000)));
    const clipped = prepare({ activeMessages: huge, rewound: true, model: "ollama/qwen3:8b" });
    expect(clipped.transcript.length).toBeLessThan(100);
    expect(clipped.plan.diagnostics.clipped).toBe(true);
  });

  it("gives a small model less of the same branch than a large one", () => {
    // sized against the real budget: 40% of a 32k window is 12,800 tokens,
    // about 51k characters, so the fixture has to exceed that to bite
    const many = Array.from({ length: 200 }, (_, i) =>
      text(i % 2 === 0 ? "user" : "bot", `turn ${i}: ${"detail ".repeat(120)}`));
    const small = prepare({ activeMessages: many, rewound: true, model: "ollama/qwen3:8b" });
    const large = prepare({ activeMessages: many, rewound: true, model: "gemini-3.6-flash" });
    expect(small.transcript.length).toBeLessThan(large.transcript.length);
  });

  it("carries tool observations across a handoff, which the old transcript dropped", () => {
    const out = prepare({
      activeMessages: [
        text("user", "read the config"),
        activity("tool: Read"),
        activity("tool: Edit"),
        text("bot", "done"),
      ],
      rewound: true,
      model: "claude-opus-5",
    });
    const joined = out.transcript.map((t) => t.text).join("\n");
    expect(joined).toContain("tool: Read");
    expect(joined).toContain("tool: Edit");
    expect(out.plan.messages.filter((m) => m.kind === "tool-observation")).toHaveLength(2);
  });
});

describe("prepareTurnContext — resume and replay", () => {
  const history = [text("user", "my dog is Biscuit"), text("bot", "Noted — Biscuit.")];

  it("passes the prompt through untouched on a plain resumed turn", () => {
    const out = prepare({ activeMessages: history });
    expect(out).toMatchObject({ turnText: "what now?", resume: true, fresh: false });
  });

  it("replays inline on rewind, on a fresh engine, and on an external update", () => {
    for (const flags of [
      { rewound: true },
      { lastInstanceId: "codex", resumeCursors: { codex: "s2" } },
      { externallyUpdated: true },
    ]) {
      const out = prepare({ activeMessages: history, ...flags });
      expect(out.resume).toBe(false);
      expect(out.turnText).toContain("User: my dog is Biscuit");
      expect(out.turnText.endsWith("what now?")).toBe(true);
    }
  });

  it("wraps the current prompt with its reply quote exactly once", () => {
    const quoted = text("bot", "the deploy finished at 14:02");
    const out = prepare({ activeMessages: history, allMessages: [...history, quoted], replyTo: quoted });
    expect(out.turnText.match(/--- quoted excerpt ---/g)).toHaveLength(1);
    expect(out.turnText.endsWith("what now?")).toBe(true);
  });

  it("sends history exactly once to an omb-replay engine, whatever its driver kind", () => {
    // Was a defect: dispatch decided this with `driverKind === "grok"`, so
    // openai-compat and minimax — the same createOpenAIChatRuntime, which
    // always prepends `turn.transcript` before `turn.text` — received the
    // branch inlined in the prompt AND as structured messages. Ownership is
    // now declared by the driver, so all three behave identically.
    for (const flags of [{ rewound: true }, { externallyUpdated: true }]) {
      const out = prepare({ activeMessages: history, ownership: "omb-replay", ...flags });
      expect(out.transcript.map((t) => t.text)).toContain("my dog is Biscuit");
      expect(out.turnText).toBe("what now?");
      expect(out.resume).toBe(false);
    }
  });

  it("still rebuilds inline for a vendor-session engine, which has no structured channel", () => {
    const out = prepare({ activeMessages: history, ownership: "vendor-session", rewound: true });
    expect(out.turnText).toContain("User: my dog is Biscuit");
  });

  it("never inlines a replay it has no history for", () => {
    const out = prepare({ activeMessages: [], rewound: true });
    expect(out).toMatchObject({ turnText: "what now?", resume: false });
  });
});
