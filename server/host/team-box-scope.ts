// The bot box's side of a Team Cloud's audience rule (docs/team-cloud.md, "The audience rule"): a turn writes only into its
// own audience and reads only what everyone who sees its answer may see, so a shell in a member's private chat or a room
// never writes the bot's own folder (the team's notes and skills), and a process a bot's conversations share has only
// the conversations its audience may read. Registered with the box by the Team Cloud host; nothing here runs elsewhere.
import { mayRead, TEAM_AUDIENCE, type Audience } from "../audience.ts";
import type { BoxAudienceScope } from "../bot-box/box.ts";
import type { BoxAudience } from "../bot-box/plan.ts";

/** A bot's conversations as the store keeps them: its main chat and each of its tasks. */
export type TeamBoxBots = ReadonlyArray<{ id: string; threadId?: string; tasks?: ReadonlyArray<{ threadId: string }> }>;

export interface TeamBoxScopeDeps {
  audienceOf(threadId: string): Audience;
  bots(): TeamBoxBots;
  /** The team's shared folder as this bot's boxes get it (server/host/team-files-host.ts), whatever the audience. */
  teamFiles?(botId: string | null): BoxAudience["teamFiles"] | null;
}

/** Every conversation the store has for this bot; one it no longer has (deleted) is never put back. */
export function botConversations(bots: TeamBoxBots, botId: string): string[] {
  const bot = bots.find((entry) => entry.id === botId);
  if (!bot) return [];
  return [...new Set([...(bot.threadId ? [bot.threadId] : []), ...(bot.tasks ?? []).map((task) => task.threadId)])];
}

export function createTeamBoxScope(deps: TeamBoxScopeDeps): BoxAudienceScope {
  return ({ threadId, botId, sharedProcess }): BoxAudience => {
    const turn = deps.audienceOf(threadId);
    const files = deps.teamFiles?.(botId) ?? null;
    const audience: BoxAudience = { teamReadOnly: turn !== TEAM_AUDIENCE, ...(files ? { teamFiles: files } : {}) };
    if (!sharedProcess || !botId) return audience;
    const rw: string[] = [], ro: string[] = [];
    for (const other of botConversations(deps.bots(), botId)) {
      const of = deps.audienceOf(other);
      if (of === turn) rw.push(other);
      else if (mayRead(of, turn)) ro.push(other);
    }
    // The conversation that starts the process is its own, whether or not the store lists it yet.
    if (!rw.includes(threadId)) rw.push(threadId);
    return { ...audience, threads: { rw: rw.sort(), ro: ro.sort() } };
  };
}
