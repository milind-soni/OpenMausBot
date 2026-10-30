import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import type { CloudCancelAnswer, CloudCancelSurvey, CloudRenewalResult } from "../../electron/cloud-account.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export const CLOUD_CALL_URL = "https://cal.com/milind-soni-002qed/30min";
const ANSWERS: readonly CloudCancelAnswer[] = ["feature", "price", "setup", "broken", "later", "other"];
const ANSWER_LABEL: Record<CloudCancelAnswer, LocaleKey> = {
  feature: "cloudCancel.answer.feature", price: "cloudCancel.answer.price", setup: "cloudCancel.answer.setup",
  broken: "cloudCancel.answer.broken", later: "cloudCancel.answer.later", other: "cloudCancel.answer.other",
};
const BOX_MAX = 2_000;

/** Main cancels and keeps the plan; the page only says what the person answered. */
export interface CloudRenewalActions {
  cancel(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keep(): Promise<CloudRenewalResult>;
}

const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));
const endsAt = (renewal: CloudRenewal) => renewal.endsAt ?? renewal.renewsAt;

export function endedLine(renewal: CloudRenewal): string {
  const at = endsAt(renewal);
  if (renewal.trial) return at ? t("cloudCancel.endedTrial", { date: day(at) }) : t("cloudCancel.endedTrialNoDate");
  return at ? t("cloudCancel.endedPlan", { date: day(at) }) : t("cloudCancel.endedPlanNoDate");
}

export function stopsLine(renewal: CloudRenewal): string {
  const stops = renewal.team ? t("cloudCancel.teamStops", { team: renewal.team }) : t("cloudCancel.stops");
  const kept = renewal.keptDays;
  if (kept === null) return stops;
  const files = kept <= 0 ? t("cloudCancel.keptNone") : !Number.isInteger(kept) ? t("cloudCancel.keptHours", { hours: Math.max(1, Math.round(kept * 24)) })
    : kept === 1 ? t("cloudCancel.keptDay") : t("cloudCancel.keptDays", { days: kept });
  return `${stops} ${files}`;
}

function leadLine(renewal: CloudRenewal): string {
  const runs = renewal.renewsAt ? t(renewal.trial ? "cloudCancel.runsTrial" : "cloudCancel.runsPlan", { date: day(renewal.renewsAt) }) : null;
  return [runs, t(renewal.trial ? "cloudCancel.nothingCharged" : "cloudCancel.noMoreCharges"), renewal.team ? t("cloudCancel.teamStops", { team: renewal.team }) : null]
    .filter(Boolean).join(" ");
}

export function CloudCancelPlan({ renewal, actions, onChanged }: { renewal: CloudRenewal | undefined; actions: CloudRenewalActions | null; onChanged?: () => void }) {
  const [opened, setOpened] = useState<CloudRenewal | null>(null);
  const [keeping, setKeeping] = useState(false), [note, setNote] = useState<"failed" | "browser" | null>(null);
  if (!renewal || !actions) return null;
  const keep = () => {
    setKeeping(true); setNote(null);
    void actions.keep().then(result => {
      if (result.outcome === "kept") onChanged?.();
      else setNote(result.outcome === "browser" ? "browser" : "failed");
    }, () => setNote("failed")).finally(() => setKeeping(false));
  };
  return <>
    {renewal.cancelled
      ? <div data-cloud-cancel="cancelled" className="flex flex-col items-start gap-2 self-start">
        <p role="status" className="text-[13px] text-ink">{endedLine(renewal)}</p>
        <button type="button" className="ui-button" disabled={keeping} onClick={keep}>{t(keeping ? "cloudCancel.keeping" : "cloudCancel.keep")}</button>
        {note && <p role={note === "failed" ? "alert" : "status"} className={cn("text-[13px]", note === "failed" ? "text-danger" : "text-ink-secondary")}>
          {t(note === "failed" ? "cloudCancel.failed" : "cloudCancel.browser")}</p>}
      </div>
      : <button type="button" data-cloud-cancel="renewing" className="ui-button self-start" onClick={() => { setNote(null); setOpened(renewal); }}>
        {t(renewal.trial ? "cloudCancel.cancelTrial" : "cloudCancel.cancelPlan")}</button>}
    {opened && <CloudCancelSheet renewal={opened} actions={actions} onClose={changed => { setOpened(null); if (changed) onChanged?.(); }} />}
  </>;
}

type Step = { step: "ask" } | { step: "done"; renewal: CloudRenewal; surveyed: boolean } | { step: "browser" };

