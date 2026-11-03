import { Check, Copy, FileUp, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { foundExports, grokErrorText, lookForGrokBot, NOTHING_FOUND, previewGrokMove, runGrokMove, type GrokLook, type GrokPreview, type GrokReport } from "@/lib/grok-move";
import { t } from "@/lib/i18n";
import { localSetupImport } from "@/lib/setup-import";
import { api, useStore } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { GROK_EXPORT_MAX_CHARS, GROK_EXPORT_PROMPT, GROK_NOTES_FILE, parseGrokExport, type GrokBot, type GrokItem, type GrokItemKind } from "../../shared/grok-import";

const PRIMARY = "ui-button ui-button-primary min-h-9 px-4 text-[14px]";
const SECONDARY = "ui-button min-h-9 px-4 text-[14px]";
const KINDS: readonly GrokItemKind[] = ["bot", "skill", "routine", "memory", "app"];

const reasonText = (item: GrokItem) => (item.reason ? t(`grokMove.reason.${item.reason}` as LocaleKey, item.values ?? {}) : "");

function Row({ item, label }: { item: GrokItem; label?: string }) {
  const reason = reasonText(item);
  return (
    <li className="break-words">
      {label && <span className="text-ink-secondary">{label}: </span>}
      <span className="text-ink">{item.name}</span>
      {reason && <span className="text-ink-secondary"> · {reason}</span>}
      {item.details && <div className="text-ink-secondary">{item.details}</div>}
      {item.instruction && (
        <details className="text-ink-secondary">
          <summary className="cursor-pointer text-accent-text">{t("grokMove.seeInstruction")}</summary>
          <p className="mt-1 whitespace-pre-wrap">{item.instruction}</p>
        </details>
      )}
    </li>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[14px] font-medium text-ink">{title}</h3>
      {note && <p className="text-[13px] leading-relaxed text-ink-secondary">{note}</p>}
      {children}
    </section>
  );
}

const LIST = "flex flex-col gap-1 text-[13px] leading-relaxed";

/** The preview and the report are one list: what comes over by kind, then everything that didn't. */
export function GrokItems({ items, warnings, report }: { items: readonly GrokItem[]; warnings: readonly string[]; report: boolean }) {
  const having = (status: GrokItem["status"]) => items.filter((item) => item.status === status);
  const kindLabel = (kind: GrokItemKind) => t(`grokMove.kind.${kind}` as LocaleKey);
  const others = ["conflict", "skipped", "error"] as const;
  const groupTitle = { conflict: "grokMove.group.conflict", skipped: "grokMove.group.skipped", error: "grokMove.group.error" } as const;
  return (
    <>
      <Group title={t(report ? "grokMove.group.imported.report" : "grokMove.group.imported.preview")}>
        {KINDS.map((kind) => {
          const rows = having("imported").filter((item) => item.kind === kind);
          return (
            <div key={kind} data-grok-kind={kind}>
              <div className="text-[13px] text-ink-secondary">{kindLabel(kind)}: {rows.length}</div>
              {rows.length > 0 && <ul className={cn(LIST, "pl-3")}>{rows.map((item, index) => <Row key={index} item={item} />)}</ul>}
            </div>
          );
        })}
      </Group>
      {having("notes").length > 0 && (
        <Group title={t("grokMove.group.notes")} note={t("grokMove.notesLocation", { file: GROK_NOTES_FILE })}>
          <ul className={LIST}>{having("notes").map((item, index) => <Row key={index} item={item} />)}</ul>
        </Group>
      )}
      {others.map((status) => having(status).length > 0 && (
        <Group key={status} title={t(groupTitle[status])}>
          <ul className={LIST}>{having(status).map((item, index) => <Row key={index} item={item} label={kindLabel(item.kind)} />)}</ul>
        </Group>
      ))}
      {warnings.length > 0 && (
        <Group title={t("grokMove.group.warnings")}>
          <ul className={LIST}>{warnings.map((line) => <li key={line} className="text-ink">{line}</li>)}</ul>
        </Group>
      )}
    </>
  );
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
      setPreview(previewGrokMove(bots, {
        look, bots: state.bots, servers: new Set(servers.map((server) => server.name)), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
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
  useEffect(() => {
    if (!onStart) return;
    const over = (event: DragEvent) => event.preventDefault();
    const drop = (event: DragEvent) => {
      event.preventDefault();
      readFile.current(event.dataTransfer?.files[0]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
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
        className="ui-modal animate-pop-in flex max-h-[min(720px,calc(100dvh-32px))] w-[560px] max-w-full flex-col overflow-hidden text-left outline-none">
        <div className="flex h-[52px] shrink-0 items-center justify-between pl-4 pr-3">
          <h2 id="grok-move-title" className="text-[14px] font-semibold leading-[22px] text-ink">
            {report ? t("grokMove.reportTitle") : preview ? t("grokMove.previewTitle") : t("settings.import.grokTitle")}
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
              <GrokItems items={report.items} warnings={report.warnings} report />
              {report.routines.length > 0 && (
                <Group title={t("grokMove.group.next")}>
                  <p className="text-[13px] leading-relaxed text-ink">{t("grokMove.next.routines", { names: report.routines.join(", ") })}</p>
                </Group>
              )}
            </>
          ) : preview ? (
            <>
              <p className="text-[13px] leading-relaxed text-ink-secondary">{t("grokMove.previewNote")}</p>
              <GrokItems items={[...preview.plans.flatMap((plan) => plan.items), ...preview.items]} warnings={preview.warnings} report={false} />
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
