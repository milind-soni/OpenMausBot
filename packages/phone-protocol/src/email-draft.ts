/** A Gmail draft a bot saved, drawn in chat as a card: the person reads it, edits and saves it, or opens it in Gmail to
 * send it. The server writes it after the bot's draft call succeeds; only the server edits it. */
export interface EmailDraftCardData {
  app: "gmail";
  draftId: string;
  /** The bot whose connected apps saved it, and so run its Save. */
  botId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** The body is HTML, drawn as text and saved back as HTML. */
  html?: true;
  /** The Gmail thread a reply draft belongs to. */
  threadId?: string;
  /** The connected account the bot named, so Save reaches the same mailbox. */
  account?: string;
  /** Gmail's own https link to the draft. */
  url?: string;
  /** Set once the bot sent it: the card then only shows what was sent. */
  sentAt?: number;
}

export interface EmailDraftField {
  /** The draft drawn as a card the person can edit or open in Gmail; `text` is the line every other client shows. */
  emailDraft?: EmailDraftCardData;
}

/** What Save sends: the whole draft as the person left it. */
export interface EmailDraftEdit {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export const EMAIL_DRAFT_PATH = "/api/email-draft";
export const EMAIL_DRAFT_LIMITS = { recipients: 50, address: 320, subject: 1_000, body: 100_000 } as const;

/** Addresses typed in one field, split on commas, semicolons and new lines. */
export function splitAddresses(value: string): string[] {
  return value.split(/[,;\n]/).map((one) => one.trim()).filter(Boolean);
}
