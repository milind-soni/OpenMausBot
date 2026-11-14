import type { DriverKind } from "./contracts.ts";
import { replaysTranscriptNatively } from "./runtime/capabilities.ts";

export function replaysNatively(kind: DriverKind): boolean {
  return replaysTranscriptNatively(kind);
}

// rewound and fresh coincide today but stay distinct: rewound also invalidates other instances' cursors.
export interface TurnContextInput {
  text: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  rewound: boolean;
  fresh: boolean;
  externallyUpdated: boolean;
  replaysNatively: boolean;
}

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
