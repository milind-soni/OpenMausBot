// The proactive inbox's decision: important, needs a reply, or skip, for one email. Fixed instructions and options so
// Cloud's relay can check the request's shape (relay.ts); the email reaches the model only as cleaned data in `state`.
import { clean } from "../records-block.ts";

/** Cloud's relay accepts inbox triage only with these exact instructions and options. */
export const INBOX_TRIAGE_INSTRUCTIONS = "Does the person need to see `email` today? `details` were read from it by a model and may be wrong; `dismissed_senders` lists senders whose mail they recently waved away.";
export const INBOX_TRIAGE_OPTIONS = {
  reply: "It waits on a reply from the person: a direct question or request to them from someone real.",
  important: "They must not miss it, though no reply is needed: a deadline, money owed or due, a change to their plans, or someone they work with.",
  skip: "It can wait: newsletters, receipts, notifications, marketing, automated mail, and mail like what they recently dismissed.",
} as const;
export type InboxVerdict = keyof typeof INBOX_TRIAGE_OPTIONS;
/** The relay accepts no other key; `email` is required. */
export const INBOX_TRIAGE_STATE_KEYS = ["email", "details", "dismissed_senders"] as const;
export const INBOX_EMAIL_KEYS = ["from", "subject", "preview"] as const;
export const INBOX_DISMISSED_MAX = 20;
export const INBOX_TRIAGE_TIMEOUT_MS = 4_000;

export type InboxDetails = Record<string, string | number | boolean | null>;

export interface InboxTriageInput {
  email: { from: string; subject: string; preview: string };
  details?: InboxDetails;
  dismissedFrom?: readonly string[];
}

export function inboxTriageRequest(input: InboxTriageInput) {
  const details = input.details && Object.keys(input.details).length
    ? Object.fromEntries(Object.entries(input.details).map(([key, value]) => [key, typeof value === "string" ? clean(value, 300) : value]))
    : undefined;
  const dismissed = (input.dismissedFrom ?? []).slice(0, INBOX_DISMISSED_MAX).map((from) => clean(from, 160)).filter(Boolean);
  return {
    state: {
      email: { from: clean(input.email.from, 160), subject: clean(input.email.subject, 200), preview: clean(input.email.preview, 600) },
      ...(details ? { details } : {}),
      ...(dismissed.length ? { dismissed_senders: dismissed } : {}),
    },
    question: { instructions: INBOX_TRIAGE_INSTRUCTIONS, options: { ...INBOX_TRIAGE_OPTIONS } },
  };
}
