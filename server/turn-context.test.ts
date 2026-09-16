import { describe, expect, it } from "vitest";

import {
  buildTurnContext,
  engineIsFresh,
  buildRecoveryText,
  formatToolActivityLine,
  selectReplayLines,
  REPLAY_CONTENT_CAP,
  REPLAY_TOOL_LINE_CAP,
  type ReplayCandidate,
} from "./turn-context.ts";

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

describe("selectReplayLines", () => {
  // Regression guard for server/direct-coordination.e2e.test.ts's "rechecks
  // access before replay" case: a naive single shared cap let a chatty
  // turn's tool calls evict older content from the window.
  function content(): ReplayCandidate {
    return { isContent: true, hasTool: false };
  }
  function tool(): ReplayCandidate {
    return { isContent: false, hasTool: true };
  }
  function contentWithTool(): ReplayCandidate {
    // a teammate's returned-report receipt: kind "activity",
    // roomRequest.phase === "result", AND a tool chip, all at once
    return { isContent: true, hasTool: true };
  }
  /** an identifiable tool line, so a test can assert WHICH ones survive a
   * cap, not merely how many. */
  function taggedTool(tag: number): ReplayCandidate & { tag: number } {
    return { isContent: false, hasTool: true, tag };
  }

  it("keeps every content message in the window even with far more than 40 tool lines interleaved", () => {
    const items: ReplayCandidate[] = [];
    for (let i = 0; i < 45; i++) {
      items.push(content());
      // ten tool calls between every pair of content messages — 450 tool
      // lines total, more than ten times REPLAY_TOOL_LINE_CAP, and every
      // one of them strictly between two content messages (inside the
      // window this builds, never trailing after the last one)
      if (i < 44) for (let j = 0; j < 10; j++) items.push(tool());
    }
    const selected = selectReplayLines(items);
    const contentKept = selected.filter((entry) => entry.line === "content");
    // the same 40-message cap the plain text-only transcript has always
    // used — this must not shrink just because tool lines exist
    expect(contentKept).toHaveLength(REPLAY_CONTENT_CAP);
    expect(contentKept.every((entry) => entry.item.isContent)).toBe(true);
    const toolKept = selected.filter((entry) => entry.line === "tool");
    expect(toolKept.length).toBeLessThanOrEqual(REPLAY_TOOL_LINE_CAP);
  });

  it("never downgrades a message that is both content and tool-bearing into a tool line", () => {
    // this exact shape — isContent AND hasTool together — is what broke the
    // e2e test: the receipt was still inside the window, but a naive check
    // of "hasTool" first rendered it as a throwaway tool line instead of
    // the actual returned report.
    const items = [content(), contentWithTool(), content()];
    const selected = selectReplayLines(items);
    expect(selected.map((entry) => entry.line)).toEqual(["content", "content", "content"]);
    expect(selected[1]!.item).toBe(items[1]);
  });

  it("keeps tool lines only strictly between the first and last kept content messages", () => {
    const items: ReplayCandidate[] = [
      tool(), tool(), // before the window content defines — dropped
      content(),
      tool(), tool(), tool(), // inside the window — kept
      content(),
      tool(), tool(), // after the window — for instance the very turn
      // about to be replayed — dropped, however recent
    ];
    const selected = selectReplayLines(items);
    expect(selected.filter((entry) => entry.line === "tool")).toHaveLength(3);
    expect(selected).toHaveLength(5); // 2 content + 3 tool
  });

  // The bound this round adds: tool lines were already capped overall, but
  // the window they were drawn from used to run to the end of the eligible
  // messages instead of stopping at the last kept content message — a
  // tool-heavy thread could still balloon the replayed prompt with a long
  // tail of trailing activity. Both defenses are exercised together here.
  it("caps tool lines inside the window at REPLAY_TOOL_LINE_CAP, keeping the most recent and dropping the oldest", () => {
    const items: ReplayCandidate[] = [
      content(),
      // far more than REPLAY_TOOL_LINE_CAP (20) tool lines, all strictly
      // inside the window
      ...Array.from({ length: 30 }, (_, i) => taggedTool(i)),
      content(),
    ];
    const selected = selectReplayLines(items);
    const toolKept = selected.filter((entry) => entry.line === "tool");
    expect(toolKept).toHaveLength(REPLAY_TOOL_LINE_CAP);
    // tags 10..29 — the most recent 20 — not 0..19, the oldest
    expect(toolKept.map((entry) => (entry.item as unknown as { tag: number }).tag)).toEqual(
      Array.from({ length: REPLAY_TOOL_LINE_CAP }, (_, i) => i + (30 - REPLAY_TOOL_LINE_CAP)),
    );
    // content is never displaced by the cap on tool lines
    expect(selected.filter((entry) => entry.line === "content")).toHaveLength(2);
  });

  it("preserves original chronological order when merging content and tool lines", () => {
    const items = [content(), tool(), tool(), content()];
    const selected = selectReplayLines(items);
    expect(selected.map((entry) => entry.item)).toEqual(items);
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
