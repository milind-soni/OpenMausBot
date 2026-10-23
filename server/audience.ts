// The audience rule of a Team Cloud (docs/team-cloud.md). Everything stored carries an audience: `team` (everyone),
// `room:<id>` (whoever sees the room) or `member:<person>` (that person only: an Admin is no exception). A turn reads
// only inputs whose audience includes everyone who will see its answer, and writes only into its own audience. On a My
// Cloud one person uses everything, so every audience there is the team's and nothing here changes what that Cloud does.
export type Audience = "team" | `room:${string}` | `member:${string}`;

export const TEAM_AUDIENCE: Audience = "team";
const ID = /^[\w-]{1,200}$/;

export function roomAudience(groupId: string): Audience {
  return `room:${groupId}`;
}

export function memberAudience(person: string): Audience {
  return `member:${person}`;
}

export function parseAudience(value: unknown): Audience | null {
  if (value === "team") return "team";
  if (typeof value !== "string") return null;
  const match = /^(room|member):([\w-]{1,200})$/.exec(value);
  return match ? (value as Audience) : null;
}

export function audienceRoom(audience: Audience): string | null {
  return audience.startsWith("room:") ? audience.slice("room:".length) : null;
}

export function audienceMember(audience: Audience): string | null {
  return audience.startsWith("member:") ? audience.slice("member:".length) : null;
}

/** The read rule: an input reaches a turn only when everyone who sees the turn's answer may see the input. The team's
 * things reach every turn; a room's only that room's turns; a member's only that member's own. */
export function mayRead(input: Audience, turn: Audience): boolean {
  return input === "team" || input === turn;
}

/** The write rule: a turn writes into its own audience, never a wider or another one. */
export function writesInto(turn: Audience): Audience {
  return turn;
}

export interface AudienceViewer {
  admin: boolean;
  /** The viewer's person key; null for a session that has none. */
  person: string | null;
  seesRoom(groupId: string): boolean;
}

/** Whether one person may see something of this audience: the team's, the rooms they see (an Admin every room), and
 * their own. A person's private chat is theirs alone: no role, an Admin's or the Owner's, sees another person's. */
export function audienceIncludes(audience: Audience, viewer: AudienceViewer): boolean {
  if (audience === "team") return true;
  const room = audienceRoom(audience);
  if (room !== null) return viewer.admin || viewer.seesRoom(room);
  const person = audienceMember(audience);
  return person !== null && viewer.person !== null && person === viewer.person;
}

/** Where a bot's memory for an audience lives: the bot's own folder is the team's layer; a room's and a member's layers
 * are sibling folders (never inside the bot's folder, which every turn of that bot can read). */
export function layerId(botId: string, audience: Audience): string {
  if (audience === "team") return botId;
  const room = audienceRoom(audience);
  if (room !== null) return `${botId}--room-${room}`;
  return `${botId}--member-${audienceMember(audience)}`;
}

const LAYER = /^([\w-]+?)--(room|member)-([\w-]+)$/;

export function isLayerId(id: string): boolean {
  return LAYER.test(id);
}

/** The bot a layer belongs to; a bot's own id as it is. */
export function baseBotId(id: string): string {
  const match = LAYER.exec(id);
  return match ? match[1]! : id;
}

export function layerAudience(id: string): Audience {
  const match = LAYER.exec(id);
  if (!match) return "team";
  return match[2] === "room" ? roomAudience(match[3]!) : memberAudience(match[3]!);
}

/** A conversation's audience from where it is and who opened it: a room's is the room's; a person's conversation with a
 * bot is theirs; the bot's main chat, and a conversation nobody or a marker (nobody, outside) opened, is the team's. */
export function threadAudienceFrom(input: { room: string | null | undefined; starter: string | undefined; markers: ReadonlySet<string> }): Audience {
  if (input.room) return roomAudience(input.room);
  const starter = input.starter;
  if (!starter || !ID.test(starter) || input.markers.has(starter)) return "team";
  return memberAudience(starter);
}
