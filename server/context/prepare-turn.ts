// The one place a turn's model-facing context is decided: which history the
// model sees, how much of it fits, whether the native session survives, and
// whether history rides inline or in a structured channel.
//
// See docs/superpowers/plans/2026-09-03-hybrid-context-runtime.md.
import type { ModelCatalog } from "../contracts.ts";
import type { Message } from "../store.ts";
import { promptWithReply } from "../replies.ts";
import { engineIsFresh } from "../turn-context.ts";
import { contextLimitsFor, estimateContextTokens, makeContextBudget } from "./budget.ts";
import { projectActiveBranch } from "./project.ts";
import { renderReplayPrompt, type ReplayReason } from "./render.ts";
import type { ContextOwnership, ModelContextItem, TurnContextPlan } from "./types.ts";

/** Prior turns as transcript-replay drivers receive them. */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/** The parts of the system prompt that are fixed prose rather than user
 * content: the computer-mode briefings and tool guidance assembled at the
 * dispatch site. Those depend on async provisioning that has not happened
 * when this decision is made — and the decision must be made first, or an
 * external result landing mid-setup corrupts it — so they are allowed for
 * rather than measured. The budget's safety reserve covers the difference. */
export const SYSTEM_PROSE_ALLOWANCE_TOKENS = 700;

/** MEMORY.md is hard-capped at MEMORY_MAX_BYTES (24,000), so its worst case
 * is known without reading it. Reserving the cap rather than the actual size
 * keeps this decision free of file I/O and side effects — `ensureWorkspace`
 * runs later, during setup — and errs toward reserving too much, which costs
 * a little history rather than overflowing the window. */
export const MEMORY_RESERVE_TOKENS = 8_000;

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
  /** the part of the system prompt already known here — the persona. */
  systemText?: string;
  /** bounded-but-unread system content: the memory block (capped) and the
   * skills instructions. Reserved rather than measured because the workspace
   * is provisioned during setup, after this decision is made. */
  reservedSystemTokens?: number;
  /** measured or estimated cost of the tool schemas this turn mounts. */
  toolTokens?: number;
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
  const budget = makeContextBudget({
    limits,
    systemTokens:
      estimateContextTokens(input.systemText ?? "") +
      (input.reservedSystemTokens ?? 0) +
      SYSTEM_PROSE_ALLOWANCE_TOKENS,
    toolTokens: input.toolTokens ?? 0,
  });

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
