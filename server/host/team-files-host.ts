// Team files on a Team Cloud at run time (server/host/team-files.ts is the folder itself): what each bot's box gets of
// the folder, the one line a bot's prompt says about it, and the before-and-after of every turn that could write it, so
// the page says "Changed by Mira with Payroll". Off a Team Cloud there is no folder, no line and no route.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { TEAM_FILES_IN_BOX } from "../bot-box/plan.ts";
import { createTeamFiles, TEAM_FILES_TEMPLATES, type TeamFiles } from "./team-files.ts";

export interface TeamFilesHostDeps {
  team: { name: string } | null;
  dataDir: string;
  bots(): ReadonlyArray<{ id: string; teamFilesEdit?: boolean }>;
  /** Whether turns run in the bot box here: only there is the folder at /team-files and read-only for a bot. */
  boxOn(): boolean;
  /** The person a turn works for: whoever asked (their line), else the person the conversation is theirs alone. */
  askerOf(threadId: string): string | null;
}

export function createTeamFilesHost(deps: TeamFilesHostDeps) {
  const files: TeamFiles | null = deps.team ? createTeamFiles({ dataDir: deps.dataDir }) : null;
  if (files) files.ensure();
  const canEdit = (botId: string | null) => botId !== null && deps.bots().some((bot) => bot.id === botId && bot.teamFilesEdit === true);

  return {
    files,
    /** What a bot's boxes get of the folder: read-write for a bot that may edit it while it has room, else read-only. */
    boxFolder(botId: string | null): { source: string; write: boolean } | null {
      if (!files) return null;
      const source = files.ensure();
      // Made first, so the read-only bind over it has something to cover in a box that may write the rest.
      try { mkdirSync(join(source, TEAM_FILES_TEMPLATES), { recursive: true, mode: 0o700 }); } catch {}
      return { source, write: canEdit(botId) && !files.full() };
    },
    /** One line for every bot's turn on a Team Cloud: where the folder is, and whether this bot may change it. */
    promptLine(botId: string): string {
      if (!files || !deps.team) return "";
      const where = deps.boxOn() ? TEAM_FILES_IN_BOX : files.root();
      const mode = !canEdit(botId) ? "It is read-only for you."
        : files.full() ? `It is full (${Math.round(files.cap / 1024 ** 3)} GB), so it is read-only until someone removes files.`
          : "You can add and change files there; everyone on the team sees them.";
      return `\n\nTeam files, the folder everyone at ${deps.team.name} shares: ${where}. ${mode}`;
    },
    /** Before a bot's turn: the folder as it is, when the turn could change it (a bot that may edit, or any bot where no
     * box keeps it read-only). */
    beginTurn(botId: string, threadId: string): void {
      if (!files) return;
      files.endTurn(threadId);
      if (!canEdit(botId) && deps.boxOn()) return;
      const person = deps.askerOf(threadId);
      files.beginTurn(threadId, { bot: botId, ...(person ? { person } : {}) });
    },
    /** After it (turn.completed, or the engine gone): what it changed, as the bot's for that person. */
    onEvent(event: { type: string; threadId: string }): void {
      if (files && (event.type === "turn.completed" || event.type === "session.exited")) files.endTurn(event.threadId);
    },
  };
}

export type TeamFilesHost = ReturnType<typeof createTeamFilesHost>;
