import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { diagnosticsByDefault, SUPPORT_LIMITS, SUPPORT_TOPICS, type SupportInput, type SupportResult, type SupportTopic } from "../../electron/support-request.mjs";
import { cn } from "@/lib/cn";
import { readSupportDiagnostics, supportOffer, supportProblems } from "@/lib/contact-support";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ACTIONS, CLOSE, FIELD, PRIMARY, QUIET, SHEET } from "./cloud-buy/parts";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import { usageBridge } from "./CloudUsageMeter";
import { Layer } from "./Layer";
import { Select } from "./Select";
import { useModalDialog } from "../hooks/use-modal-dialog";

const TOPIC_LABEL: Record<SupportTopic, LocaleKey> = {
  billing: "support.topic.billing", broken: "support.topic.broken", question: "support.topic.question", other: "support.topic.other",
};
type Offer = NonNullable<CloudPlanSnapshot["support"]>;
/** What the form says above its buttons when a send didn't go through: it stays open to try again. */
type Note = { key: "support.failed" | "support.signIn" | "support.full" } | { key: "support.refused"; detail: string };
const FINAL = new Set<SupportResult["outcome"]>(["sent", "queued", "off", "unavailable"]);

/** The Help menu's Contact support for the account signed in here: `open` only while it may write (supportOffer). */
export function useContactSupport(cloudHome: boolean): { open: (() => void) | undefined; dialog: ReactNode } {
  const bridge = usageBridge(cloudHome);
  const offer = supportOffer(useCloudPlanSnapshot(bridge), bridge);
  const [opened, setOpened] = useState(false);
  const send = bridge?.support;
  return {
    open: offer ? () => setOpened(true) : undefined,
    dialog: opened && offer && send ? <ContactSupportDialog offer={offer} send={(input) => send(input)} diagnostics={readSupportDiagnostics} onClose={() => setOpened(false)} /> : null,
  };
}

function ByEmail({ email }: { email: string }) {
  const { state, copy } = useCopyFeedback(email);
  return <div className="flex flex-wrap items-center gap-2" data-support-email>
    <span className="text-[14px] text-ink">{t("support.byEmail", { email })}</span>
    <button type="button" className={QUIET} onClick={copy}>{t(state === "copied" ? "support.copied" : "support.copy")}</button>
  </div>;
}

function Outcome({ result, email }: { result: SupportResult; email: string }) {
  switch (result.outcome) {
    case "sent": return <>
      <p role="status" className="text-[15px] font-medium text-ink">{t("support.sent", { report: result.id })}</p>
      <p className="text-[14px] text-ink-secondary">{t("support.replyTime")}</p>
    </>;
    case "queued": return <>
      <p role="status" className="text-[14px] text-ink">{t("support.queued")}</p>
      <ByEmail email={email} />
    </>;
    case "off": return <div role="status"><ByEmail email={result.email} /></div>;
    default: return <p role="status" className="text-[14px] text-ink">{t("support.unavailable")}</p>;
  }
}

/**
 * Contact support: a topic, a message, where to reply (the signed-in address to start), and the app's diagnostics when the
 * person includes them; Send and Cancel. Then the report number, or that it is saved and goes by itself, with the address to
 * write to. While the Admin has it switched off (`offer.form` false) it opens on that address alone.
 */
