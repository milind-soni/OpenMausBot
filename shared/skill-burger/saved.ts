// A saved burger as lists show it: its name, the summary on its top bun, one entry per layer and its args. Every saved
// burger is used in every chat by every bot; `botId` names the bot it was made with.
import type { LayerKind } from "./layers.ts";

export interface SavedWorkflowLayer {
  kind: LayerKind;
  app?: string;
  label: string;
  id?: string;
  /** A decide step's cases. */
  cases?: string[];
  /** The case of a decide step this step belongs to. */
  on?: { decide: string; case: string };
}
export interface SavedWorkflow {
  name: string;
  summary: string;
  /** Revision of the instructions and executable workflow, used to reject stale edits. */
  sha256: string;
  savedAt: string;
  layers: SavedWorkflowLayer[];
  args: string[];
  /** The bot it was made with; unknown for one whose bot is gone. */
  botId?: string;
  /** Whether the person reading the list may rename or remove it: whoever saved it, or an admin. */
  canChange?: boolean;
}

/** The source a saved burger records: the bot it was made with. */
export const burgerSource = (botId: string) => `skill-burger:${botId}`;
export function burgerBotOf(source: string): string | undefined {
  return source.startsWith("skill-burger:") ? source.slice("skill-burger:".length) || undefined : undefined;
}
export const isBurgerSource = (source: string | undefined) => Boolean(source?.startsWith("skill-burger"));
