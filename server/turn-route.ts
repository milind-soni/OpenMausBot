import type { ModelCatalog, ModelSelection } from "./contracts.ts";
import { isConversational, type ReplyStyle } from "../shared/reply-style.ts";
import type { EffortLevel } from "../shared/wire.ts";

export type TurnTier = "simple" | "complex";

export interface TurnSignals {
  text: string;
  /** Images or files sent with the message. */
  attachments: number;
  /** The previous bot turn used tools (activity rows after the last ask). */
  priorTurnUsedTools: boolean;
}

// English only: a message in another language falls back on the other signals.
const ACTION = /\b(build|fix|debug|implement|refactor|write|create|generate|deploy|install|run|test|search|find|look up|browse|open|edit|change|update|delete|remove|rename|move|migrate|analy[sz]e|review|compare|research|summari[sz]e|translate|draft|send|email|schedule|book|download|upload|scrape|clone|commit|push|merge|plan|design|calculate|convert)\b/i;
const CODE = /```|`[^`\n]+`|\b(function|const|let|class|import|def|SELECT|FROM)\b|[{};]\s*$|\w+\.(ts|tsx|js|py|go|rs|json|md|sh|yml|yaml|sql|css|html)\b|https?:\/\/|(^|\s)[~.]?\/[\w.-]+\//m;
const CONTINUE = /^(yes|yep|yeah|ok(ay)?|sure|go( ahead| on)?|do it|continue|proceed|please do|sounds good|retry|try again)\b/i;
const ACK = /^(thanks|thank you|thx|ty|cool|nice|great|perfect|awesome|got it|lol|haha)\b[\s!.]*$/i;
const SIMPLE_CHARS = 280;
const SIMPLE_LINES = 4;
const QUICK_CONTEXT_SHARE = 0.6;

export function classifyTurn(signals: TurnSignals): TurnTier {
  const text = signals.text.trim();
  if (!text) return "complex";
  if (signals.attachments > 0) return "complex";
  if (text.length > SIMPLE_CHARS || text.split("\n").length > SIMPLE_LINES) return "complex";
  if (CODE.test(text)) return "complex";
  if (ACTION.test(text)) return "complex";
  if (CONTINUE.test(text)) return "complex";
  if (signals.priorTurnUsedTools && !ACK.test(text)) return "complex";
  if ((text.match(/\?/g) ?? []).length > 2) return "complex";
  return "simple";
}

const FAST = /(^|[-_/. ])(haiku|flash|mini|nano|lite|small|fast|instant|spark|turbo|air)(?=$|[-_/. \d])/i;

/** Same upstream provider only; among several, the first listed wins since engines list their newest first. */
export function fastModelFor(catalog: ModelCatalog | undefined, current: string, refused: ReadonlySet<string> = new Set()): string | undefined {
  if (!catalog) return undefined;
  if (FAST.test(current)) return current;
  const provider = catalog.options.find((option) => option.id === current)?.provider;
  const pick = catalog.options.find((option) => !option.custom && !refused.has(option.id) &&
    FAST.test(option.id) && (option.provider ?? undefined) === (provider ?? undefined));
  return pick?.id;
}

export interface RouteInput {
  conversational: boolean;
  /** false when a person picked this thread's own model. */
  followsBotModel: boolean;
  automated: boolean;
  /** The thread's last measured context, so a long conversation never moves to a smaller window. */
  contextTokens?: number;
  signals: TurnSignals;
  model: string;
  effort?: EffortLevel;
  variant?: string;
  catalog?: ModelCatalog;
  /** Quick models this engine instance refused before. */
  refused?: ReadonlySet<string>;
  effortLevels?: readonly EffortLevel[];
}

export interface RouteResult {
  tier: TurnTier | null;
  model: string;
  effort?: EffortLevel;
  variant?: string;
  /** The picker label of the quick model when the turn was moved to it. */
  quickModel?: string;
}

export function routeTurn(input: RouteInput): RouteResult {
  const keep: RouteResult = { tier: null, model: input.model, effort: input.effort, variant: input.variant };
  if (!input.conversational || !input.followsBotModel || input.automated) return keep;
  const tier = classifyTurn(input.signals);
  if (tier === "complex") return { ...keep, tier };
  const fast = fastModelFor(input.catalog, input.model, input.refused);
  if (!fast || fast === input.model) {
    const low = input.effortLevels?.includes("low") ? "low" : input.effortLevels?.includes("none") ? "none" : undefined;
    return { ...keep, tier, effort: input.effort && low ? low : input.effort };
  }
  const option = input.catalog?.options.find((candidate) => candidate.id === fast);
  if (option?.contextWindow && (input.contextTokens ?? 0) > option.contextWindow * QUICK_CONTEXT_SHARE) return { ...keep, tier };
  // Effort and variant belong to the configured model; the quick model runs on its engine's defaults.
  return { tier, model: fast, quickModel: option?.label ?? fast };
}

/** Routines, webhooks, peer turns, card continuations and unattended runs pass `automated`. */
export function routeDirectTurn(
  bot: { replyStyle?: ReplyStyle; modelSelection: ModelSelection },
  task: { modelSelection?: ModelSelection; usage?: { context?: { tokens: number } } },
  path: readonly { role: string; kind?: string }[],
  message: { text: string; images: readonly unknown[] },
  instance: { models?: ModelCatalog; quickModelsUsable?: () => boolean; adapter: { capabilities: { effortLevels?: readonly EffortLevel[] } } },
  automated: boolean,
  refused?: ReadonlySet<string>,
): RouteResult {
  const lastAsk = path.findLastIndex((m) => m.role === "user" && m.kind === "text");
  return routeTurn({
    conversational: isConversational(bot.replyStyle),
    followsBotModel: task.modelSelection === undefined,
    automated,
    signals: {
      text: message.text,
      attachments: message.images.length,
      priorTurnUsedTools: lastAsk >= 0 && path.slice(lastAsk + 1).some((m) => m.kind === "activity"),
    },
    model: bot.modelSelection.model,
    effort: bot.modelSelection.effort,
    variant: bot.modelSelection.variant,
    catalog: instance.quickModelsUsable?.() === false ? undefined : instance.models,
    refused,
    effortLevels: instance.adapter.capabilities.effortLevels,
    contextTokens: task.usage?.context?.tokens,
  });
}
