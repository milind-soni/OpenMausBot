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

/** How long a tool line may run before truncation — long enough to keep the
 * tool name and outcome readable, short enough that a chatty summary field
 * cannot let one line dominate the replay. */
const TOOL_LINE_MAX_LENGTH = 120;

/** One compact line standing in for an activity chip (a tool call) in an
 * inline replay — server/index.ts folds one of these into the transcript it
 * hands buildTurnContext for every activity message that carries a `tool`,
 * so an engine joining mid-thread (a fresh engine, a rewind) can see which
 * files were read or which commands ran, not just what was said. Pure and
 * exported so it is unit-testable on its own; the merge into the transcript
 * — and the cap on how many of these accumulate — stays in server/index.ts. */
export function formatToolActivityLine(tool: { name: string; ok?: boolean }): string {
  const line = `[ran: ${tool.name.toLowerCase()} — ${tool.ok === false ? "failed" : "ok"}]`;
  return line.length > TOOL_LINE_MAX_LENGTH ? `${line.slice(0, TOOL_LINE_MAX_LENGTH - 1)}…` : line;
}

/** Content messages selected for a replay window (settled text, or a
 * teammate's returned-report receipt) — the same 40-message cap the
 * text-only transcript has always used. */
export const REPLAY_CONTENT_CAP = 40;
/** Tool-call lines added ON TOP of that window, capped separately so they
 * add context without ever being able to push content out of it. */
export const REPLAY_TOOL_LINE_CAP = 20;

/** What server/index.ts's replay-window builder needs to know about one
 * candidate message, decided upstream from the actual Message shape:
 * `isContent` mirrors the plain text-only transcript's own filter (settled
 * text, or a room-handoff result), `hasTool` says it carries a tool chip
 * worth a compact line. A message can be both — a teammate's returned
 * report is `kind: "activity"` with a `tool` chip AND
 * `roomRequest.phase === "result"` — `isContent` always wins for it (see
 * selectReplayLines). skipTranscript exclusion happens before this: an
 * excluded message should never appear in `messages` at all. */
export interface ReplayCandidate {
  isContent: boolean;
  hasTool: boolean;
}

/** Which of `messages` (in their original order) an inline replay should
 * carry, and how. The full invariant:
 *
 * - Content is selected FIRST and capped at REPLAY_CONTENT_CAP (40),
 *   exactly like the plain text-only transcript — this is the fix for a
 *   real regression: an earlier version ran content and tool lines through
 *   one shared cap, so a turn with many tool calls could evict an older
 *   text reply, or a teammate's returned report, from the replay. Since
 *   this selection is identical to the plain transcript's own, it cannot
 *   regress to contain less content than before.
 * - Tool lines are added only from STRICTLY INSIDE the span content
 *   already covers — between the first and last kept content messages;
 *   never before the first, and never after the last (trailing tool
 *   activity after the newest kept content message — for instance the
 *   very turn about to be replayed — is not "inside the conversation so
 *   far" and is dropped, however recent it is).
 * - Within that window, tool lines are capped SEPARATELY at
 *   REPLAY_TOOL_LINE_CAP (20), keeping the most recent and dropping the
 *   oldest — a tool-heavy thread must not be able to balloon the replayed
 *   prompt. This matters most for quota-switch: the person is switching
 *   engines BECAUSE they ran out of quota, so sending a much larger prompt
 *   to the new engine is the worst possible moment for unbounded growth.
 * - Tool lines never displace, or get mistaken for, content: a message
 *   flagged `isContent` is NEVER also emitted as a tool line, even when
 *   `hasTool` is also true. That exact double nature (a returned-report
 *   receipt is `kind: "activity"` with a `tool` chip AND
 *   `roomRequest.phase === "result"`) is what broke
 *   server/direct-coordination.e2e.test.ts's "rechecks access before
 *   replay" case: the report was still inside the window, but got
 *   rendered as a throwaway tool line instead of the report itself. */
export function selectReplayLines<T extends ReplayCandidate>(
  messages: readonly T[],
): Array<{ item: T; line: "content" | "tool" }> {
  const indexedContent = messages
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.isContent)
    .slice(-REPLAY_CONTENT_CAP);
  // Tool lines may only fill the SPAN content covers — bounded above by the
  // last kept content message's own index, not "to the end of messages".
  // Anything after that last content message (including the very turn
  // about to be replayed) is not "inside the conversation so far" and is
  // dropped, however recent it is.
  const contentWindowStart = indexedContent.length ? indexedContent[0]!.index : messages.length;
  const contentWindowEnd = indexedContent.length ? indexedContent[indexedContent.length - 1]!.index : -1;
  const indexedToolLines = messages
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) =>
      index >= contentWindowStart && index <= contentWindowEnd && item.hasTool && !item.isContent)
    .slice(-REPLAY_TOOL_LINE_CAP);
  return [
    ...indexedContent.map(({ item, index }) => ({ item, index, line: "content" as const })),
    ...indexedToolLines.map(({ item, index }) => ({ item, index, line: "tool" as const })),
  ]
    .sort((a, b) => a.index - b.index)
    .map(({ item, line }) => ({ item, line }));
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
