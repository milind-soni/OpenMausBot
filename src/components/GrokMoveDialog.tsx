import { Check, Copy, FileUp, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { foundExports, grokErrorText, lookForGrokBot, NOTHING_FOUND, previewGrokMove, runGrokMove, type GrokLook, type GrokPreview, type GrokReport } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { localSetupImport } from "@/lib/setup-import";
import { api, useStore } from "@/state/store";
import { GROK_EXPORT_MAX_CHARS, GROK_EXPORT_PROMPT, parseGrokExport, type GrokBot } from "../../shared/grok-import";

const PRIMARY = "ui-button ui-button-primary min-h-9 px-4 text-[14px]";
const SECONDARY = "ui-button min-h-9 px-4 text-[14px]";
const LINE = "text-[13px] leading-relaxed text-ink-secondary";

/** A Bot as one heading and a count per kind; a kind it has none of is left out. */
export function BotCounts({ heading, skills, routines, memories, notes, skillsOff }: {
  heading: string; skills: number; routines: number; memories: number; notes: number; skillsOff: readonly string[];
}) {
  const rows = [
    [t("grokMove.count.skills"), skills], [t("grokMove.count.routines"), routines], [t("grokMove.count.memories"), memories], [t("grokMove.count.notes"), notes],
  ] as const;
  return (
    <section data-grok-move-bot className="flex flex-col gap-1.5">
      <h3 className="break-words text-[15px] font-semibold text-ink">{heading}</h3>
      <dl className="flex flex-col gap-1 text-[14px]">
        {rows.filter(([, count]) => count > 0).map(([label, count]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-ink-secondary">{label}</dt>
            <dd className="tabular-nums text-ink">{count}</dd>
          </div>
        ))}
      </dl>
      {skillsOff.length > 0 && <p className={LINE}>{t("grokMove.skillsOff", { names: skillsOff.join(", ") })}</p>}
    </section>
  );
}

export function GrokMoveLines({ paused, files = null, apps, moved, unreadable, failed = [] }: { paused: string | null; files?: string | null; apps: number; moved: readonly string[]; unreadable: readonly string[]; failed?: readonly string[] }) {
  const lines = [
    paused,
    files,
    apps === 1 ? t("grokMove.appsOne") : apps > 1 ? t("grokMove.appsMany", { count: apps }) : null,
    moved.length ? t("grokMove.alreadyHere", { names: moved.join(", ") }) : null,
    unreadable.length ? t("grokMove.unreadable", { names: unreadable.join(", ") }) : null,
    failed.length ? t("grokMove.notAdded", { names: failed.join(", ") }) : null,
  ].filter((line) => line !== null);
  return lines.length > 0 && <div className="flex flex-col gap-1">{lines.map((line) => <p key={line} className={LINE}>{line}</p>)}</div>;
}

function BringBack({ local, look, found, reply, error, onReply, onFile, onFound }: {
  local: boolean;
  look: GrokLook;
  found: ReturnType<typeof foundExports>;
  reply: string;
  error: string;
  onReply: (reply: string) => void;
  onFile: (file: File | undefined) => void;
  onFound: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const { state: copied, copy } = useCopyFeedback(GROK_EXPORT_PROMPT);
  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.intro")}</p>
      <section className="flex flex-col items-start gap-1.5">
        <h3 className="text-[14px] font-medium text-ink">{t("grokMove.step1")}</h3>
        <p className="text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.step1Hint")}</p>
        {local && look.bots.length > 0 && <p data-grok-move-roster className="text-[13px] text-ink-secondary">{t("grokMove.roster", { names: look.bots.join(", ") })}</p>}
        <button type="button" data-grok-move-copy onClick={copy} className={cn(SECONDARY, "mt-1 inline-flex items-center gap-2")}>
          {copied === "copied" ? <Check size={15} /> : <Copy size={15} />}
          {copied === "copied" ? t("grokMove.copied") : copied === "failed" ? t("grokMove.copyFailed") : t("grokMove.copy")}
        </button>
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[14px] font-medium text-ink">{t("grokMove.step2")}</h3>
        <p className="text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.step2Hint")}</p>
        {found.bots.length > 0 && (
          <div data-grok-move-found className="mt-1 flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/[0.06] px-3 py-2">
            <span className="min-w-0 break-words text-[13px] text-ink">{t("grokMove.found", { names: found.bots.map((bot) => bot.name).join(", ") })}</span>
            <button type="button" data-grok-move-use-found onClick={onFound} className={cn(PRIMARY, "shrink-0")}>{t("grokMove.useFound")}</button>
          </div>
        )}
        {found.refused.map((item) => <p key={item.file} role="alert" className="text-[13px] leading-relaxed text-danger">{t("grokMove.refused", { file: item.file, reason: item.error })}</p>)}
        <textarea value={reply} onChange={(event) => onReply(event.target.value)} rows={4}
          aria-label={t("grokMove.replyLabel")} placeholder={t("grokMove.replyPlaceholder")}
          className="mt-1 w-full resize-y rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none" />
        {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
        <div>
          <button type="button" onClick={() => picker.current?.click()} className={cn(SECONDARY, "inline-flex items-center gap-2")}><FileUp size={15} />{t("grokMove.chooseFile")}</button>
          <input ref={picker} type="file" accept=".json,.md,.txt,application/json,text/plain,text/markdown" className="hidden" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
      </section>
    </>
  );
}

/** Settings → Import → Move from Grok Bot: the message, what the Bot wrote, the preview, the import, the report. Nothing on
 * this computer is read until this dialog is open. */
