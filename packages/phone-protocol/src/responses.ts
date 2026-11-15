import type { EnvironmentDescriptor } from "./environment.ts";
import type { CompanionEndpoint, PairingE2EDescriptor } from "./pairing-link.ts";
import type { BotQueuedMessages, ComputerHelpRef, WireBot, WireGroup, WireMessage } from "./wire.ts";

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
