import { describe, expect, it } from "vitest";
import { replayToolCalls, selectReplay, type ReplayEntry } from "./context-rebuild.ts";
import { isContextMessage } from "./delta-context.ts";
import type { Message } from "./store.ts";
import { toolDetailPreview } from "./tool-summary.ts";

import { buildTurnContext, engineIsFresh, buildRecoveryText } from "./turn-context.ts";

const transcript = [
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
];

describe("buildTurnContext", () => {
  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound");
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("never wraps for native-replay drivers — they get history via SendTurnInput.transcript", () => {
    for (const flags of [
      { rewound: true, fresh: false, externallyUpdated: false },
      { rewound: false, fresh: true, externallyUpdated: false },
      { rewound: false, fresh: false, externallyUpdated: true },
    ]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toBe("hi");
      expect(out.resume).toBe(false);
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });

  it("replays an out-of-band teammate result before the next user turn", () => {
    const updated = [
      ...transcript,
      { role: "assistant" as const, text: "@Worker replied to the delegated task:\n\nfinished the report" },
    ];
    const out = buildTurnContext({
      text: "what did they find?",
      transcript: updated,
      rewound: false,
      fresh: false,
      externallyUpdated: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("received an update outside your provider session");
    expect(out.turnText).toContain("@Worker replied to the delegated task");
    expect(out.turnText.endsWith("what did they find?")).toBe(true);
  });
});

describe("engineIsFresh", () => {
  const withUser = transcript;
  const greetingOnly = [{ role: "assistant" as const, text: "Hey — I'm Wren. Nice to meet you." }];

  it("is false when the same instance ran the last turn and has a cursor", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
  });

  it("is true when the same instance ran last but there is no cursor to resume", () => {
    expect(engineIsFresh({ instanceId: "pi", lastInstanceId: "pi", resumeCursors: {}, transcript: withUser })).toBe(true);
  });

  it("is true when another instance ran the last turn — even if this one has an older cursor", () => {
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: "antigravity", resumeCursors: { claude: "old", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: {}, transcript: [] })).toBe(false);
  });

  it("legacy task without lastInstanceId: trusts a lone cursor for this instance, replays otherwise", () => {
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    expect(
      engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });
});

describe("buildRecoveryText", () => {
  it("replays the active branch and ends in the user's message, once", () => {
    const text = buildRecoveryText({
      text: "what now?",
      transcript: [
        { role: "user", text: "my dog is Biscuit" },
        { role: "assistant", text: "Noted." },
      ],
    });
    expect(text).toContain("could not be resumed");
    expect(text).toContain("User: my dog is Biscuit");
    expect(text).toContain("Assistant: Noted.");
    expect(text?.endsWith("what now?")).toBe(true);
    expect(text?.match(/what now\?/g)).toHaveLength(1);
  });

  it("is undefined when there is nothing to replay", () => {
    expect(buildRecoveryText({ text: "hi", transcript: [] })).toBeUndefined();
  });
});

describe("tool history in an inline replay", () => {
  const ON = { replayToolHistory: true };
  const NO_ENV: NodeJS.ProcessEnv = {};
  const said = (id: string, role: Message["role"], text: string): Message => ({ id, role, kind: "text", text, at: 1 });
  const ran = (id: string, name: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
    ({ id, role: "bot", kind: "activity", tool: { name, ok: true, itemId: `item-${id}`, ...tool }, at: 1 });
  // the active branch as the store holds it: what was said, and a row per tool call
  const thread: Message[] = [
    said("u1", "user", "run the tests"),
    ran("t1", "Bash", { summary: "pnpm test", ok: false, output: "RESULT_BODY 3 failed" }),
    // a Read's chip shows no file: it is in the input preview behind the chip
    ran("t2", "Read", { input: toolDetailPreview({ file_path: "server/config.test.ts", limit: 80 }), output: "RESULT_BODY the file" }),
    said("a1", "bot", "They fail in config.test.ts."),
    said("u2", "user", "fix it"),
    ran("t3", "git diff --stat", { summary: "git diff --stat" }),
    said("a2", "bot", "Fixed."),
  ];
  const history: ReplayEntry[] = thread.filter(isContextMessage)
    .map(m => ({ id: m.id, role: m.role === "user" ? "user" : "assistant", text: m.text ?? "" }));
  const plain = history.map(({ role, text }) => ({ role, text }));
  const replay = (settings: { replayToolHistory?: boolean } | undefined, env = NO_ENV) =>
    selectReplay(history, { tools: replayToolCalls(thread, settings, env) });
  const flags = { rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false };
  const rebuilds = [{ rewound: true }, { fresh: true }, { externallyUpdated: true }];
  const conversation = [
    "User: run the tests",
    "Assistant: [ran: Bash: pnpm test — failed]",
    "Assistant: [ran: Read: server/config.test.ts — ok]",
    "Assistant: They fail in config.test.ts.",
    "User: fix it",
    "Assistant: [ran: git diff --stat — ok]",
    "Assistant: Fixed.",
  ].join("\n");

  it("names each earlier tool call, in order, between the messages it ran between", () => {
    for (const rebuild of rebuilds) {
      const out = buildTurnContext({ text: "and now?", transcript: replay(ON).inline, ...flags, ...rebuild });
      expect(out.resume).toBe(false);
      // preamble, the conversation, the closing cue, the new message
      expect(out.turnText.split("\n\n")[1]).toBe(conversation);
      expect(out.turnText.endsWith("and now?")).toBe(true);
      expect(out.turnText).not.toContain("RESULT_BODY");
    }
  });

  it("names them in the replay a lost session is recovered with", () => {
    const text = buildRecoveryText({ text: "and now?", transcript: replay(ON).inline });
    expect(text?.split("\n\n")[1]).toBe(conversation);
    expect(text?.endsWith("and now?")).toBe(true);
  });

  it("is switched on by OMB_REPLAY_TOOL_HISTORY=1 alone", () => {
    const out = buildTurnContext({ text: "and now?", transcript: replay(undefined, { OMB_REPLAY_TOOL_HISTORY: "1" }).inline, ...flags, fresh: true });
    expect(out.turnText.split("\n\n")[1]).toBe(conversation);
  });

  it("with the setting off, every replay is byte-for-byte what it is without tool history", () => {
    for (const settings of [undefined, {}, { replayToolHistory: false }]) {
      const transcript = replay(settings).inline;
      for (const rebuild of rebuilds) {
        const out = buildTurnContext({ text: "and now?", transcript, ...flags, ...rebuild });
        expect(out).toEqual(buildTurnContext({ text: "and now?", transcript: plain, ...flags, ...rebuild }));
        expect(out.turnText).not.toContain("[ran: ");
      }
      expect(buildRecoveryText({ text: "and now?", transcript })).toBe(buildRecoveryText({ text: "and now?", transcript: plain }));
    }
  });

  it("leaves a turn that resumes its session untouched", () => {
    expect(buildTurnContext({ text: "and now?", transcript: replay(ON).inline, ...flags })).toEqual({ turnText: "and now?", resume: true });
  });

  it("leaves natively replaying drivers untouched: no wrapper, and a text-only transcript", () => {
    for (const rebuild of rebuilds) {
      const out = buildTurnContext({ text: "and now?", transcript: replay(ON).inline, ...flags, ...rebuild, replaysNatively: true });
      expect(out).toEqual({ turnText: "and now?", resume: false });
    }
    // what SendTurnInput.transcript carries is the selection's own transcript
    expect(replay(ON).transcript).toEqual(history);
    expect(replay(ON).transcript).toEqual(replay(undefined).transcript);
  });

  it("leaves the fresh-engine decision untouched", () => {
    const cases = [
      { instanceId: "claude", lastInstanceId: "claude", resumeCursors: { claude: "s1" } },
      { instanceId: "pi", lastInstanceId: "pi", resumeCursors: {} },
      { instanceId: "claude", lastInstanceId: "antigravity", resumeCursors: { claude: "old", antigravity: "s2" } },
      { instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1" } },
      { instanceId: "codex", lastInstanceId: undefined, resumeCursors: { claude: "s1" } },
    ];
    for (const input of cases) {
      expect(engineIsFresh({ ...input, transcript: replay(ON).inline })).toBe(engineIsFresh({ ...input, transcript: plain }));
    }
    // a tool line is never a user turn: a greeting plus tool calls is still nothing to join
    const greeted = [{ role: "assistant" as const, text: "Hey — I'm Wren." }, { role: "assistant" as const, text: "[ran: Read — ok]" }];
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: "claude", resumeCursors: { claude: "s1" }, transcript: greeted })).toBe(false);
  });
});
