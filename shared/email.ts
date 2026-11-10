// The Email connector's fixed names, shared by the server (tools, per-bot checks) and the app (bot settings, the card).
// Tool names are upper-snake with the EMAIL_ prefix so the connector grant and scope rules apply unchanged.

/** The connector slug in a bot's connectorScopes.apps and connectorTools. */
export const EMAIL_SLUG = "email";
/** The MCP server name bots see (tools arrive as mcp__email__EMAIL_<ACTION>). */
export const EMAIL_MCP_SERVER = "email";
/** What a bot passes as request_credential's credential_id for the mailbox card. */
export const EMAIL_CREDENTIAL = "email";

export const EMAIL_READ_TOOL_NAMES = ["EMAIL_LIST_MAILBOXES", "EMAIL_LIST_MESSAGES", "EMAIL_SEARCH_MESSAGES", "EMAIL_READ_MESSAGE"] as const;
export const EMAIL_TOOL_NAMES = [...EMAIL_READ_TOOL_NAMES, "EMAIL_SEND_MESSAGE"] as const;
export type EmailToolName = (typeof EMAIL_TOOL_NAMES)[number];

/** Where a mailbox's mail server is, when the person types it. */
export interface EmailServerFields {
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  username?: string;
}

export interface EmailConnectRequest extends EmailServerFields {
  address: string;
  password: string;
}

export interface EmailAccountView {
  address: string;
  imapHost: string;
  /** The server that sends, once one took the password. */
  smtpHost?: string;
  connectedAt: string;
  /** Why it needs the person, in one plain sentence. */
  problem?: string;
}

/** GET /api/email. */
export interface EmailStatus {
  state: "unavailable" | "signed-out" | "connected";
  accounts: EmailAccountView[];
  /** Why it is unavailable here. */
  reason?: string;
}

/** What POST /api/email/accounts answers: read a real header, or why not. `needsServer`: nothing was found, so the person
 * types where their mail server is. */
export type EmailConnectAnswer =
  | { ok: true; account: EmailAccountView; inbox: { messages: number; newest?: { from: string; subject: string } }; sending: { ok: boolean; problem?: string } }
  | { ok: false; error: string; needsServer?: true };
