// This computer and My Cloud as one workspace: what main hands a page about the other side (electron/one-workspace.mjs).

/** Where a bot lives: this computer's own server, or the person's My Cloud. */
export type WorkspaceSide = "computer" | "cloud";

/** `asleep`: My Cloud sleeps and nothing calls it until the person opens it. `signed-out`: this window's My Cloud
 * sign-in ended. Rosters that are not `ready` are the last ones read, so their activity is stale. */
export type SideState = "ready" | "asleep" | "unreachable" | "signed-out";

/** A bot of the other side, read-only: what a sidebar row and a Team-map card show, never its instructions, model,
 * messages, tools or settings. `avatarUrl` is a `data:` URL main made from the bot's picture, or null. */
export interface RosterBot {
  id: string;
  threadId: string;
  name: string;
  title: string;
  color: string;
  mascotExpression?: string | null;
  mascotBody?: string | null;
  avatarUrl: string | null;
  avatarCrop?: unknown;
  avatarZoom?: number;
  avatarFocusX?: number;
  avatarFocusY?: number;
  section?: string;
  chiefOfStaff?: boolean;
  pinned?: boolean;
  unread: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" | "parked.computer";
  waitingForTeammates?: boolean;
  computer?: string;
  cloudBackend?: string;
  /** Its open conversations, newest first, and those with something unread: ids only. */
  threads?: string[];
  unreadThreads?: string[];
  /** Its switched-on routines and webhooks. */
  automations?: number;
}

/** A room of the other side; `dm` is a chat between two bots. */
export interface RosterRoom {
  id: string;
  name: string;
  memberIds: string[];
  unread: boolean;
  dm?: boolean;
  working?: boolean;
  section?: string;
}

export interface SideRoster {
  side: WorkspaceSide;
  state: SideState;
  /** When this roster was read; null when it never was. */
  at: number | null;
  bots: RosterBot[];
  rooms: RosterRoom[];
  /** Team names in that side's order. */
  sections: string[];
  /** Why the side can't be reached, when the Cloud's Admin says. */
  reason?: string;
}

/** In a conversation both copies of a bot have: how many messages each copy has that the other lacks. `computer` stays 0
 * while this computer's messages reach My Cloud by themselves. */
export interface UnsharedMessages {
  threadId: string;
  cloud: number;
  computer: number;
}

/** `page`: the side the asking page is. `twinHome`: where a bot on both sides lives, so the copy its row opens.
 * `cloudName`: My Cloud's own name. `other`: the other side's roster. `unshared`: per bot on both sides, its
 * conversations where one copy has messages the other lacks. */
export interface OneWorkspaceView {
  page: WorkspaceSide;
  twinHome: WorkspaceSide;
  cloudName: string;
  other: SideRoster;
  unshared?: Record<string, UnsharedMessages[]>;
}

/** `window.ogb.oneWorkspace`. `view` is null while the person keeps the two apart (or has no My Cloud). `open` asks main
 * to show a bot or room of the other side there, at one of its own conversations (`threadId`) when given; `take` hands
 * the page that just loaded the chat link it should open. */
export interface OneWorkspaceBridge {
  view(): Promise<OneWorkspaceView | null>;
  onView(listener: (view: OneWorkspaceView | null) => void): () => void;
  open(target: { side: WorkspaceSide; id: string; threadId?: string }): Promise<void>;
  take(): Promise<string | null>;
}
