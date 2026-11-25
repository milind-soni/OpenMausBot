// What changes for the bots a person is about to move from this computer to My Cloud, said before they press Move
// (src/components/MoveChanges.tsx). This computer's server reads the bots' own setup (server/move-changes.ts), main adds
// what this computer lends My Cloud now (electron/move-lending.mjs), and this decides which lines apply, in order of what
// a person misses most: teammates, the working folder, a local model, commands and the tools that need them, skills
// that read folders never lent.

/** The chosen bots' setup, as this computer's server reads it. Names only: no path but the working folder's. */
export interface MoveFacts {
  /** The working folder (the first chosen bot's that has one), as this computer names it. */
  folder: string | null;
  /** How many of the chosen bots have a working folder. */
  folders: number;
  /** Every working folder of the choice, as this computer names it: main checks each against what is lent, and the page
   * never gets them. */
  paths?: string[];
  /** A model engine on this computer or its network that one of them runs on, by its name in the app. */
  engine: string | null;
  /** MCP servers they use that start a program on this computer. */
  tools: string[];
  /** Skills whose text reads hidden folders of this computer (~/.claude, ~/.codex…), which lending never opens. */
  skills: string[];
  /** Those hidden folders, as the skills name them. */
  hidden: string[];
  /** Bots that stay on this computer which they hand work to. */
  teammates: string[];
}

/** What this computer lends My Cloud now (electron/move-lending.mjs). */
export interface MoveLending {
  /** Lending to My Cloud is paused from the OpenMausBot icon. */
  paused: boolean;
  /** Every working folder of the choice sits inside a folder already lent to My Cloud with editing (or the home folder,
   * which is lent by itself), so they are reachable whatever is chosen here. */
  folderLent: boolean;
  /** My Cloud may run commands on this computer already. */
  terminal: boolean;
  /** "This computer and My Cloud together": "off" when it can be turned on, "unavailable" when it can't. */
  together: "on" | "off" | "unavailable";
}

/** What the person chose in the move step. */
export interface MoveChoice {
  /** Lend the working folder with editing. */
  folder: boolean;
  /** Let My Cloud run commands here (confirmed in main's own dialog). */
  commands: boolean;
  /** Turn "This computer and My Cloud together" on. */
  together: boolean;
}

export type MoveChangeLine =
  | { kind: "teammates"; names: string[]; reach: boolean }
  | { kind: "folder"; folder: string; reach: "lent" | "paused" | "not-lent" }
  | { kind: "engine"; engine: string }
  | { kind: "commands"; tools: string[] }
  | { kind: "skills"; skills: string[]; hidden: string[] };

/** What the person can grant in the move step: the working folder when it isn't reachable yet, commands when they are
 * off. Nothing while lending is paused: the fix for that is Resume, in the OpenMausBot icon's menu. */
export function moveOffers(facts: MoveFacts, lending: MoveLending): { folder: boolean; commands: boolean; together: boolean } {
  const lends = !lending.paused;
  return {
    folder: lends && facts.folder !== null && !lending.folderLent,
    commands: lends && !lending.terminal && (facts.folders > 0 || facts.tools.length > 0),
    together: facts.teammates.length > 0 && lending.together === "off",
  };
}

/** The choice a move step opens with: the working folder lent, as moves did before this step showed it; commands and
 * the link only when the person turns them on. */
export function defaultMoveChoice(facts: MoveFacts, lending: MoveLending): MoveChoice {
  return { folder: moveOffers(facts, lending).folder, commands: false, together: false };
}

/** The lines that apply, most missed first. */
export function moveChanges(facts: MoveFacts, lending: MoveLending, choice: MoveChoice): MoveChangeLine[] {
  const lines: MoveChangeLine[] = [];
  if (facts.teammates.length) lines.push({ kind: "teammates", names: facts.teammates, reach: lending.together === "on" || choice.together });
  if (facts.folder !== null) {
    const reach = lending.paused ? "paused" : lending.folderLent || choice.folder ? "lent" : "not-lent";
    lines.push({ kind: "folder", folder: facts.folder, reach });
  }
  if (facts.engine) lines.push({ kind: "engine", engine: facts.engine });
  const commands = !lending.paused && (lending.terminal || choice.commands);
  if (!commands && (facts.folders > 0 || facts.tools.length > 0)) lines.push({ kind: "commands", tools: facts.tools });
  // With commands lent, a skill reads what it needs through them: only without them do these places stay out of reach.
  if (facts.skills.length && !commands) lines.push({ kind: "skills", skills: facts.skills, hidden: facts.hidden });
  return lines;
}

/** How many lines the step shows before "and N more". */
export const MOVE_LINES_SHOWN = 4;