export function ContactSupportDialog({ offer, send, diagnostics, onClose }: {
  offer: Offer;
  send: (input: SupportInput) => Promise<SupportResult>;
  diagnostics: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [topic, setTopic] = useState<SupportTopic | "">("");
  const [message, setMessage] = useState(""), [replyTo, setReplyTo] = useState(offer.account ?? "");
  const [include, setInclude] = useState(false), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [result, setResult] = useState<SupportResult | null>(offer.form ? null : { outcome: "off", email: offer.email });
  const read = useRef<Promise<string | null> | null>(null);
  const dialog = useRef<HTMLDivElement>(null), fields = useRef<HTMLFormElement>(null);
  const id = useId();
  const close = () => { if (!busy) onClose(); };
  useModalDialog(dialog, close);
  // Read ahead once included, so Send needs nothing more than the person's click.
  useEffect(() => { if (include && !read.current) read.current = diagnostics(); }, [include, diagnostics]);
  const problems = supportProblems({ topic, message, replyTo });
  const shown = (field: keyof typeof problems) => checked && problems[field];
  const pick = (value: SupportTopic) => { setTopic(value); setInclude(diagnosticsByDefault(value)); };
  const submit = async () => {
    setChecked(true); setNote(null);
    if (busy) return;
    if (problems.topic || problems.message || problems.replyTo) {
      fields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setBusy(true);
    try {
      const text = include ? await (read.current ??= diagnostics()) : null;
      const sent = await send({ topic: topic as SupportTopic, message, replyTo: replyTo.trim(), ...(text ? { diagnostics: text } : {}) });
      if (FINAL.has(sent.outcome)) setResult(sent);
      else setNote(sent.outcome === "refused" ? { key: "support.refused", detail: sent.detail.replace(/[.\s]+$/, "") } : { key: sent.outcome === "signin" ? "support.signIn" : sent.outcome === "full" ? "support.full" : "support.failed" });
    } catch {
      setNote({ key: "support.failed" });
    } finally {
      setBusy(false);
    }
  };
  const describe = (field: string, problem: boolean) => problem ? { "aria-invalid": true as const, "aria-describedby": `${id}-${field}-problem` } : {};
  const problemLine = (field: string, key: LocaleKey, problem: boolean) => problem && <span id={`${id}-${field}-problem`} className="text-[13px] text-danger">{t(key)}</span>;
  const label = "flex flex-col gap-1.5 text-[13px] font-medium text-ink";
  return <Layer modal><div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy} data-contact-support={result ? result.outcome : "form"}
      className={cn(SHEET, "relative flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-y-auto outline-none")}>
      <button type="button" onClick={close} disabled={busy} aria-label={t("support.close")} className={cn(CLOSE, "absolute end-4 top-4 z-10")}><X size={16} /></button>
      <div className="flex flex-col gap-4 px-6 pb-6 pt-5">
        <h2 id={`${id}-title`} className="pe-10 text-[17px] font-medium leading-6 text-ink">{t("support.title")}</h2>
        {result ? <>
          <Outcome result={result} email={offer.email} />
          <div className={ACTIONS}><button type="button" className={PRIMARY} onClick={close}>{t("support.done")}</button></div>
        </> : <form ref={fields} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <p className="text-[14px] leading-5 text-ink-secondary">{t("support.lead")}</p>
          <label className={label}>{t("support.topic")}
            <Select value={topic} required autoFocus disabled={busy} onChange={(event) => pick(event.target.value as SupportTopic)} {...describe("topic", shown("topic"))}>
              <option value="" disabled>{t("support.topic.choose")}</option>
              {SUPPORT_TOPICS.map((value) => <option key={value} value={value}>{t(TOPIC_LABEL[value])}</option>)}
            </Select>
            {problemLine("topic", "support.need.topic", shown("topic"))}
          </label>
          <label className={label}>{t("support.message")}
            <textarea rows={6} required maxLength={SUPPORT_LIMITS.message} value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)}
              className={cn(FIELD, "h-auto resize-y py-2 font-normal leading-5")} {...describe("message", shown("message"))} />
            {problemLine("message", "support.need.message", shown("message"))}
          </label>
          <label className={label}>{t("support.replyTo")}
            <input type="email" required autoComplete="email" maxLength={SUPPORT_LIMITS.replyTo} value={replyTo} disabled={busy} onChange={(event) => setReplyTo(event.target.value)}
              className={cn(FIELD, "font-normal")} {...describe("replyTo", shown("replyTo"))} />
            {problemLine("replyTo", "support.need.replyTo", shown("replyTo"))}
          </label>
          <label className="flex items-start gap-2 text-[13px] text-ink">
            <input type="checkbox" className="mt-1 accent-accent" checked={include} disabled={busy} onChange={(event) => setInclude(event.target.checked)} aria-describedby={`${id}-diagnostics`} />
            <span>{t("support.diagnostics")}<span id={`${id}-diagnostics`} className="mt-0.5 block text-[12px] text-ink-secondary">{t("support.diagnosticsHint")}</span></span>
          </label>
          {note && <p role="alert" className="text-[13px] text-danger">{note.key === "support.refused" ? t(note.key, { detail: note.detail }) : t(note.key)}</p>}
          <div className={ACTIONS}>
            <button type="button" className={QUIET} disabled={busy} onClick={close}>{t("support.cancel")}</button>
            <button type="submit" className={PRIMARY} disabled={busy}>{t(busy ? "support.sending" : "support.send")}</button>
          </div>
        </form>}
      </div>
    </div>
  </div></Layer>;
}
