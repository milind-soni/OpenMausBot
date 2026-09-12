// Fields a room (or any bot-initiated turn) must copy from the bot's
// picker selection. 1:1 chat already does this; a missing `model` is
// how Hermes hits OpenRouter (HTTP 401) and Qwen dies with Internal error
// while Grok silently runs its cloud default.
//
// The picker lives on the visible 1:1 thread. The bot-level default is only
// for brand-new threads. A room has no belt, so it must use that visible
// thread — otherwise a Grok 1:1 and a Claude-default bot talk past each other.
import type { EffortLevel, ModelSelection } from "./contracts.ts";

export function memberTurnSelection(selection: ModelSelection): {
  model: string;
  effort?: EffortLevel;
} {
  return {
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
  };
}

export function roomSpeakerSelection(
  bot: { id: string; threadId: string; modelSelection: ModelSelection },
  project: (botId: string, threadId: string) => { modelSelection: ModelSelection } | null | undefined,
): ModelSelection {
  const projected = project(bot.id, bot.threadId)?.modelSelection;
  return { ...(projected ?? bot.modelSelection) };
}