export function GrokMoveDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const local = localSetupImport(state.config?.cloudHome === true);
  const [look, setLook] = useState<GrokLook>(NOTHING_FOUND);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<GrokPreview | null>(null);
  const [report, setReport] = useState<GrokReport | null>(null);
  const [importing, setImporting] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (local) void lookForGrokBot().then(setLook);
  }, [local]);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  useEffect(() => root.current?.focus({ preventScroll: true }), [preview, report]);

  const found = useMemo(() => foundExports(look.files), [look.files]);

  const show = async (read: () => GrokBot[]) => {
    try {
      const bots = read();
      const servers = await api<{ servers?: Array<{ name: string }> }>("/api/mcp/servers").then((answer) => answer.servers ?? [], () => []);
      setPreview(previewGrokMove(bots, { bots: state.bots, servers: new Set(servers.map((server) => server.name)), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
      setError("");
    } catch (cause) {
      setError(grokErrorText(cause));
    }
  };

  const readFile = useRef<(file: File | undefined) => void>(() => {});
  readFile.current = (file) => {
    if (!file) return;
    if (file.size > GROK_EXPORT_MAX_CHARS) return setError(t("grokMove.error.tooLarge"));
    void file.text().then((text) => show(() => parseGrokExport(text)));
  };
  const onStart = !preview && !report;
  // The chat box behind this dialog attaches any file dropped on the window, and one Send would hand a private export to its
  // model. So nothing behind the dialog sees a drag, on any step, and only the first step reads what was dropped.
  useEffect(() => {
    const hold = (event: DragEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      hold(event);
      if (onStart) readFile.current(event.dataTransfer?.files[0]);
    };
    const listeners = [["dragenter", hold], ["dragover", hold], ["dragleave", hold], ["drop", drop]] as const;
    for (const [type, listener] of listeners) window.addEventListener(type, listener, true);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
    };
  }, [onStart]);

  const start = async () => {
    if (!preview) return;
    setImporting(true);
    const done = await runGrokMove(preview, dispatch);
    track("team_imported", { members: preview.plans.length, source: "grok", mode: "add", format: "package" });
    setReport(done);
    setPreview(null);
    setImporting(false);
  };
  const another = () => {
    setReport(null);
    setReply("");
    setError("");
    refresh();
  };

  return (
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) onClose(); }}>
      <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="grok-move-title" data-grok-move={report ? "report" : preview ? "preview" : "start"}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || importing) return;
          event.preventDefault();
          event.stopPropagation();
          if (preview) setPreview(null);
          else onClose();
        }}
        className="ui-modal animate-pop-in flex max-h-[min(720px,calc(100dvh-32px))] w-[560px] max-w-full flex-col overflow-hidden text-start outline-none">
        <div className="flex h-[52px] shrink-0 items-center justify-between ps-4 pe-3">
          <h2 id="grok-move-title" className="text-[14px] font-semibold leading-[22px] text-ink">
            {preview ? t("grokMove.previewTitle") : t("settings.import.grokTitle")}
          </h2>
          <button type="button" disabled={importing} onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40">
            <X size={16} />
          </button>
        </div>
        <div className="ui-modal-divider shrink-0" />
        <div key={report ? "report" : preview ? "preview" : "start"} data-grok-move-body className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [scrollbar-width:thin]">
          {report ? (
            <>
              {report.bots.map((bot) => <BotCounts key={bot.name} heading={t("grokMove.isHere", { name: bot.name })} {...bot} />)}
              <GrokMoveLines paused={report.bots.some((bot) => bot.routines > 0) ? t("grokMove.pausedReport") : null} files={t("grokMove.filesStay")} apps={report.bots.reduce((total, bot) => total + bot.apps, 0)}
                moved={report.moved} unreadable={report.unreadable} failed={report.failed} />
            </>
          ) : preview ? (
            <>
              {preview.plans.map((plan) => (
                <BotCounts key={plan.packageId} heading={plan.addedAs} skills={plan.skills.length} routines={plan.routines} memories={plan.memories} notes={plan.notes}
                  skillsOff={plan.skills.filter((skill) => !skill.on).map((skill) => skill.name)} />
              ))}
              <GrokMoveLines paused={preview.plans.some((plan) => plan.routines > 0) ? t("grokMove.pausedPreview") : null} apps={preview.plans.reduce((total, plan) => total + plan.apps, 0)}
                moved={preview.moved} unreadable={preview.unreadable} />
            </>
          ) : (
            <BringBack local={local} look={look} found={found} reply={reply} error={error} onReply={setReply}
              onFile={(file) => readFile.current(file)} onFound={() => void show(() => found.bots)} />
          )}
        </div>
        <div className="ui-modal-divider shrink-0" />
        <div className="flex shrink-0 justify-end gap-2 p-3">
          {report ? (
            <>
              <button type="button" data-grok-move-another onClick={another} className={SECONDARY}>{t("grokMove.another")}</button>
              <button type="button" data-grok-move-done onClick={onClose} className={PRIMARY}>{t("common.done")}</button>
            </>
          ) : preview ? (
            <>
              <button type="button" disabled={importing} onClick={() => setPreview(null)} className={SECONDARY}>{t("grokMove.back")}</button>
              <button type="button" data-grok-move-import disabled={importing || !preview.plans.length} onClick={() => void start()} className={cn(PRIMARY, "inline-flex items-center gap-2")}>
                {importing && <Loader2 size={15} className="animate-spin" />}
                {importing ? t("grokMove.importing") : t("grokMove.import")}
              </button>
            </>
          ) : (
            <button type="button" data-grok-move-continue disabled={!reply.trim()} onClick={() => void show(() => parseGrokExport(reply))} className={PRIMARY}>{t("onboarding.continue")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
