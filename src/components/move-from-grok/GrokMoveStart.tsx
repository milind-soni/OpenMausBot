import { Check, ChevronRight, Copy, FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Chip, PRIMARY, SECONDARY, StepHeading } from "@/components/cloud-welcome/parts";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import type { FoundExports, GrokLook } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { GROK_EXPORT_MAX_CHARS, GROK_EXPORT_PROMPT } from "../../../shared/grok-import";

const STEP = "rounded-2xl bg-card p-4";

/** First screen: send the Bot the message, then bring back what it wrote: found on this computer, pasted or dropped. */
export function GrokMoveStart({ local, found, look, movedNames, error, onBring, onFound, onError }: {
  /** Whether this page is on the computer that has the files. */
  local: boolean;
  found: FoundExports;
  look: GrokLook;
  movedNames: readonly string[];
  error: string;
  onBring: (reply: string) => void;
  onFound: (bot: FoundExports["bots"][number]) => void;
  onError: (error: string) => void;
}) {
  const [reply, setReply] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const { state: copied, copy } = useCopyFeedback(GROK_EXPORT_PROMPT);

  const readFile = useRef(async (_file: File | undefined) => {});
  readFile.current = async (file) => {
    if (!file) return;
    if (file.size > GROK_EXPORT_MAX_CHARS) return onError(t("grokMove.error.tooLarge"));
    onBring(await file.text());
  };
  // The whole window takes the drop: a file let go beside the column must not replace the page.
  useEffect(() => {
    const over = (event: globalThis.DragEvent) => {
      event.preventDefault();
      setDragging(true);
    };
    const leave = () => setDragging(false);
    const drop = (event: globalThis.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      void readFile.current(event.dataTransfer?.files[0]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const isDone = (name: string) => movedNames.includes(name.toLowerCase()) || found.bots.some((bot) => bot.name.toLowerCase() === name.toLowerCase());

  return (
    <section aria-labelledby="grok-move-title" data-grok-move-step="start" className="flex flex-col gap-5">
      <StepHeading id="grok-move-title" title={t("grokMove.start.title")} sub={t("grokMove.start.sub")} />

      {found.bots.length > 0 && (
        <div data-grok-move-found className="flex flex-col gap-2">
          <div className="text-[13px] font-medium text-ink">{t("grokMove.start.found")}</div>
          {found.bots.map((bot) => (
            <button key={bot.name} type="button" onClick={() => onFound(bot)}
              className="flex items-center gap-3 rounded-2xl border border-accent/40 bg-accent/[0.06] p-3.5 text-left transition-colors hover:bg-accent/[0.1]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-ink">{bot.name}</span>
                <span className="block truncate text-[13px] text-ink-secondary">{t("grokMove.start.foundSummary", { skills: bot.skills.length, routines: bot.routines.length })}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-accent-text">{t("grokMove.start.bring")}<ChevronRight size={14} aria-hidden="true" /></span>
            </button>
          ))}
        </div>
      )}
      {found.refused.map((item) => <p key={item.file} role="alert" className="text-[13px] leading-relaxed text-danger">{t("grokMove.start.refused", { file: item.file, reason: item.error })}</p>)}

      <div className={STEP}>
        <div className="text-[15px] font-medium text-ink">{t("grokMove.start.step1")}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.start.step1Hint")}</p>
        {look.bots.length > 0 && (
          <div data-grok-move-roster className="mt-3">
            <div className="text-[12px] text-ink-secondary">{t("grokMove.start.roster")}</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {look.bots.map((name) => (
                <Chip key={name}>{isDone(name) && <Check size={12} strokeWidth={2.5} aria-label={t("grokMove.start.rosterDone")} className="mr-1 inline text-success" />}{name}</Chip>
              ))}
            </div>
          </div>
        )}
        <button type="button" data-grok-move-copy onClick={copy} className={cn(PRIMARY, "mt-3 inline-flex items-center gap-2")}>
          {copied === "copied" ? <Check size={15} /> : <Copy size={15} />}
          {copied === "copied" ? t("grokMove.start.copied") : copied === "failed" ? t("grokMove.start.copyFailed") : t("grokMove.start.copy")}
        </button>
      </div>

      <div className={cn(STEP, dragging && "ring-2 ring-accent/60")}>
        <div className="text-[15px] font-medium text-ink">{t("grokMove.start.step2")}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{t(local ? "grokMove.start.step2HintLocal" : "grokMove.start.step2Hint")}</p>
        <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={4}
          aria-label={t("grokMove.start.replyLabel")} placeholder={t("grokMove.start.replyPlaceholder")}
          className="mt-3 w-full resize-y rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
        {error && <p role="alert" className="mt-2 text-[13px] leading-relaxed text-danger">{error}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" data-grok-move-continue disabled={!reply.trim()} onClick={() => onBring(reply)} className={PRIMARY}>{t("onboarding.continue")}</button>
          <button type="button" onClick={() => picker.current?.click()} className={cn(SECONDARY, "inline-flex items-center gap-2")}><FileUp size={15} />{t("grokMove.start.chooseFile")}</button>
          <input ref={picker} type="file" accept=".json,.md,.txt,application/json,text/plain,text/markdown" className="hidden" onChange={(event) => { void readFile.current(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
      </div>
    </section>
  );
}
