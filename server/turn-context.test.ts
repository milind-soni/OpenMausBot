import { describe, expect, it } from "vitest";

import { buildTurnContext, engineIsFresh, buildRecoveryText, formatToolActivityLine } from "./turn-context.ts";

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
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
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

describe("formatToolActivityLine", () => {
  it("formats a successful tool call", () => {
    expect(formatToolActivityLine({ name: "Read", ok: true })).toBe("[ran: read — ok]");
  });

  it("formats a failed tool call", () => {
    expect(formatToolActivityLine({ name: "Bash", ok: false })).toBe("[ran: bash — failed]");
  });

  it("treats a missing ok as success — activity chips default to ok", () => {
    expect(formatToolActivityLine({ name: "Grep" })).toBe("[ran: grep — ok]");
  });

  it("truncates a long tool name instead of growing the replay without bound", () => {
    const line = formatToolActivityLine({ name: "x".repeat(200), ok: true });
    expect(line.length).toBe(120);
    expect(line.endsWith("…")).toBe(true);
    expect(line.startsWith("[ran: " + "x".repeat(10))).toBe(true);
  });
});

describe("buildTurnContext with tool-line entries in the transcript", () => {
  it("carries tool lines into an inline replay", () => {
    const withTools = [
      { role: "user" as const, text: "read the config and tell me the port" },
      { role: "assistant" as const, text: formatToolActivityLine({ name: "Read", ok: true }) },
      { role: "assistant" as const, text: "The port is 3000." },
    ];
    const out = buildTurnContext({ text: "thanks", transcript: withTools, rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("[ran: read — ok]");
    expect(out.turnText).toContain("The port is 3000.");
  });

  it("a resumed (non-replay) turn is unchanged by tool lines in the transcript", () => {
    const withTools = [
      { role: "user" as const, text: "read the config" },
      { role: "assistant" as const, text: formatToolActivityLine({ name: "Read", ok: true }) },
    ];
    const out = buildTurnContext({ text: "thanks", transcript: withTools, rewound: false, fresh: false, externallyUpdated: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "thanks", resume: true });
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
    // the user's bug: claude had a session from days ago, antigravity took the
    // latest turn, switching back to claude must NOT resume the stale session
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
    // one cursor, ours — pre-upgrade single-engine thread, keep resuming
    expect(engineIsFresh({ instanceId: "claude", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    // one cursor, someone else's — we never ran here
    expect(engineIsFresh({ instanceId: "codex", lastInstanceId: undefined, resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    // two cursors — can't tell who ran last; replaying is the safe side
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
