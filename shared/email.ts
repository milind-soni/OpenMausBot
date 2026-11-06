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

/** How a mail server speaks TLS: from the first byte, or upgraded with STARTTLS. Never in the clear. */
export type EmailSecurity = "tls" | "starttls";

/** Where a mailbox's outgoing server is, when the person types it, and its own sign-in when that isn't the incoming
 * server's. A password left out is the mailbox's own. */
export interface EmailOutgoingFields {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: EmailSecurity;
  smtpUsername?: string;
  smtpPassword?: string;
}

/** Where a mailbox's mail servers are, when the person types them. */
export interface EmailServerFields extends EmailOutgoingFields {
  imapHost?: string;
  imapPort?: number;
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
  smtpPort?: number;
  smtpSecurity?: EmailSecurity;
  /** The outgoing server's own user name, when it has one. */
  smtpUsername?: string;
  /** While sending doesn't work: the outgoing server the reason is about, to start the form with. */
  smtpTried?: Pick<EmailOutgoingFields, "smtpHost" | "smtpPort" | "smtpSecurity">;
  connectedAt: string;
  /** Why it needs the person, in one plain sentence. */
  problem?: string;
  /** Why sending doesn't work, in one plain sentence naming the server; none while it works. */
  sendingProblem?: string;
}

/** What POST /api/email/accounts/:address/outgoing answers: it checked sending again, at the server typed there (an
 * EmailOutgoingFields body) or the ones found for the address, without signing in to read again. */
export type EmailOutgoingAnswer = { ok: true; account: EmailAccountView } | { ok: false; error: string; account?: EmailAccountView };

/** A provider whose own sign-in fits better than a mailbox password: its app in Connected apps (`app`, its slug there),
 * or an app password made at `appPasswordUrl`. */
export interface EmailSignInHint {
  provider: string;
  app?: "gmail" | "outlook";
  appPasswordUrl?: string;
}

/** POST /api/email/accounts/:address/test: a message from the mailbox to itself. */
export type EmailTestAnswer = { ok: true } | { ok: false; error: string };

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
  | { ok: true; account: EmailAccountView; inbox: { messages: number; newest?: { from: string; subject: string } }; sending: { ok: boolean; problem?: string; signIn?: EmailSignInHint } }
  | { ok: false; error: string; needsServer?: true; signIn?: EmailSignInHint };
