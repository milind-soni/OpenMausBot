// A saved burger as lists show it: its name, the summary on its top bun, one entry per layer, its args, and where it is
// used. A burger belongs to the bot it was made with until someone turns on "Use in every chat"; then it is in the shared
// library and on for every bot, and `botId` still names the bot it came from.
import type { LayerKind } from "./layers.ts";

export interface SavedWorkflowLayer { kind: LayerKind; app?: string; label: string }
export interface SavedWorkflow {
  name: string;
  summary: string;
  sha256: string;
  savedAt: string;
  layers: SavedWorkflowLayer[];
  args: string[];
  everyChat: boolean;
  /** The bot it was made with; unknown for one whose bot is gone. */
  botId?: string;
}

/** The source a saved burger records: the bot it was made with. */
export const burgerSource = (botId: string) => `skill-burger:${botId}`;
export function burgerBotOf(source: string): string | undefined {
  return source.startsWith("skill-burger:") ? source.slice("skill-burger:".length) || undefined : undefined;
}
export const isBurgerSource = (source: string | undefined) => Boolean(source?.startsWith("skill-burger"));
