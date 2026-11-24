// On a Cloud, a conversation moving between the Cloud itself and the cloud desktop (with select_computer) moves the work,
// never its files: the cloud desktop is another machine with its own disk. A bot that searched a new cloud desktop and
// found nothing used to report the person's files gone, so the move says what it is, to the bot in the message that
// continues the request and to the person in one line of the chat once the request continues there. The desktop app is
// left as it was: its Local VM's folder is this computer's own (container-computer.ts), so nothing there is elsewhere.
import { serverLine } from "../server-lines.ts";
import type { Surface } from "../surface.ts";

/** A personal Cloud (My Cloud) or a team's. */
export type CloudHome = "my-cloud" | "team-cloud";

export interface PlaceMove {
  /** The place the turn that chose the move had mounted; nothing, or the built-in browser, is the Cloud itself. */
  from: Surface | undefined;
  to: Surface;
  /** The Cloud this runs on; null on the desktop app, where a move says nothing new. */
  home: CloudHome | null;
  /** The cloud desktop is a self-hosted VPS: no copy tools, and a move never makes one. */
  vps?: boolean;
  /** The move creates this cloud desktop: it starts empty. */
  fresh?: boolean;
  /** The folder the copy tools read and write on the Cloud (the conversation's working folder). */
  folder?: string;
}

const onCloud = (place: Surface | undefined) => place === "cloud";

/** Whether the move lands on another machine's disk: only between the Cloud and its cloud desktop. */
export function changesMachine(move: Pick<PlaceMove, "from" | "to" | "home">): boolean {
  return move.home !== null && onCloud(move.from) !== onCloud(move.to);
}

/** What the bot is told beside "The computer selection is now …"; empty when the files stay where the work goes. */
export function placeMoveForBot(move: PlaceMove): string {
  if (!changesMachine(move)) return "";
  const home = move.home === "my-cloud" ? "My Cloud" : "this Cloud";
  const [from, to] = onCloud(move.to) ? [home, "the cloud desktop"] : ["the cloud desktop", home];
  const fresh = move.fresh && !move.vps && onCloud(move.to) ? " It is new, so it starts empty." : "";
  const copy = move.vps ? "" : onCloud(move.to)
    ? ` To use a file from ${home}, copy it there with copy_to_computer (from: a path relative to your working folder${move.folder ? `, ${move.folder}` : ""}).`
    : " Files you made on the cloud desktop stay there.";
  return ` ${to[0]!.toUpperCase()}${to.slice(1)} is another machine with its own disk.${fresh} Your files on ${from} are still there, not lost.${copy}`;
}

/** The person's one line for the move, in their language; null when the files stay where the work goes. */
export function placeMoveLine(move: PlaceMove & { bot: string }, language: string | undefined): string | null {
  if (!changesMachine(move)) return null;
  const home = serverLine(language, move.home === "my-cloud" ? "server.reach.place.myCloud" : "server.reach.place.thisCloud");
  const desktop = serverLine(language, "server.reach.place.cloudDesktop");
  const [from, to] = onCloud(move.to) ? [home, desktop] : [desktop, home];
  return serverLine(language, move.fresh && !move.vps && onCloud(move.to) ? "server.reach.placeMovedNew" : "server.reach.placeMoved", { bot: move.bot, from, to });
}

/** A request a turn is moving with select_computer, continued on its new place once the turn ends (server/index.ts). */
export interface ComputerSelection<Opts, Outcome, Source, Data> {
  generation: string;
  botId: string;
  /** None for a teammate's hand-off, which moves only to the browser and continues with `handoff.opts`. */
  source?: Source;
  text: string;
  dataContext?: Data;
  handoff?: { opts: Opts; outcome?: Outcome };
  mounted?: Surface;
  selected?: Surface;
  /** The move creates the cloud desktop it goes to. */
  fresh?: boolean;
  previousSurface?: Surface;
}

export interface PlaceMovesDeps {
  home: CloudHome | null;
  /** The conversation's working folder, where the copy tools read and write. */
  folder(botId: string, threadId: string): string | undefined;
  /** The bot's cloud desktop is a self-hosted VPS. */
  vps(botId: string): boolean;
  language(threadId: string): string | undefined;
  notice(threadId: string, text: string): void;
}

export function createPlaceMoves(deps: PlaceMovesDeps) {
  const move = (botId: string, threadId: string, from: Surface | undefined, to: Surface, fresh?: boolean): PlaceMove =>
    ({ from, to, home: deps.home, vps: deps.vps(botId), fresh, folder: deps.folder(botId, threadId) });
  return {
    /** The bot's words beside "The computer selection is now …". */
    forBot: (botId: string, threadId: string, from: Surface | undefined, to: Surface, fresh?: boolean): string => placeMoveForBot(move(botId, threadId, from, to, fresh)),
    /** The request continues on its new place: the person's one line, when the files stayed behind. */
    continued(bot: { id: string; name: string }, threadId: string, from: Surface | undefined, to: Surface, fresh?: boolean): void {
      const line = placeMoveLine({ ...move(bot.id, threadId, from, to, fresh), bot: bot.name }, deps.language(threadId));
      if (line) deps.notice(threadId, line);
    },
  };
}
