/** Where a bot lives: this computer, or the person's My Cloud. */
export type BotHome = "computer" | "cloud";

/** A bot of the other place, as the sidebar draws it. */
export interface PlaceBotRow {
  home: BotHome;
  id: string;
  /** Its address over the link between the two places (`link-<place key>-<id>`): the id of this place's stand-in record
   * for it, and what a room, a Chief or an automation here names it by. Absent while no link of this Cloud and account
   * is on; the row is listed all the same. */
  address?: string;
  threadId: string;
  name: string;
  title?: string;
  color?: string;
  mascotBody?: string;
  mascotFaceColor?: string;
  mascotBodyColor?: string;
  mascotMaterial?: string;
  chief?: true;
  waiting?: true;
  working?: true;
  unread?: true;
  /** The start of its newest message while that is words said (at most PREVIEW_MAX characters, Markdown as written):
   * its second line in the one list, as this page's own rows show theirs. Absent for a step, a card or a file. */
  preview?: string;
  /** The title of the conversation it has open there: its second line while no preview came. */
  chat?: string;
  /** Epoch ms its conversations last moved there (the newest thread's `updatedAt`): Unread's order across places. */
  lastAt?: number;
}

export interface PlacesTogetherState {
  v: 1;
  /** The person has a My Cloud and this computer is a place of its own: the switch is offered. */
  available: boolean;
  on: boolean;
  /** The place whose page asked. */
  here: BotHome;
  /** The other place's bots while the switch is on. `state`: how that place is doing: asleep, waking and offline keep the
   * bots it gave last; "signin" is a My Cloud this window has not signed in to yet, which lists none. */
  other: { home: BotHome; state: "ready" | "loading" | "asleep" | "waking" | "offline" | "signin"; bots: PlaceBotRow[]; newBot?: boolean } | null;
}

/** `window.ogb.placesTogether`: this computer's page and My Cloud's own page. */
export interface PlacesTogetherBridge {
  state(): Promise<PlacesTogetherState>;
  /** Turning it on is this computer's page's alone; main refuses it from My Cloud's page. */
  set(on: boolean): Promise<PlacesTogetherState>;
  /** Opens the other place at one of its listed bots. False when main does not list that bot. */
  open(botId: string): Promise<boolean>;
  onChanged(callback: () => void): () => void;
  /** The other place as the ＋ shows it: how it is doing and the AIs ready there (null while it can't be asked). Null with the switch off. */
  newBotChoice(): Promise<NewBotChoice | null>;
  /** Opens the other place, which makes a new bot there by its own rules. False with the switch off, and for a place
   * whose page would not hear it (`other.newBot` false: it runs a version from before this). */
  newBot(): Promise<boolean>;
  /** The other place asked this one to make a new bot. */
  onNewBot(callback: () => void): () => void;
}

export interface NewBotChoice {
  home: BotHome;
  state: NonNullable<PlacesTogetherState["other"]>["state"];
  /** Each ready AI's name as the person sees it there, and its kind. */
  ais: Array<{ name: string; kind: string }> | null;
}

export const PLACES_TOGETHER_FILE: string;
export const PREVIEW_MAX: number;
export const PREVIEW_LOOK: number;
export function otherHome(asking: "local" | "cloud" | BotHome): BotHome;
