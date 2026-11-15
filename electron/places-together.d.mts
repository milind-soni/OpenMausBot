/** Where a bot lives: this computer, or the person's My Cloud. */
export type BotHome = "computer" | "cloud";

/** A bot of the other place, as the sidebar draws it. */
export interface PlaceBotRow {
  home: BotHome;
  id: string;
  threadId: string;
  name: string;
  title?: string;
  color?: string;
  mascotBody?: string;
  mascotFaceColor?: string;
  chief?: true;
  waiting?: true;
  working?: true;
  unread?: true;
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
  other: { home: BotHome; state: "ready" | "loading" | "asleep" | "waking" | "offline" | "signin"; bots: PlaceBotRow[] } | null;
}

/** `window.ogb.placesTogether`: this computer's page and My Cloud's own page. */
export interface PlacesTogetherBridge {
  state(): Promise<PlacesTogetherState>;
  /** Turning it on is this computer's page's alone; main refuses it from My Cloud's page. */
  set(on: boolean): Promise<PlacesTogetherState>;
  /** Opens the other place at one of its listed bots. False when main does not list that bot. */
  open(botId: string): Promise<boolean>;
  onChanged(callback: () => void): () => void;
}

export const PLACES_TOGETHER_FILE: string;
export function otherHome(asking: "local" | "cloud" | BotHome): BotHome;
