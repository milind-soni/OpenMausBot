import type { EnvironmentDescriptor } from "./environment.ts";
import type { CompanionEndpoint, PairingE2EDescriptor } from "./pairing-link.ts";
import type { BotQueuedMessages, ComputerHelpRef, GroupTask, WireBot, WireGroup, WireMessage, WireTask } from "./wire.ts";

/** The encrypted-link descriptor a paired phone is sent. `routes: "local"` restricts it to Wi-Fi and Tailscale; absent
 * means any route. */
export interface CompanionE2EDescriptor extends PairingE2EDescriptor {
  routes?: "any" | "local";
}

/** GET /api/companion/endpoints, and the body of a `companion.endpoints` frame: where a paired phone may connect. */
export interface CompanionEndpointsSnapshot {
  serverName: string;
  endpoints: CompanionEndpoint[];
  /** The desktop app's or server's release version (x.y.z, maybe with a suffix); absent from older versions. */
  version?: string;
  e2e?: CompanionE2EDescriptor;
}

/** A paired phone. A computer's companion sends its whole record; a server or Cloud sends only the first four fields. */
export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess?: boolean;
  browserControlAccess?: boolean;
  routes?: "any" | "local";
  e2eAt?: number;
}

/** POST /api/pair: 201 from a computer's companion, 200 from a server or Cloud. */
export interface PairResponse {
  token: string;
  device: PairedDevice;
  serverName: string;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  e2e?: CompanionE2EDescriptor;
}

/** A signed-in session as the server describes it, never with its token. */
export interface PairedSession {
  id: string;
  label: string;
  scopes: Array<"admin" | "client">;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  email?: string;
  owner?: string;
  teamRole?: string;
  token?: true;
}

/** POST /api/auth/pair with a 12-character code, from a phone (no `cookie`). */
export interface AuthPairResponse {
  token: string;
  session: PairedSession;
  environment: EnvironmentDescriptor;
}

/** One page of a conversation, newest last. */
export interface WireMessagePage<Message = WireMessage> {
  messages: Message[];
  hasMore?: boolean;
  activeLeafId: string | null;
}

/** Whether someone holds a bot's computer, and the sign-in plea it stands for. */
export interface WireComputerControl {
  held: boolean;
  helpReason: string | null;
  help?: ComputerHelpRef;
}

/** GET /api/bots?messages=N: the fleet, each bot and room with the newest page of its selected conversation. */
export interface BotsResponse<Message = WireMessage> {
  bots: Array<WireBot & WireMessagePage<Message>>;
  botQueuedMessages: BotQueuedMessages;
  sections: string[];
  groups: Array<WireGroup & WireMessagePage<Message>>;
  /** By bot id. */
  computerControl: Record<string, WireComputerControl>;
}

/** One match in GET /api/search, in a bot's conversation (`botId`) or a room's (`groupId`). */
export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  snippet: string;
  /** Where the match starts in `snippet`, and how long it is, in UTF-16 code units. */
  matchStart: number;
  matchLength: number;
  from?: string;
  botId?: string;
  groupId?: string;
  /** The bot's or room's name. */
  name: string;
  /** The conversation's title. */
  task?: string;
  /** False for a message on a branch the conversation has left. */
  onActivePath: boolean;
}

/** GET /api/search?q=…[&threadId=…][&limit=1–100]. */
export interface SearchResponse {
  hits: SearchHit[];
}

/** One model an engine offers. */
export interface WireModelOption {
  id: string;
  label: string;
  custom?: boolean;
  provider?: string;
}

/** One AI engine set up on the server, as GET /api/instances lists it: the fields a phone reads. Each entry carries more
 * that only the desktop's settings use. */
export interface WireInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  readOnly?: boolean;
  snapshot: {
    state: "available" | "unavailable";
    /** Why it can't be used, in plain words. */
    reason?: string;
    authenticated?: boolean;
  };
  models: { default: string; options: WireModelOption[] };
  capabilities?: { images?: boolean; effortLevels?: readonly string[] };
  access?: "subscription" | "custom" | "api";
}

/** GET /api/instances. */
export interface InstancesResponse {
  instances: WireInstance[];
}

/** GET /api/auth/session for a caller on this computer with no session. */
export interface LoopbackSessionResponse {
  kind: "loopback";
  scopes: ReadonlyArray<"admin" | "client">;
  environmentId: string;
  trust?: "service";
}

/** GET /api/auth/session for a signed-in session, a paired phone's included. Optional fields are absent, never false. */
export interface SignedInSessionResponse {
  kind: "session";
  id: string;
  label: string;
  scopes: ReadonlyArray<"admin" | "client">;
  expiresAt: number;
  via: "bearer" | "cookie" | "ticket";
  environmentId: string;
  email?: string;
  owner?: string;
  hosted?: true;
  cloudHome?: true;
  /** How a team member signs in again, on a team Cloud. */
  teamSignIn?: string;
  /** The person owns this server outright. */
  own?: true;
  /** What the owner's desktop lends this server by default; only with `own`. */
  lending?: Readonly<Record<string, boolean>>;
  team?: { id: string; name: string; role: "owner" | "admin" | "member" } | null;
  /** Conversations this person opened, on a team or as a guest on a personal Cloud. */
  openedThreads?: string[];
  cloudGuest?: true;
  /** Whose reactions are this person's, where several people share the workspace. */
  reactor?: string;
}

/** GET /api/auth/session. */
export type AuthSessionResponse = LoopbackSessionResponse | SignedInSessionResponse;

/** POST /api/bots (201): the new bot with its first conversation. */
export interface BotCreateResponse<Message = WireMessage> {
  bot: WireBot & { messages: Message[]; activeLeafId: string | null };
  /** It was made but something after that didn't take; each in plain words. */
  warnings?: string[];
  /** Made asleep: the plan's awake limit is reached. */
  paused?: true;
}

/** PATCH /api/bots/:id. */
export interface BotUpdateResponse {
  bot: WireBot;
  /** In plain words, when the change left something behind (a server computer it moved off). */
  notice?: string;
}

/** POST /api/groups (201): the new room, with no messages yet. */
export interface RoomCreateResponse<Message = WireMessage> {
  group: WireGroup & { messages: Message[] };
}

/** PATCH /api/groups/:id and PATCH /api/groups/:id/setup. */
export interface RoomUpdateResponse {
  group: WireGroup;
}

/** POST /api/bots/:id/tasks (201) and its fork, and PATCH /api/bots/:id/tasks/:threadId. */
export interface TaskResponse {
  bot: WireBot;
  task: WireTask;
}

/** POST /api/groups/:id/tasks (201) and its fork. */
export interface RoomTaskCreateResponse {
  group: WireGroup;
  task: GroupTask;
}

/** PATCH /api/groups/:id/tasks/:threadId. */
export interface RoomTaskUpdateResponse {
  task: GroupTask;
}
