// The proactive inbox on the helper models: Clairic reads each new email (sender, the ask, any deadline or amount, whether
// it waits on a reply, what kind of mail it is), and Clef decides important, needs a reply, or skip, hearing the senders
// the person recently dismissed. Neither model can act, so this works whatever engine the Chief uses. Email text reaches
// them only as cleaned data. One failed decision fails the batch, which then waits for the next check: no email is
// dropped half-sorted.
import type { AppConfig } from "../config.ts";
import type { EmailHeader } from "../connected-reads.ts";
import { deciderReady, type Decider } from "../decider/index.ts";
import { inboxTriageRequest, INBOX_TRIAGE_TIMEOUT_MS, type InboxDetails } from "../decider/inbox-triage.ts";
import { INBOX_FIELDS, INBOX_TEXT_MAX } from "../extractor/contract.ts";
import { extractorReady, type Extractor } from "../extractor/index.ts";
import { clean, defuse } from "../records-block.ts";
import { PICKS_PER_TRIAGE } from "./check-plan.ts";

const EXTRACT_TIMEOUT_MS = 6_000;
const AT_ONCE = 4;

export interface InboxPick { id: string; why: string; needsReply: boolean }

export interface InboxTriageDeps {
  decider: Pick<Decider, "choose">;
  extractor: Pick<Extractor, "extract">;
  config(): AppConfig;
}

/** One email as the extraction model reads it: cleaned, never more than the relay takes. */
export function inboxText(email: Pick<EmailHeader, "from" | "subject" | "preview">): string {
  const text = `From: ${clean(email.from, 200)}\nSubject: ${clean(email.subject, 300)}\n\n${defuse(email.preview).trim()}`;
  return Array.from(text).slice(0, INBOX_TEXT_MAX).join("");
}

/** A one-line why in plain code, from what the extraction read; never a model's own sentence. Empty when it read nothing
 * worth saying: the card already says "Waiting on your reply" or "Important". */
export function pickWhy(details: InboxDetails | undefined): string {
  const ask = typeof details?.ask === "string" && details.ask.trim() ? clean(details.ask, 120).replace(/^to\s+/i, "") : "";
  const parts = [
    ask ? `Asks you to ${ask}` : "",
    typeof details?.deadline === "string" ? `due ${details.deadline}` : "",
    typeof details?.amount === "number" ? `about ${details.amount.toLocaleString("en-US")}` : "",
  ].filter(Boolean);
  return parts.length ? clean(`${parts.join(", ")}.`, 240) : "";
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) out.push(...await Promise.all(items.slice(start, start + size).map(work)));
  return out;
}

export function createInboxTriage(deps: InboxTriageDeps) {
  return {
    /** Decisions are on and their inbox job too: the helper models sort the mail, not an AI turn. */
    ready: (): boolean => deciderReady(deps.config(), "inboxTriage"),
    /** The picks among `emails`, most likely first; null when any decision failed, so the batch waits. */
    async triage(emails: readonly EmailHeader[], dismissedFrom: readonly string[]): Promise<InboxPick[] | null> {
      const reads = extractorReady(deps.config());
      const judged = await inBatches(emails, AT_ONCE, async (email) => {
        const read = reads ? await deps.extractor.extract("inboxTriage", INBOX_FIELDS, { text: inboxText(email) }, { timeoutMs: EXTRACT_TIMEOUT_MS }) : null;
        const details = read?.ok ? Object.fromEntries(Object.entries(read.values).filter(([, value]) => value !== null)) as InboxDetails : undefined;
        const { state, question } = inboxTriageRequest({ email, ...(details ? { details } : {}), dismissedFrom });
        const decided = await deps.decider.choose("inboxTriage", state, question, { timeoutMs: INBOX_TRIAGE_TIMEOUT_MS });
        // Too large for the relay is too large every time: that email is skipped, never asked about again.
        if (!decided.ok && decided.reason === "too_large") return { email, details, verdict: "skip" as const, keep: 0 };
        return decided.ok ? { email, details, verdict: decided.answers.choice, keep: 1 - (decided.answers.probabilities.skip ?? 0) } : null;
      });
      if (judged.some((one) => one === null)) return null;
      return judged
        .flatMap((one) => (one && one.verdict !== "skip" ? [one] : []))
        .sort((a, b) => b.keep - a.keep)
        .slice(0, PICKS_PER_TRIAGE)
        .map((one) => ({ id: one.email.id, why: pickWhy(one.details), needsReply: one.verdict === "reply" }));
    },
  };
}

export type InboxTriage = ReturnType<typeof createInboxTriage>;
