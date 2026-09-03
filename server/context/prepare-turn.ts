// The one place a turn's model-facing context is decided. Today this is a
// verbatim extraction of what `server/index.ts` did inline: a 40-message
// tail of text turns on the active branch, plus `buildTurnContext`'s
// resume-or-inline-replay decision. Nothing here is new behaviour — the
// point is to give that decision a name and a test seam before it grows a
// token budget, portable tool observations, and durable compaction.
//
// See docs/superpowers/plans/2026-09-03-hybrid-context-runtime.md.
import type { Message } from "../store.ts";
import type { ContextOwnership } from "./types.ts";
import { promptWithReply, transcriptText } from "../replies.ts";
import { buildTurnContext, engineIsFresh } from "../turn-context.ts";

/** Prior turns as transcript-replay drivers receive them. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/** How many settled text messages of history a turn carries. A flat count
 * over messages, blind to how large any of them is and to the target
 * model's actual window — replaced by a token budget in a later task. */
export const HISTORY_MESSAGE_LIMIT = 40;

export interface PrepareTurnContextInput {
  /** the visible conversation, root → leaf (`Store.activePath`). Abandoned
   * forks are already excluded by the caller's branch selection. */
  activeMessages: readonly Message[];
  /** every message in the thread. A flat reply may quote across a fork, so
   * its target is resolved from full storage even though the replay itself
   * stays strictly on the active branch. */
  allMessages: readonly Message[];
  /** ids that must not appear in the replayed history: the user's current
   * message, plus anything the caller sends by another route. */
  excludeMessageIds: readonly string[];
  /** the user's new message, already skill-expanded by the caller. */
  text: string;
  /** the earlier message this turn flatly replies to, if any. */
  replyTo?: Message;
  /** what to call the human in replayed attributions. */
  userName: string;
  /** the visible branch changed (edit / version switch). */
  rewound: boolean;
  /** a message landed outside the provider's own turn (a delegated result). */
  externallyUpdated: boolean;
  instanceId: string;
  lastInstanceId: string | undefined;
  resumeCursors: Record<string, unknown>;
  /** who owns this engine's context, declared by its driver. An
   * `omb-replay` engine receives history through the structured channel, so
   * inlining it into the prompt as well sends the branch twice — which is
   * what testing `driverKind === "grok"` here used to do to every other
   * driver built on the same runtime. */
  ownership: ContextOwnership;
}

export interface PreparedTurnContext {
  /** structured history for transcript-replay drivers. */
  transcript: TranscriptTurn[];
  /** the text the driver actually receives. */
  turnText: string;
  /** false when the native session must not be resumed. */
  resume: boolean;
  /** this instance has no usable session on this thread. */
  fresh: boolean;
}

/** Project the active branch and decide resume-vs-replay for one turn. */
export function prepareTurnContext(input: PrepareTurnContextInput): PreparedTurnContext {
  const skip = new Set<string>(input.excludeMessageIds);
  const messagesById = new Map(input.allMessages.map((message) => [message.id, message]));
  const transcript: TranscriptTurn[] = input.activeMessages
    .filter((m) => m.kind === "text" && m.text && !skip.has(m.id))
    .slice(-HISTORY_MESSAGE_LIMIT)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      text: transcriptText(m, messagesById, input.userName),
    }));

  const fresh =
    !input.rewound &&
    !input.externallyUpdated &&
    engineIsFresh({
      instanceId: input.instanceId,
      lastInstanceId: input.lastInstanceId,
      resumeCursors: input.resumeCursors,
      transcript,
    });

  const { turnText, resume } = buildTurnContext({
    text: promptWithReply(input.text, input.replyTo, input.userName),
    transcript,
    rewound: input.rewound,
    fresh,
    externallyUpdated: input.externallyUpdated,
    // vendor-session and omb-loop engines have no structured history
    // channel today, so an invalidated turn is rebuilt inline for them.
    replaysNatively: input.ownership === "omb-replay",
  });

  return { transcript, turnText, resume, fresh };
}
