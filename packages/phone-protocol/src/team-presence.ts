// Who is here on a Team Cloud (docs/team-cloud.md "Who is here"): the wire between the server and the app. A person is
// named by their address, as in GET /api/team/people. Nothing here ever names a private chat: a conversation only one
// person can read is never reported, and its person only counts as here.

/** POST {tab, threadId}: this app window is open, with that conversation in front of the person (null: none, or one that
 * is theirs alone). `tab` is the window's own id, made when it loads. Sent when the conversation changes and every
 * HERE_REPEAT_MS while the window shows. */
export const PRESENCE_HERE_PATH = "/api/presence/here";

export interface PresenceHereBody {
  tab: string;
  threadId: string | null;
}

/** How often a showing window repeats its POST; a window not heard from for a few of these no longer counts. */
export const HERE_REPEAT_MS = 60_000;

/** A person on GET /api/team/people, with presence: `here` while one of their apps is open. A server that sends no
 * `here` has no presence, and the app shows none. */
export interface PersonPresence {
  here?: boolean;
}

/** A teammate came or went. Sent to everyone signed in to the team, at most once every few seconds per person. */
export interface TeamPresenceFrame {
  kind: "team.presence";
  email: string;
  here: boolean;
}

/** Who has a shared conversation (a bot's shared chat, a group chat) open now, the receiver included. Sent only to the
 * people listed, each of whom may read it; never for a conversation that is one person's own. */
export interface ThreadPresenceFrame {
  kind: "thread.presence";
  threadId: string;
  people: string[];
}

/** Someone joined the team, left it or changed role: the app reads the people and its own session again. */
export interface TeamPeopleFrame {
  kind: "team.people";
}

export type PresenceFrame = TeamPresenceFrame | ThreadPresenceFrame | TeamPeopleFrame;
