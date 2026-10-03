/**
 * Durable payload carried by an MCP server confirmation card
 * (propose_mcp_server).
 *
 * A Chief of Staff proposes to add, update, enable, disable or remove one
 * custom MCP server. The card carries what the user is shown and nothing
 * secret: environment and header NAMES, and whether a sign-in client secret
 * is set, never their values. Values a bot supplied are held in server
 * memory until the card settles (`heldSecrets`). `expectedRevision` is a hash
 * of the stored entry at proposal time, so a confirmation fails closed if
 * the entry moved; `appliedRevision` is the hash the entry has once this
 * card is applied, so a duplicate confirmation never applies twice. Both
 * hash the entry with every env value, header value and client secret
 * masked, so no secret value influences anything written to the card.
 */
export const MCP_SERVER_REQUEST_ACTIONS = ["add", "update", "enable", "disable", "remove"] as const;
export type McpServerRequestAction = (typeof MCP_SERVER_REQUEST_ACTIONS)[number];

/** One server's launch spec as the card shows it. */
export interface McpServerRequestSpec {
  transport: "command" | "http" | "sse";
  command?: string;
  args?: string[];
  envNames?: string[];
  url?: string;
  headerNames?: string[];
  oauth?: { clientId: string; scopes: string[]; clientSecretSet: boolean };
  enabled: boolean;
}

export interface McpServerRequestCardData {
  version: 1;
  requestId: string;
  /** The proposing conversation; authority is fixed here. */
  botId: string;
  threadId: string;
  action: McpServerRequestAction;
  name: string;
  createdAt: number;
  reason: string;
  /** The stored entry the user was shown; absent for add. */
  before?: McpServerRequestSpec;
  /** The entry after this change; absent for remove. */
  after?: McpServerRequestSpec;
  /** Names whose new values were supplied with this proposal (and the
   * client secret, when one was). Their values live only in server memory. */
  suppliedSecrets: { env: string[]; headers: string[]; clientSecret: boolean };
  /** True when confirming needs values held in server memory. */
  heldSecrets: boolean;
  expectedRevision: string;
  appliedRevision: string;
  appliedAt?: number;
}
