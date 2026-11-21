// A conversation moving to a place on another machine (My Cloud or this computer → the cloud computer or the Local VM,
// or back) moves the work, never its files: each machine keeps its own disk. A bot that searched the new machine and
// found nothing used to report the person's files gone, so the move says what it is, to the bot in the message that
// continues the request and to the person in one line of the chat; a cloud computer the move is about to create is
// said to start empty.
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import type { Surface } from "../surface.ts";

/** The machine a place's files live on. The built-in browser and this computer work beside the bot's own folder. */
type Disk = "home" | "cloud" | "vm";
const diskOf = (place: Surface | undefined): Disk => (place === "cloud" ? "cloud" : place === "vm" ? "vm" : "home");

/** Where the bot's own folder is: a person's My Cloud, a team's Cloud, or the desktop app's own computer. */
export type Home = "my-cloud" | "team-cloud" | "desktop";
/** For the model: English, as every prompt. */
const BOT_PLACE: Record<Disk, (home: Home) => string> = {
  home: (home) => (home === "my-cloud" ? "My Cloud" : home === "team-cloud" ? "this Cloud" : "this computer"),
  cloud: () => "the cloud computer",
  vm: () => "the Local VM",
};
const PERSON_PLACE: Record<Disk, (home: Home) => ServerLineKey> = {
  home: (home) => (home === "my-cloud" ? "server.reach.place.myCloud" : home === "team-cloud" ? "server.reach.place.thisCloud" : "server.reach.place.thisComputer"),
  cloud: () => "server.reach.place.cloudComputer",
  vm: () => "server.reach.place.localVm",
};

export interface PlaceMove {
  /** The place the turn that chose the move had mounted; nothing (or the built-in browser) is the bot's own machine. */
  from: Surface | undefined;
  to: Surface;
  home: Home;
  /** The move creates this cloud computer: it starts empty. */
  fresh?: boolean;
  /** The folder the copy tools read and write on the bot's own machine (the conversation's working folder). */
  folder?: string;
}

/** Whether the move lands on another machine's disk. */
export function changesMachine(move: Pick<PlaceMove, "from" | "to">): boolean {
  return diskOf(move.from) !== diskOf(move.to);
}

/** What the bot is told beside "The computer selection is now …"; empty when the files stay where the work goes. */
export function placeMoveForBot(move: PlaceMove): string {
  if (!changesMachine(move)) return "";
  const from = BOT_PLACE[diskOf(move.from)](move.home), to = BOT_PLACE[diskOf(move.to)](move.home);
  const fresh = move.fresh && diskOf(move.to) === "cloud" ? " This cloud computer is new, so it starts empty." : "";
  const bring = diskOf(move.to) === "cloud" && diskOf(move.from) === "home"
    ? ` To use a file from your working folder on ${from} there, copy it with copy_to_computer: its from is a path relative to your working folder${move.folder ? ` (${move.folder})` : ""}, never an absolute path; copy_from_computer brings a file back.`
    : diskOf(move.from) === "cloud"
      ? " A file you need from the cloud computer is copied into your working folder with copy_from_computer while the cloud computer is the place; it does not follow you by itself."
      : " Nothing moves between them by itself: bring over only what the request needs.";
  return ` ${to[0]!.toUpperCase()}${to.slice(1)} is a different machine from ${from}, with its own disk.${fresh} Your earlier files are still on ${from} and are not lost: never tell the person they are missing, deleted or gone because they are not on ${to}.${bring}`;
}

/** The person's one line for the move, in their language; null when the files stay where the work goes. */
export function placeMoveLine(move: PlaceMove & { bot: string }, language: string | undefined): string | null {
  if (!changesMachine(move)) return null;
  const from = serverLine(language, PERSON_PLACE[diskOf(move.from)](move.home)), to = serverLine(language, PERSON_PLACE[diskOf(move.to)](move.home));
  return serverLine(language, move.fresh && diskOf(move.to) === "cloud" ? "server.reach.placeMovedNew" : "server.reach.placeMoved", { bot: move.bot, from, to });
}
