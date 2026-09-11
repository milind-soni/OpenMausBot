// Building the text a driver actually receives. Three situations force an
// inline replay of the active branch: a rewind (the visible branch changed),
// a fresh engine (this instance has no session here — the user switched the
// bot's model mid-thread), and an update appended outside the provider's own
// turn. The first two coincide today but are distinct markers on purpose:
// rewound also invalidates OTHER instances' cursors, fresh does not.
export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /** a message was appended outside the provider's own turn (for example,
   * a delegated teammate returned a result). Native resume state cannot
   * contain it, so the active branch must be replayed once. */
  externallyUpdated: boolean;
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean;
}

/** Does this engine need the thread replayed to it? True when a DIFFERENT
 * instance ran the last turn here — a cursor of our own is not enough,
 * because it only proves we once had a session covering some prefix of the
 * thread; every turn another engine took since is missing from it. Tasks
 * from before `lastInstanceId` existed fall back to the cursor map: a lone
 * cursor that is ours means a single-engine thread we can keep resuming;
 * anything else is ambiguous, and replaying is the safe side of ambiguous.
 * Gated on a prior USER turn: a new bot's thread is seeded with its own
 * greeting, and that alone is nothing to join. */
export function engineIsFresh(input: {
  instanceId: string;
  lastInstanceId: string | undefined;
  resumeCursors: Record<string, unknown>;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): boolean {
  const { instanceId, lastInstanceId, resumeCursors, transcript } = input;
  if (!transcript.some((m) => m.role === "user")) return false;
  if (lastInstanceId !== undefined) return lastInstanceId !== instanceId || resumeCursors[instanceId] === undefined;
  const cursorIds = Object.keys(resumeCursors);
  return !(cursorIds.length === 1 && cursorIds[0] === instanceId);
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";
const EXTERNAL_UPDATE_PREAMBLE =
  "[This conversation received an update outside your provider session. The complete current history follows so you can use that update in your next response:]";

const RECOVERED_PREAMBLE =
  "[Your previous session for this conversation could not be resumed, so this is a new session. The conversation so far:]";

/** The turn a cursor-resuming driver falls back to when the provider refuses
 * its session before reading the prompt (server/resume-recovery.ts): the
 * active branch replayed inline, ending in the user's message. Undefined
 * when there is nothing to replay — the bare text is then the whole turn. */
export function buildRecoveryText(input: {
  text: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): string | undefined {
  if (input.transcript.length === 0) return undefined;
  return [
    RECOVERED_PREAMBLE,
    "",
    ...input.transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
    "",
    "[Now reply to the user's latest message:]",
    "",
    input.text,
  ].join("\n");
}

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, transcript, rewound, fresh, externallyUpdated, replaysNatively } = input;
  const resume = !rewound && !fresh && !externallyUpdated;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  if (!replay) return { turnText: text, resume };
  return {
    turnText: [
      rewound ? REWOUND_PREAMBLE : externallyUpdated ? EXTERNAL_UPDATE_PREAMBLE : FRESH_PREAMBLE,
      "",
      ...transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
      "",
      "[Now reply to the user's latest message:]",
      "",
      text,
    ].join("\n"),
    resume,
  };
}
