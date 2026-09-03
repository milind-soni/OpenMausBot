// The one place a turn's model-facing context is decided: which history the
// model sees, how much of it fits, whether the native session survives, and
// whether history rides inline or in a structured channel.
//
// See docs/superpowers/plans/2026-09-03-hybrid-context-runtime.md.
import type { ModelCatalog } from "../contracts.ts";
import type { Message } from "../store.ts";
import { promptWithReply } from "../replies.ts";
import { engineIsFresh } from "../turn-context.ts";
import { contextLimitsFor, makeContextBudget } from "./budget.ts";
import { projectActiveBranch } from "./project.ts";
import { renderReplayPrompt, type ReplayReason } from "./render.ts";
import type { ContextOwnership, ModelContextItem, TurnContextPlan } from "./types.ts";

/** Prior turns as transcript-replay drivers receive them. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

export interface PrepareTurnContextInput {
  /** the visible conversation, root → leaf (`Store.activePath`). */
  activeMessages: readonly Message[];
  /** every message in the thread; a flat reply may quote across a fork. */
  allMessages: readonly Message[];
  /** ids withheld from history: the current message, plus anything sent by
   * another route. */
  excludeMessageIds: readonly string[];
  /** the user's new message, already skill-expanded by the caller. */
  text: string;
  replyTo?: Message;
  userName: string;
  /** the visible branch changed (edit / version switch). */
  rewound: boolean;
  /** a message landed outside the provider's own turn. */
  externallyUpdated: boolean;
  instanceId: string;
  lastInstanceId: string | undefined;
  resumeCursors: Record<string, unknown>;
  /** who owns this engine's context, declared by its driver. */
  ownership: ContextOwnership;
  /** target model, for sizing. */
  model?: string;
  catalog?: ModelCatalog;
}

export interface PreparedTurnContext {
  /** compatibility projection for drivers still reading `transcript`. */
  transcript: TranscriptTurn[];
  /** the text the driver actually receives. */
  turnText: string;
  /** false when the native session must not be resumed. */
  resume: boolean;
  /** this instance has no usable session on this thread. */
  fresh: boolean;
  /** the authoritative, provider-neutral plan. */
  plan: TurnContextPlan;
}

/** Render one projected item into the flat transcript shape. Tool
 * observations and summaries become assistant turns rather than being
 * dropped — that is how they survive to an engine that reads only
 * `transcript`, which is what used to lose them at every handoff. */
function asTranscriptTurn(item: ModelContextItem): TranscriptTurn {
  switch (item.kind) {
    case "user-text":
      return { role: "user", text: item.text };
    case "assistant-text":
      return { role: "assistant", text: item.speaker ? `${item.speaker}: ${item.text}` : item.text };
    case "summary":
      return { role: "assistant", text: renderReplayPrompt({ reason: "fresh", messages: [item], currentPrompt: "" }).trim() };
    case "tool-observation":
      return { role: "assistant", text: renderReplayPrompt({ reason: "fresh", messages: [item], currentPrompt: "" }).trim() };
  }
}

export function prepareTurnContext(input: PrepareTurnContextInput): PreparedTurnContext {
  const limits = contextLimitsFor(input.model, input.catalog);
  // The share-of-window budget already leaves the rest of the context to
  // the system prompt, the tools, and room to answer, so nothing is
  // subtracted here. See budget.ts.
  const budget = makeContextBudget({ limits });

  const projection = projectActiveBranch({
    activeMessages: input.activeMessages,
    allMessages: input.allMessages,
    excludeMessageIds: input.excludeMessageIds,
    userName: input.userName,
    budget,
  });

  const transcript = projection.messages.map((item) => asTranscriptTurn(item));

  const fresh =
    !input.rewound &&
    !input.externallyUpdated &&
    engineIsFresh({
      instanceId: input.instanceId,
      lastInstanceId: input.lastInstanceId,
      resumeCursors: input.resumeCursors,
      transcript,
    });

  const resume = !input.rewound && !fresh && !input.externallyUpdated;
  const currentPrompt = promptWithReply(input.text, input.replyTo, input.userName);
  const reason: ReplayReason = input.rewound ? "rewound" : input.externallyUpdated ? "external-update" : "fresh";
  const replayPrompt = renderReplayPrompt({ reason, messages: projection.messages, currentPrompt });

  // An omb-replay engine already receives history through its structured
  // channel, so inlining it here as well would send the branch twice.
  const inlineReplay = !resume && input.ownership !== "omb-replay";

  const plan: TurnContextPlan = {
    ownership: input.ownership,
    mode: resume ? "resume-preferred" : "replay-required",
    currentPrompt,
    replayPrompt,
    messages: projection.messages,
    budget,
    diagnostics: {
      sourceItems: projection.sourceItems,
      sentItems: projection.messages.length,
      estimatedInputTokens: projection.estimatedTokens,
      compacted: projection.compacted,
      clipped: projection.clipped,
    },
  };

  return { transcript, turnText: inlineReplay ? replayPrompt : currentPrompt, resume, fresh, plan };
}
