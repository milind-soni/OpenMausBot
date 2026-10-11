// Quick replies for conversational bots. Before a turn is dispatched, a
// cheap local look at the incoming message sorts it into a tier, with no
// model round trip on the hot path. A simple chat line runs on the fastest
// model of the bot's own engine, a complex or agentic one keeps the bot's
// configured model and effort. The fast model is always picked from the same
// engine instance, and from the same upstream provider when the catalog
// names one, so routing never sends a message to another vendor.
import type { ModelCatalog } from "./contracts.ts";
import type { EffortLevel } from "../shared/wire.ts";

export type TurnTier = "simple" | "complex";

export interface TurnSignals {
  text: string;
  /** Images or files sent with the message. */
  attachments: number;
  /** The previous bot turn used tools (activity rows after the last ask). */
  priorTurnUsedTools: boolean;
}

// Verbs that usually mean "go do something", in English. A message in
// another language falls back on the other signals.
const ACTION = /\b(build|fix|debug|implement|refactor|write|create|generate|deploy|install|run|test|search|find|look up|browse|open|edit|change|update|delete|remove|rename|move|migrate|analy[sz]e|review|compare|research|summari[sz]e|translate|draft|send|email|schedule|book|download|upload|scrape|clone|commit|push|merge|plan|design|calculate|convert)\b/i;
const CODE = /```|`[^`\n]+`|\b(function|const|let|class|import|def|SELECT|FROM)\b|[{};]\s*$|\w+\.(ts|tsx|js|py|go|rs|json|md|sh|yml|yaml|sql|css|html)\b|https?:\/\/|(^|\s)[~.]?\/[\w.-]+\//m;
// Short go-aheads, which usually authorize work the bot just offered.
const CONTINUE = /^(yes|yep|yeah|ok(ay)?|sure|go( ahead| on)?|do it|continue|proceed|please do|sounds good|retry|try again)\b/i;
// Plain acknowledgments, which need no work even right after tool use.
const ACK = /^(thanks|thank you|thx|ty|cool|nice|great|perfect|awesome|got it|lol|haha)\b[\s!.]*$/i;
const SIMPLE_CHARS = 280;
const SIMPLE_LINES = 4;

export function classifyTurn(signals: TurnSignals): TurnTier {
  const text = signals.text.trim();
  if (!text) return "complex";
  if (signals.attachments > 0) return "complex";
  if (text.length > SIMPLE_CHARS || text.split("\n").length > SIMPLE_LINES) return "complex";
  if (CODE.test(text)) return "complex";
  if (ACTION.test(text)) return "complex";
  if (CONTINUE.test(text)) return "complex";
  // right after tool work, a short follow-up is usually more of that work
  if (signals.priorTurnUsedTools && !ACK.test(text)) return "complex";
  // several questions at once is a request for a fuller answer
  if ((text.match(/\?/g) ?? []).length > 2) return "complex";
  return "simple";
}

// Names engines give their quick, small variants.
const FAST = /(^|[-_/. ])(haiku|flash|mini|nano|lite|small|fast|instant|spark|turbo|air)(?=$|[-_/. \d])/i;

/** The fastest model in the catalog that shares the current model's
 * upstream provider, or undefined when the engine offers none. A model that
 * is already fast is kept. Among several, the one listed first wins, since
 * engines list their newest first. */
export function fastModelFor(catalog: ModelCatalog | undefined, current: string): string | undefined {
  if (!catalog) return undefined;
  if (FAST.test(current)) return current;
  const provider = catalog.options.find((option) => option.id === current)?.provider;
  const pick = catalog.options.find((option) =>
    !option.custom && FAST.test(option.id) && (option.provider ?? undefined) === (provider ?? undefined));
  return pick?.id;
}

export interface RouteInput {
  conversational: boolean;
  /** false when a person picked this thread's own model. */
  followsBotModel: boolean;
  /** routines, webhooks, peer turns, card continuations and unattended runs */
  automated: boolean;
  signals: TurnSignals;
  model: string;
  effort?: EffortLevel;
  variant?: string;
  catalog?: ModelCatalog;
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
  const fast = fastModelFor(input.catalog, input.model);
  if (!fast || fast === input.model) {
    // no quick variant: stay on the model, and lower an explicit effort
    const low = input.effortLevels?.includes("low") ? "low" : input.effortLevels?.includes("none") ? "none" : undefined;
    return { ...keep, tier, effort: input.effort && low ? low : input.effort };
  }
  // effort and variant belong to the configured model, so neither carries
  // over: the quick model runs on its engine's own defaults
  const label = input.catalog?.options.find((option) => option.id === fast)?.label ?? fast;
  return { tier, model: fast, quickModel: label };
}
