// The processes the per-bot footprint (perf/bot-footprint.ts) counts from: every engine spawnCli started for a bot
// (engine-owners.ts) and every running agent-browser daemon (host/browser.ts), each with the bots it serves now.
import { engineOwners as allEngineOwners, type EngineOwners } from "../engine-owners.ts";
import type { FootprintOwner } from "../perf/bot-footprint.ts";

/** Where a conversation's bot can't be told (deleted since, a group's: several bots take turns in one), its engine counts
 * as shared: never one bot's. */
const UNKNOWN = "?";

export function footprintOwners(deps: { botOf: (threadId: string) => string | null; browsers: () => readonly FootprintOwner[]; engines?: Pick<EngineOwners, "list"> }): () => FootprintOwner[] {
  const engines = deps.engines ?? allEngineOwners;
  return () => [
    ...engines.list().map((engine): FootprintOwner => ({
      pid: engine.pid, start: engine.start, kind: "engine", ...(engine.exited ? { exited: true } : {}), ...(engine.shareable ? { shareable: true } : {}),
      threads: [...engine.threads.keys()],
      // The conversation's own bot, as the store says; a turn of another bot in it (a group's room) makes it shared.
      botIds: [...engine.threads].flatMap(([threadId, turnBot]) => {
        const owner = deps.botOf(threadId) ?? UNKNOWN;
        return turnBot && turnBot !== owner ? [owner, turnBot] : [owner];
      }),
    })),
    ...deps.browsers(),
  ];
}