export function CloudCancelSheet({ renewal, actions, onClose }: { renewal: CloudRenewal; actions: CloudRenewalActions; onClose: (changed: boolean) => void }) {
  const [picked, setPicked] = useState<CloudCancelAnswer | null>(null);
  const [expected, setExpected] = useState(""), [improve, setImprove] = useState("");
  const [state, setState] = useState<Step>({ step: "ask" });
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const changed = useRef(false), dialog = useRef<HTMLDivElement>(null);
  const close = () => { if (!busy) onClose(changed.current); };
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("button[aria-pressed]")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const run = (work: () => Promise<void>) => {
    setBusy(true); setFailed(false);
    void work().catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  const cancel = () => run(async () => {
    const said = picked !== null || expected.trim() !== "" || improve.trim() !== "";
    const result = await actions.cancel(said ? { answer: picked, ...(expected.trim() ? { expected } : {}), ...(improve.trim() ? { improve } : {}) } : null);
    if (result.outcome === "cancelled") {
      changed.current = true;
      setState({ step: "done", renewal: result.renewal ?? { ...renewal, cancelled: true, endsAt: renewal.renewsAt, renewsAt: null }, surveyed: result.surveyed });
    } else if (result.outcome === "browser") setState({ step: "browser" });
    else setFailed(true);
  });
  const keep = () => run(async () => {
    const result = await actions.keep();
    if (result.outcome === "kept") { changed.current = true; onClose(true); }
    else if (result.outcome === "browser") setState({ step: "browser" });
    else setFailed(true);
  });
  const title = t(renewal.trial ? "cloudCancel.titleTrial" : "cloudCancel.titlePlan");
  const box = "mt-1.5 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[14px] text-ink disabled:opacity-60";
  const alert = failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t("cloudCancel.failed")}</p>;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="cloud-cancel-title" aria-busy={busy} tabIndex={-1} data-cloud-cancel-sheet={state.step}
        className="flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const controls = dialog.current?.querySelectorAll<HTMLElement>("a[href], textarea:enabled, button:enabled");
            if (!controls?.length) return;
            const first = controls[0]!, last = controls[controls.length - 1]!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <header className="flex items-start justify-between gap-3 px-6 pb-1 pt-5">
          <h2 id="cloud-cancel-title" className="text-[17px] font-semibold">{title}</h2>
          <button type="button" aria-label={t("cloudCancel.close")} disabled={busy} onClick={close} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-1">
          {state.step === "ask" && <>
            <p className="text-[13px] leading-relaxed text-ink-secondary">{leadLine(renewal)}</p>
            <fieldset className="mt-4" disabled={busy}>
              <legend className="text-[14px] font-medium text-ink">{t("cloudCancel.question")}</legend>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {ANSWERS.map(answer => <button key={answer} type="button" aria-pressed={picked === answer} onClick={() => setPicked(current => current === answer ? null : answer)}
                  className={cn("ui-button ui-button-pill", picked === answer && "border-accent bg-accent/10 font-medium")}>{t(ANSWER_LABEL[answer])}</button>)}
              </div>
            </fieldset>
            <label className="mt-4 block text-[13px] text-ink">{t("cloudCancel.expected")} <span className="text-ink-secondary">{t("cloudCancel.optional")}</span>
              <textarea rows={2} maxLength={BOX_MAX} value={expected} disabled={busy} onChange={event => setExpected(event.target.value)} className={box} /></label>
            <label className="mt-3 block text-[13px] text-ink">{t("cloudCancel.improve")} <span className="text-ink-secondary">{t("cloudCancel.optional")}</span>
              <textarea rows={2} maxLength={BOX_MAX} value={improve} disabled={busy} onChange={event => setImprove(event.target.value)} className={box} /></label>
            <p className="mt-3 text-[12px] text-ink-secondary">{t("cloudCancel.talk")}{" "}
              <a href={CLOUD_CALL_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">{t("cloudCancel.book")}</a></p>
            {alert}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className="ui-button" disabled={busy} onClick={close}>{t("cloudCancel.keep")}</button>
              <button type="button" data-cloud-cancel-confirm className="ui-button border-transparent bg-danger text-white hover:brightness-110" disabled={busy} onClick={cancel}>
                {t(busy ? "cloudCancel.cancelling" : renewal.trial ? "cloudCancel.confirmTrial" : "cloudCancel.confirmPlan")}</button>
            </div>
          </>}
          {state.step === "done" && <>
            <p role="status" className="text-[14px] font-medium text-ink">{endedLine(state.renewal)}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{stopsLine(state.renewal)}</p>
            {state.surveyed && <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("cloudCancel.thanks")}</p>}
            {alert}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-ink-secondary">{t("cloudCancel.changedMind")}</span>
              <button type="button" className="ui-button" disabled={busy} onClick={keep}>{t(busy ? "cloudCancel.keeping" : "cloudCancel.keep")}</button>
              <button type="button" className="ui-button ui-button-primary ms-auto" disabled={busy} onClick={close}>{t("cloudCancel.done")}</button>
            </div>
          </>}
          {state.step === "browser" && <>
            <p role="status" className="text-[13px] leading-relaxed text-ink">{t("cloudCancel.browser")}</p>
            <div className="mt-5 flex justify-end"><button type="button" className="ui-button ui-button-primary" onClick={close}>{t("cloudCancel.done")}</button></div>
          </>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
