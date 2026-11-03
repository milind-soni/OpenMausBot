import { isOutboundTool, type ConnectorCall } from "../shared/outbound.ts";

const NO_SEND = /\b(?:do\s+not|don['’]t|never|without)\s+send(?:ing)?\b|\bnot\s+sent\b/i;
const DRAFT_REQUEST = /\b(?:create|save|write|prepare|compose|update|revise|edit)\b[^.!?\n]*\bdraft\b|\bdraft\s+(?:a|an|the|my)\s+(?:reply|response|email|message)\b/i;
const REVISION = /\b(?:update|revise|edit|modify|replace)\b[^.!?\n]*\bdraft\b/i;

export function gmailDraftRefusal(request: string, calls: readonly ConnectorCall[]): string | null {
  const draftsOnly = NO_SEND.test(request) || DRAFT_REQUEST.test(request);
  if (!draftsOnly) return null;
  if (calls.some(call => call.slug === "COMPOSIO_PROXY_EXECUTE" || (call.slug.startsWith("GMAIL_") && isOutboundTool(call.slug)))) {
    return "This request authorizes drafts only. Sending and opaque execution were blocked; nothing in this call was performed. Use Gmail draft tools, not send, reply or forward tools. Do not try another route.";
  }
  if (REVISION.test(request) && calls.some(call => call.slug === "GMAIL_CREATE_EMAIL_DRAFT")) {
    return "This request revises an existing draft. Creating another draft was blocked. Find its draft ID with gmail.list_drafts, read it with gmail.read_draft, and use gmail.update_draft with that ID. If updating fails, report the failure; do not create a replacement.";
  }
  return null;
}

// Security invariant: reserve before dispatch, including concurrent batches and uncertain upstream failures.
export function reserveGmailDrafts(calls: readonly ConnectorCall[], reserved: Set<string>): string | null {
  const keys: string[] = [];
  for (const call of calls) {
    if (call.slug !== "GMAIL_CREATE_EMAIL_DRAFT") continue;
    const args = call.arguments as Record<string, unknown> | undefined;
    const thread = args && typeof args.thread_id === "string" ? args.thread_id : "";
    if (!thread) continue;
    const key = JSON.stringify([args?.user_id ?? "me", thread]);
    if (reserved.has(key) || keys.includes(key)) return "Draft creation for this Gmail thread was already attempted in this turn. Read the existing drafts and update the intended draft by ID; do not create another, including after a timeout.";
    keys.push(key);
  }
  for (const key of keys) reserved.add(key);
  return null;
}
