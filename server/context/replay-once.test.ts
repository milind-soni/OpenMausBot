// The duplicate-history regression, asserted across the seam it crossed.
//
// prepareTurnContext decides what dispatch hands a driver; chatMessagesFor
// is what the OpenAI-chat runtime then sends. Testing either alone misses
// the bug: each was locally correct, and the branch was sent twice only
// because dispatch inlined a replay the runtime was already going to send.
import { describe, expect, it } from "vitest";

import { chatMessagesFor } from "../drivers/openai-chat.ts";
import type { Message } from "../store.ts";
import { prepareTurnContext } from "./prepare-turn.ts";
import type { ContextOwnership } from "./types.ts";

let seq = 0;
const msg = (role: Message["role"], text: string): Message => ({
  id: `m${(seq += 1)}`,
  at: seq,
  role,
  kind: "text",
  text,
});

const SECRET = "my dog is named Biscuit";
const history = [msg("user", SECRET), msg("bot", "Noted — Biscuit.")];

/** One full turn: project the branch, then build what the provider gets. */
const provider = (ownership: ContextOwnership, invalidation: Record<string, boolean>) => {
  const prepared = prepareTurnContext({
    activeMessages: history,
    allMessages: history,
    excludeMessageIds: [],
    text: "what now?",
    userName: "Omkar",
    rewound: false,
    externallyUpdated: false,
    instanceId: "i1",
    lastInstanceId: "i1",
    resumeCursors: { i1: "s1" },
    ownership,
    ...invalidation,
  });
  return chatMessagesFor({
    threadId: "t1",
    text: prepared.turnText,
    transcript: prepared.transcript,
    system: "You are Wren.",
  });
};

/** How many messages repeat the same earlier turn back to the model. */
const copiesOf = (messages: Array<{ content: string }>, needle: string) =>
  messages.filter((m) => m.content.includes(needle)).length;

describe("an omb-replay engine receives history exactly once", () => {
  // Every path that invalidates a native session. Each one used to inline a
  // replay on top of the structured transcript.
  const INVALIDATIONS = [
    ["rewind (edit or version switch)", { rewound: true }],
    ["external update (a delegated result landed)", { externallyUpdated: true }],
  ] as const;

  for (const [label, invalidation] of INVALIDATIONS) {
    it(`sends one copy on ${label}`, () => {
      const messages = provider("omb-replay", { ...invalidation });
      expect(copiesOf(messages, SECRET)).toBe(1);
      // and it is the structured turn, not the prompt
      expect(messages.at(-1)).toEqual({ role: "user", content: "what now?" });
      expect(messages[1]).toEqual({ role: "user", content: SECRET });
    });
  }

  it("sends one copy on an engine switch, where the runtime has no session", () => {
    const messages = provider("omb-replay", {});
    expect(copiesOf(messages, SECRET)).toBe(1);
  });

  it("keeps the system prompt first and unduplicated", () => {
    const messages = provider("omb-replay", { rewound: true });
    expect(messages[0]).toEqual({ role: "system", content: "You are Wren." });
    expect(copiesOf(messages, "You are Wren.")).toBe(1);
  });

  it("a vendor-session engine still gets its inline rebuild — it has no other channel", () => {
    const prepared = prepareTurnContext({
      activeMessages: history,
      allMessages: history,
      excludeMessageIds: [],
      text: "what now?",
      userName: "Omkar",
      rewound: true,
      externallyUpdated: false,
      instanceId: "i1",
      lastInstanceId: "i1",
      resumeCursors: { i1: "s1" },
      ownership: "vendor-session",
    });
    expect(prepared.turnText).toContain(SECRET);
    expect(prepared.resume).toBe(false);
  });
});
