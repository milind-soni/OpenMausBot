/** A Gmail draft a bot saved, drawn in chat as a card: the person reads it, edits and saves it, sends it after a
 * confirmation, or opens it in Gmail. The server writes it after the bot's draft call succeeds; only the server edits it. */
export interface EmailDraftCardData {
  app: "gmail";
  draftId: string;
  /** The bot whose connected apps saved it, and so run its Save and Send. */
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
  /** The connected account the bot named, so Save and Send reach the same mailbox. */
  account?: string;
  /** Gmail's own https link to the draft. */
  url?: string;
  /** Set once the person sent it from the card: the card then only shows what was sent. */
  sentAt?: number;
}

export interface EmailDraftField {
  /** The draft drawn as a card the person can edit, send or open in Gmail; `text` is the line every other client shows. */
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

/** A short fingerprint of what the card shows. Send names the one its confirmation showed, so the server sends nothing
 *  when the draft changed since (a bot updated it meanwhile). */
export function draftRevision(card: Pick<EmailDraftCardData, "to" | "cc" | "bcc" | "subject" | "body" | "html">): string {
  const shown = JSON.stringify([card.to, card.cc, card.bcc, card.subject, card.body, card.html === true]);
  let one = 0xdeadbeef, two = 0x41c6ce57;
  for (let i = 0; i < shown.length; i++) {
    const code = shown.charCodeAt(i);
    one = Math.imul(one ^ code, 2654435761);
    two = Math.imul(two ^ code, 1597334677);
  }
  one = Math.imul(one ^ (one >>> 16), 2246822507) ^ Math.imul(two ^ (two >>> 13), 3266489909);
  two = Math.imul(two ^ (two >>> 16), 2246822507) ^ Math.imul(one ^ (one >>> 13), 3266489909);
  return (4294967296 * (2097151 & two) + (one >>> 0)).toString(36);
}

/** Addresses typed in one field, split on commas, semicolons and new lines. */
export function splitAddresses(value: string): string[] {
  return value.split(/[,;\n]/).map((one) => one.trim()).filter(Boolean);
}
