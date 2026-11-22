import { useState, type ReactNode } from "react";
import { Check, Globe, Hand, KeyRound, Loader2, LockKeyhole, Monitor, RefreshCw } from "lucide-react";

import { HANDOFF_NOTE_MAX } from "../../shared/sign-in-request";
import type { Surface } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { handoffEnd, handoffPlaceLabel, handoffSummary, handoffTitle, newestWaitingHandoff } from "@/lib/handoff";
import { t } from "@/lib/i18n";
import { answerSignIn, signInHostIsHere } from "@/lib/sign-in";
import type { Bot, Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { ASK_DARK_PRIMARY, ASK_QUIET_BUTTON, ASK_SECONDARY_BUTTON, AskCard, AskError, returnFocusToComposer } from "./AskCard";
import { ELEVATED_CARD } from "./elevated";
import { CookieImportDialog } from "./browser/cookie-import";
import { HandoffPreview } from "./HandoffPreview";
import { HandoffSuggestion, useSignInImport, useSuggestedApp } from "./HandoffSuggestion";

export const placeIcon = (place: Surface) => place === "browser" ? <Globe /> : <Monitor />;

/** The handed-off step once it ended: one row with the place, how it ended and the step. */
export function HandoffSettledRow({ place, summary, action, error }: { place: Surface; summary: string; action?: ReactNode; error?: string }) {
  return (
    <div role="group" aria-label={handoffPlaceLabel(place)} data-ask-card="settled" data-look="handoff"
      className={cn("w-full max-w-[560px] rounded-[18px] px-4 py-3 text-start", ELEVATED_CARD)}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] leading-5">
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-md bg-ink/[0.06] text-ink-secondary ring-[0.5px] ring-inset ring-ink/[0.06] [&>svg]:size-3">
          {placeIcon(place)}
        </span>
        <span className="shrink-0 font-medium text-ink">{handoffPlaceLabel(place)}</span>
        <span dir="auto" aria-live="polite" title={summary} data-handoff-summary="" className="min-w-0 flex-1 truncate text-ink-tertiary">{summary}</span>
        {action}
      </div>
      {error && <p role="alert" className="ms-7 mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * A step the bot handed to the person, where it works: what to do, the place live at card width, and Skip, I'm done and
 * Take over. Take over (or the picture) opens that place full size, already in their control. Once answered it folds to
 * one row. Security: the person types any password or card number into the page; nothing they type passes through here.
 */
export function HandoffCard({ botId, botName, color: _color, threadId, message, showPreview }: {
  botId: string;
  botName: string;
  color?: Bot["color"];
  threadId: string;
  message: Message;
  /** Only the newest open request shows the live picture; by default it is worked out from the bot's messages. */
  showPreview?: boolean;
}) {
  const dispatch = useStoreDispatch();
  const card = message.signIn!;
  const newest = useStoreSelector((state) => newestWaitingHandoff(state.bots.find((bot) => bot.id === botId)?.messages ?? []));
  const end = handoffEnd(card);
  const suggested = useSuggestedApp(card.need === "sign_in" && !end ? card.site : "", botId);
  const [pending, setPending] = useState<"done" | "cancel" | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [explained, setExplained] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importFor = useSignInImport(botId, threadId, !end && card.place === "browser" && card.need === "sign_in" ? card.site : "");
  const ref = { botId, threadId, messageId: message.id, place: card.place };
  const instruction = card.instruction ?? "";
  const placeLabel = handoffPlaceLabel(card.place);

  const answer = async (choice: "done" | "cancel") => {
    if (pending) return;
    setPending(choice);
    setLocalError(null);
    try {
      await answerSignIn(ref, choice, note);
      returnFocusToComposer();
    } catch {
      setLocalError(t("handoff.error"));
    } finally {
      setPending(null);
    }
  };

  if (end) {
    const error = localError ?? card.error;
    const retry = (end === "done" || end === "skipped") && !card.resumed && error ? (
      <button type="button" onClick={() => void answer(end === "done" ? "done" : "cancel")} disabled={pending !== null} className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {pending ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <RefreshCw size={14} />}
        {t("signIn.retry")}
      </button>
    ) : undefined;
    return <HandoffSettledRow place={card.place} summary={handoffSummary(end, instruction)} action={retry} error={retry ? error : undefined} />;
  }

  const takeOver = () => {
    if (card.place === "local") { setExplained(true); return; }
    dispatch({ type: "openSignIn", botId, messageId: message.id, url: card.url, site: card.site, place: card.place, expand: true, threadId });
  };
  const preview = showPreview ?? (newest === null || newest === message.id);
  const minutesLeft = card.expiresAt ? Math.max(1, Math.ceil((card.expiresAt - Date.now()) / 60_000)) : null;
  const here = signInHostIsHere();

  return (
    <>
      <AskCard
        ariaLabel={t("handoff.cardLabel", { name: botName, instruction })}
        kicker={{ icon: placeIcon(card.place), label: placeLabel, meta: minutesLeft !== null && minutesLeft <= 30 ? t("handoff.minutesLeft", { minutes: minutesLeft }) : undefined }}
        title={handoffTitle(card.need)}
        subtitle={<bdi dir="auto">{instruction}</bdi>}
        media={preview && card.place !== "local" ? (
          <HandoffPreview botId={botId} threadId={threadId} place={card.place} onOpen={takeOver} disabled={pending !== null}
            label={t("handoff.previewLabel", { name: botName, place: placeLabel })} />
        ) : undefined}
        footer={<>
          {!noting && (
            <button type="button" onClick={() => setNoting(true)} className={cn(ASK_QUIET_BUTTON, "me-auto -ms-2")}>{t("handoff.addNote")}</button>
          )}
          <button type="button" onClick={() => void answer("cancel")} disabled={pending !== null} aria-busy={pending === "cancel" || undefined}
            title={t("handoff.skipHint", { name: botName })} className={ASK_SECONDARY_BUTTON}>
            {pending === "cancel" && <Loader2 size={14} className="motion-safe:animate-spin" />}
            {t("handoff.skip")}
          </button>
          <button type="button" onClick={() => void answer("done")} disabled={pending !== null} aria-busy={pending === "done" || undefined} className={ASK_SECONDARY_BUTTON}>
            {pending === "done" ? <Loader2 size={14} className="motion-safe:animate-spin" /> : <Check size={14} />}
            {t("handoff.done")}
          </button>
          <button type="button" onClick={takeOver} disabled={pending !== null} className={ASK_DARK_PRIMARY}>
            <Hand size={14} />
            {t("handoff.takeOver")}
          </button>
        </>}
      >
        {noting && (
          <input
            dir="auto"
            autoFocus
            value={note}
            maxLength={HANDOFF_NOTE_MAX}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { setNoting(false); setNote(""); } }}
            aria-label={t("handoff.noteLabel", { name: botName })}
            placeholder={t("handoff.notePlaceholder", { name: botName })}
            className="h-9 w-full rounded-full bg-ink/[0.045] px-3.5 text-[14px] text-ink outline-none ring-[0.5px] ring-ink/[0.14] placeholder:text-ink-tertiary focus:ring-ink/30"
          />
        )}
        {explained && <p role="note" className="text-[13px] leading-snug text-ink">{t(here ? "signIn.local.explain" : "signIn.local.explainHost", { name: botName })}</p>}
        {(card.need === "sign_in" || card.need === "payment") && (
          <p className={cn("flex items-center gap-1 text-[12px] text-ink-tertiary", (noting || explained) && "mt-2")}>
            <LockKeyhole size={11} aria-hidden="true" /> {t("handoff.private")}
          </p>
        )}
        {importFor && (
          <button type="button" onClick={() => setImporting(true)} disabled={pending !== null} data-handoff-import=""
            className={cn(ASK_QUIET_BUTTON, "-ms-2 mt-2")}>
            <KeyRound size={14} aria-hidden="true" />{t("handoff.importSignIn")}
          </button>
        )}
        {localError && <AskError>{localError}</AskError>}
      </AskCard>
      {importFor && (
        <CookieImportDialog open={importing} botId={botId} botName={botName} threadId={importFor.threadId} site={importFor.site}
          onClose={() => setImporting(false)}
          onImported={(imported) => void answerSignIn(ref, "done", `imported the person's sign-in for ${imported.site} from their own ${imported.browser}`).catch(() => undefined)} />
      )}
      {suggested && (
        <HandoffSuggestion app={suggested.card} status={suggested.status} request={ref} botName={botName} />
      )}
    </>
  );
}
