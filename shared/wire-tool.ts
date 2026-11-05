import type { PlaceRow } from "./place-view.ts";
import type { ServerToolText } from "./server-text.ts";

/** An activity chip serialized beside a transcript line. */
export interface WireTool extends ServerToolText {
  name: string; ok?: boolean; spoken?: string; setup?: boolean; terminal?: boolean; summary?: string; input?: string; output?: string;
  /** What the call works on, as its live status said it: the chip's and the "Now" card's specific words. `whose`: the person whose own app or MCP server the call used. */
  step?: import("./turn-progress.ts").LiveStep; whose?: { person: string; app: string };
  /** error rows: the installed Claude Code is too old for the model, and
   * the UI can offer to update it in place. notice rows: `rescue`, a turn that heard nothing from its AI for a while. */
  claudeUpdate?: boolean; rescue?: import("./first-reply-rescue.ts").FirstReplyRescue;
  /** error rows: the place this turn could not use. */
  place?: PlaceRow;
  /** error rows: epoch ms when the usage limit that stopped the turn resets. */
  limitResetsAt?: number;
  /** Provider item identity, scoped to the owning turn. */
  itemId?: string;
  /** Whether the harness captured the full redacted result. Private
   * server-local spill paths are not exposed to clients. */
  fullResult?: boolean;
}
