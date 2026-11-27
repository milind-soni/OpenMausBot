import type { InstanceConfigMap } from "./contracts.ts";

export const REMOVED_COMPUTER_DRIVER = "boxAgent";
const REMOVED_COMPUTER_INSTANCE = "computer";

/** An id the person reused for another engine is theirs and stays. */
export function removedComputerInstanceIds(saved: InstanceConfigMap | undefined): Set<string> {
  const ids = new Set<string>();
  const reused = saved && Object.hasOwn(saved, REMOVED_COMPUTER_INSTANCE) &&
    saved[REMOVED_COMPUTER_INSTANCE]!.driver !== REMOVED_COMPUTER_DRIVER;
  if (!reused) ids.add(REMOVED_COMPUTER_INSTANCE);
  for (const [id, entry] of Object.entries(saved ?? {})) {
    if (entry.driver === REMOVED_COMPUTER_DRIVER) ids.add(id);
  }
  return ids;
}

export function withoutComputerEngine(map: InstanceConfigMap): InstanceConfigMap {
  for (const [id, entry] of Object.entries(map)) {
    if (entry.driver === REMOVED_COMPUTER_DRIVER) delete map[id];
  }
  return map;
}

export interface ComputerEngineMove {
  botId: string;
  threadId: string;
  /** "bot": the bot's engine moved; "conversation": only this conversation's did; "bot-only": the bot's did, but this conversation keeps its own. */
  scope: "bot" | "conversation" | "bot-only";
  cloud: boolean;
  /** It worked on the cloud computer and the new engine can't: "auto" now works without one; "works-on" or "pin" still say Cloud, so turns are refused. */
  noComputer: false | "auto" | "works-on" | "pin";
  /** Permissions went back to Ask, as on any engine switch. */
  askNow: boolean;
}

export function computerEngineMoveText(
  move: Pick<ComputerEngineMove, "scope" | "cloud" | "askNow"> & Partial<Pick<ComputerEngineMove, "noComputer">>,
  botName: string,
  engine: string,
): string {
  const removed = "The Computer choice in the model list was removed.";
  const bot = move.scope !== "conversation";
  const head = move.scope === "conversation" ? `This conversation now uses ${engine}.`
    : move.scope === "bot-only" ? `${botName} now uses ${engine}; this conversation keeps its own model.`
    : `${botName} now uses ${engine}.`;
  const noComputer = ` ${engine} can't use a desktop, so`;
  const place = move.cloud
    ? bot ? ` ${botName} still works on its cloud desktop.` : ` It still works on ${botName}'s cloud desktop.`
    : move.noComputer === "auto"
      ? `${noComputer} ${bot ? `${botName} no longer works on its` : `it no longer works on ${botName}'s`}` +
        " cloud desktop. To use it again, choose a model that can use a desktop."
    : move.noComputer === "works-on"
      ? `${noComputer} ${botName} can't reply on ${engine} while its Works on is Cloud desktop.` +
        " Choose a model that can use a desktop, or set Works on to Auto."
    : move.noComputer === "pin"
      ? `${noComputer} ${botName} can't reply here while this conversation is pinned to its cloud desktop.` +
        " Choose a model that can use a desktop, or clear this conversation's place in the composer."
    : "";
  const ask = !move.askNow ? ""
    : move.scope === "bot-only" ? ` ${botName}'s permissions are now Ask, but this conversation's stay as they were.`
    : " Its permissions are now Ask.";
  return `${head} ${removed}${place}${ask}`;
}

/** The move is saved already, so a failing line is logged and every other line is still written. */
export function writeComputerEngineMoveLines(moves: readonly ComputerEngineMove[], write: (move: ComputerEngineMove) => void): void {
  for (const move of moves) {
    try {
      write(move);
    } catch (error) {
      console.warn(`[engines] the Computer engine move line for ${move.threadId} was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
