import { useState } from "react";

import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { api, ApiError, type Message } from "@/state/store";
import { EMAIL_DRAFT_PATH, splitAddresses, type EmailDraftCardData, type EmailDraftEdit } from "../../shared/email-draft";

const GMAIL_DRAFTS = "https://mail.google.com/mail/#drafts";

const LINES = "li, tr";
const PARAGRAPHS = "p, div, h1, h2, h3, h4, h5, h6, blockquote, pre, table, ul, ol";

/** The text an HTML body shows: what a reader sees, never its markup, with its line and paragraph breaks. */
export function draftBodyText(card: Pick<EmailDraftCardData, "body" | "html">): string {
  if (!card.html) return card.body;
  const page = new DOMParser().parseFromString(card.body, "text/html");
  const { body } = page;
  for (const element of body.querySelectorAll("script, style")) element.remove();
  // Line breaks in the markup itself draw as spaces; only <br> and blocks break lines.
  const words = page.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = words.nextNode(); node; node = words.nextNode()) if (!node.parentElement?.closest("pre")) node.nodeValue = (node.nodeValue ?? "").replace(/\s+/g, " ");
  for (const element of body.querySelectorAll("br")) element.replaceWith("\n");
  for (const element of body.querySelectorAll(LINES)) element.after("\n");
  // A block starts its own paragraph after text before it as well as before text after it: <div>Hi<p>Ana</p></div>.
  for (const element of body.querySelectorAll(PARAGRAPHS)) { element.before("\n\n"); element.after("\n\n"); }
  return (body.textContent ?? "").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface Fields { to: string; cc: string; bcc: string; subject: string; body: string }

const fieldsOf = (card: EmailDraftCardData): Fields =>
  ({ to: card.to.join(", "), cc: card.cc.join(", "), bcc: card.bcc.join(", "), subject: card.subject, body: card.body });

/** The draft as the card shows it: what an edit starts from. */
const baseOf = (card: EmailDraftCardData): EmailDraftEdit => ({ to: card.to, cc: card.cc, bcc: card.bcc, subject: card.subject, body: card.body });

export function editOf(fields: Fields): EmailDraftEdit {
  return { to: splitAddresses(fields.to), cc: splitAddresses(fields.cc), bcc: splitAddresses(fields.bcc), subject: fields.subject, body: fields.body };
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2 text-[13px]">
      <span className="w-14 shrink-0 text-ink-tertiary">{label}</span>
      <bdi dir="auto" className="min-w-0 break-words text-ink">{value}</bdi>
    </div>
  );
}

function Field({ label, value, onChange, multiline, disabled }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; disabled: boolean }) {
  const look = "w-full rounded-lg bg-inset px-2 py-1 text-[13px] text-ink outline-none focus:border-ink/40";
  return (
    <label className="flex flex-col gap-1 text-[12px] text-ink-tertiary">
      {label}
      {multiline
        ? <textarea dir="auto" rows={8} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={look} />
        : <input dir="auto" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={look} />}
    </label>
  );
}

export function EmailDraftCard({ threadId, message, viewOnly }: { threadId?: string; message: Message; viewOnly?: boolean }) {
  const card = message.emailDraft!;
  const [editing, setEditing] = useState<Fields | null>(null);
  // The draft as the card showed it when editing started: Save sends it, and the server saves nothing if Gmail changed since.
  const [base, setBase] = useState<EmailDraftEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = !viewOnly && Boolean(threadId) && !card.sentAt;
  // A card sent meanwhile (the bot sent it) drops what was being edited: it only shows what was sent.
  const [sentAt, setSentAt] = useState(card.sentAt);
  if (sentAt !== card.sentAt) {
    setSentAt(card.sentAt);
    setEditing(null);
  }

  const save = async (draft: EmailDraftEdit): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await api(EMAIL_DRAFT_PATH, { method: "POST", body: JSON.stringify({ threadId, messageId: message.id, action: "save", base, draft }) });
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      // Changed in Gmail meanwhile: the card now shows that version, and the edit started from an older one.
      if (failure instanceof ApiError && failure.body?.errorKey === "serverError.emailDraft.changed") setEditing(null);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const button = "ui-button ui-button-sm";
  return (
    <div data-email-draft={card.draftId} data-email-draft-sent={card.sentAt ? "" : undefined}
      className="flex w-full max-w-[600px] flex-col gap-2 rounded-2xl border border-hairline/45 bg-card px-3.5 py-3 shadow-sm">
      <div className="text-[12px] font-medium text-ink-tertiary">{t(card.sentAt ? "chat.emailDraft.sent" : "chat.emailDraft.title")}</div>
      {editing && live ? (
        <form className="flex flex-col gap-2" onSubmit={(event) => {
          event.preventDefault();
          void save(editOf(editing)).then((saved) => { if (saved) setEditing(null); });
        }}>
          <Field label={t("chat.emailDraft.to")} value={editing.to} onChange={(to) => setEditing({ ...editing, to })} disabled={saving} />
          <Field label={t("chat.emailDraft.cc")} value={editing.cc} onChange={(cc) => setEditing({ ...editing, cc })} disabled={saving} />
          <Field label={t("chat.emailDraft.bcc")} value={editing.bcc} onChange={(bcc) => setEditing({ ...editing, bcc })} disabled={saving} />
          <Field label={t("chat.emailDraft.subject")} value={editing.subject} onChange={(subject) => setEditing({ ...editing, subject })} disabled={saving} />
          <Field label={t("chat.emailDraft.body")} value={editing.body} onChange={(body) => setEditing({ ...editing, body })} multiline disabled={saving} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving} className={`${button} ui-button-primary`}>{t(saving ? "common.saving" : "common.save")}</button>
            <button type="button" disabled={saving} onClick={() => { setEditing(null); setError(null); }} className={button}>{t("common.cancel")}</button>
          </div>
        </form>
      ) : (
        <>
          <Line label={t("chat.emailDraft.to")} value={card.to.join(", ") || t("chat.emailDraft.noRecipient")} />
          {card.cc.length > 0 && <Line label={t("chat.emailDraft.cc")} value={card.cc.join(", ")} />}
          {card.bcc.length > 0 && <Line label={t("chat.emailDraft.bcc")} value={card.bcc.join(", ")} />}
          <Line label={t("chat.emailDraft.subject")} value={card.subject || t("chat.emailDraft.noSubject")} />
          <p dir="auto" className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words border-t border-hairline/45 pt-2 text-[14px] leading-relaxed text-ink">{draftBodyText(card)}</p>
          <div className="flex flex-wrap gap-2">
            {live && !card.html && <button type="button" disabled={saving} onClick={() => { setEditing(fieldsOf(card)); setBase(baseOf(card)); }} className={button}>{t("chat.emailDraft.edit")}</button>}
            {!card.sentAt && <button type="button" onClick={() => void openExternalLink(card.url ?? GMAIL_DRAFTS)} className={button}>{t("chat.emailDraft.openInGmail")}</button>}
          </div>
        </>
      )}
      {error && <p role="alert" dir="auto" className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}
