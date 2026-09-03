// Characterization of the context handoff as it behaves TODAY, including its
// defects. Assertions named `DEFECT:` describe behaviour we intend to
// change; they exist so the change is visible in a diff, not so it is
// preserved. Each is paired with an `it.todo` naming the replacement.
import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { HISTORY_MESSAGE_LIMIT, prepareTurnContext, type PrepareTurnContextInput } from "./prepare-turn.ts";

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
    replaysNatively: false,
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

  it("DEFECT: keeps a flat tail of 40 messages regardless of their size or the model's window", () => {
    const many = Array.from({ length: 100 }, (_, i) => text(i % 2 === 0 ? "user" : "bot", `turn ${i}`));
    const out = prepare({ activeMessages: many, rewound: true });
    expect(out.transcript).toHaveLength(HISTORY_MESSAGE_LIMIT);
    expect(out.transcript[0].text).toBe("turn 60");
    // Size is not consulted at all: one enormous message counts the same as
    // one word, so 40 long turns can overflow a small model's window while
    // 40 short turns waste a large one.
    const huge = Array.from({ length: 100 }, (_, i) => text(i % 2 === 0 ? "user" : "bot", "x".repeat(20_000)));
    expect(prepare({ activeMessages: huge, rewound: true }).transcript).toHaveLength(HISTORY_MESSAGE_LIMIT);
  });

  it.todo("sizes history against the target model's context window, with no fixed message count");

  it("DEFECT: drops every non-text message, so tool activity never survives a handoff", () => {
    const out = prepare({
      activeMessages: [
        text("user", "read the config"),
        activity("tool: Read"),
        activity("tool: Edit"),
        text("bot", "done"),
      ],
      rewound: true,
    });
    // The model is told the file was read and edited only if the assistant
    // happened to say so in prose. The tool record itself is gone.
    expect(out.transcript.map((t) => t.text)).toEqual(["read the config", "done"]);
  });

  it.todo("carries bounded portable tool observations across an engine switch");
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

  it("DEFECT: sends the whole branch TWICE to a transcript-replay engine that is not `grok`", () => {
    // `server/index.ts` decides this with `driverKind === "grok"`, but
    // `openai-compat` and `minimax` are also createOpenAIChatRuntime drivers,
    // and that runtime always prepends `turn.transcript` before `turn.text`.
    // So for those engines the branch arrives inlined in the prompt AND as
    // structured messages.
    const out = prepare({ activeMessages: history, rewound: true, replaysNatively: false });
    expect(out.transcript.map((t) => t.text)).toContain("my dog is Biscuit");
    expect(out.turnText).toContain("User: my dog is Biscuit");
  });

  it("sends it once to `grok`, the one engine the driver-kind test names", () => {
    const out = prepare({ activeMessages: history, rewound: true, replaysNatively: true });
    expect(out.transcript.map((t) => t.text)).toContain("my dog is Biscuit");
    expect(out.turnText).toBe("what now?");
  });

  it.todo("sends history exactly once to every omb-replay engine, not only to grok");

  it("never inlines a replay it has no history for", () => {
    const out = prepare({ activeMessages: [], rewound: true });
    expect(out).toMatchObject({ turnText: "what now?", resume: false });
  });
});
