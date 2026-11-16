import { Check, Copy, ExternalLink, FileUp, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { track } from "@/lib/analytics";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { foundExports, grokConnector, grokErrorText, lookForGrokBot, MAUSBOT_GROK_TEMPLATE_URL, NOTHING_FOUND, previewGrokMove, runGrokMove, type GrokConnector, type GrokLook, type GrokPreview, type GrokReport } from "@/lib/grok-move";
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

const NO_CONNECTOR: Pick<GrokConnector, "available" | "connectorUrl" | "stopped"> = { available: false, stopped: false };
const POLL_MS = 3_000;

/** The other way over: a link Grok Bot is given once, which the MausBot bot there sends every Bot through. */
function ConnectGrokBot({ url, stopped, names, error, busy, onConnect, onUse }: {
  url: string | undefined; stopped: boolean; names: readonly string[]; error: boolean; busy: boolean; onConnect: () => void; onUse: () => void;
}) {
  const arrived = names.length > 0 && (
    <div data-grok-move-arrived role="status" className="mt-1 flex w-full items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent/[0.06] px-3 py-2">
      <span className="min-w-0 break-words text-[13px] text-ink">{t("grokMove.connect.arrived", { names: names.join(", ") })}</span>
      <button type="button" data-grok-move-use-arrived onClick={onUse} className={cn(PRIMARY, "shrink-0")}>{t("grokMove.useFound")}</button>
    </div>
  );
  const { state: copied, copy } = useCopyFeedback(url ?? "");
  return (
    <section data-grok-move-connect className="flex flex-col items-start gap-1.5">
      <h3 className="text-[14px] font-medium text-ink">{t("grokMove.connect.title")}</h3>
      <p className={LINE}>{t("grokMove.connect.hint")}</p>
      {url ? (
        <>
          <div className="mt-1 flex w-full items-center gap-2">
            <input readOnly value={url} aria-label={t("grokMove.connect.linkLabel")} onFocus={(event) => event.target.select()}
              className="min-w-0 flex-1 rounded-xl border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:outline-none" />
            <button type="button" data-grok-move-copy-link onClick={copy} className={cn(SECONDARY, "inline-flex shrink-0 items-center gap-2")}>
              {copied === "copied" ? <Check size={15} /> : <Copy size={15} />}
              {copied === "copied" ? t("grokMove.copied") : copied === "failed" ? t("grokMove.copyFailed") : t("grokMove.connect.copy")}
            </button>
          </div>
          <p className={LINE}>{t("grokMove.connect.where")}</p>
          <p className={LINE}>{t("grokMove.connect.private")}</p>
          <button type="button" data-grok-move-template onClick={() => void openExternalLink(MAUSBOT_GROK_TEMPLATE_URL)} className={cn(SECONDARY, "mt-1 inline-flex items-center gap-2")}>
            <ExternalLink size={15} />{t("grokMove.connect.addBot")}
          </button>
          {arrived}
        </>
      ) : (
        <>
          {stopped && <p role="status" data-grok-move-stopped className={LINE}>{t("grokMove.connect.stopped")}</p>}
          {arrived}
          <button type="button" data-grok-move-connect-start disabled={busy} onClick={onConnect} className={cn(SECONDARY, "mt-1 inline-flex items-center gap-2")}>
            {busy && <Loader2 size={15} className="animate-spin" />}{t("grokMove.connect.start")}
          </button>
        </>
      )}
      {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{t("grokMove.connect.failed")}</p>}
    </section>
  );
}

function BringBack({ connect, local, look, found, reply, error, onReply, onFile, onFound }: {
  connect: ReactNode;
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
      {connect}
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
export function GrokMoveDialog({ onClose, inline = false }: { onClose: () => void; inline?: boolean }) {
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

  const onStart = !preview && !report;
  const [connector, setConnector] = useState(NO_CONNECTOR);
  const [arrivedFiles, setArrivedFiles] = useState<GrokLook["files"]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const lastSeq = useRef(0);
  /** The Bots in the preview came through the link, so a finished import ends it. */
  const viaLink = useRef(false);
  const arrived = useMemo(() => foundExports(arrivedFiles).bots, [arrivedFiles]);
  /** Leaving the dialog ends the link, so nothing stays open to the internet once the person has left the move. */
  const linkOpen = useRef(false);
  const left = useRef(false);
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
      if (linkOpen.current) void grokConnector("DELETE").catch(() => {});
    };
  }, []);
  const takeConnector = useCallback((next: GrokConnector) => {
    linkOpen.current = Boolean(next.connectorUrl);
    setConnector({ available: next.available, stopped: next.stopped, ...(next.connectorUrl ? { connectorUrl: next.connectorUrl } : {}) });
    if (!next.connectorUrl && !next.stopped) {
      lastSeq.current = 0;
      setArrivedFiles([]);
    } else if (next.seq > lastSeq.current) {
      // Two looks may overlap: each arrival is taken once.
      const fresh = next.arrived.filter((file) => Number(file.name) > lastSeq.current);
      lastSeq.current = next.seq;
      setArrivedFiles((files) => [...files, ...fresh]);
    }
  }, []);
  useEffect(() => {
    if (local) void grokConnector("GET").then(takeConnector, () => {});
  }, [local, takeConnector]);
  useEffect(() => {
    if (!connector.connectorUrl || !onStart) return;
    const timer = setInterval(() => void grokConnector("GET", lastSeq.current).then(takeConnector, () => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [connector.connectorUrl, onStart, takeConnector]);
  const connect = async () => {
    setConnecting(true);
    setConnectFailed(false);
    await grokConnector("POST").then((next) => {
      if (!left.current) return takeConnector(next);
      if (next.connectorUrl) void grokConnector("DELETE").catch(() => {});
    }, () => setConnectFailed(true));
    setConnecting(false);
  };

  const show = async (read: () => GrokBot[], fromLink = false) => {
    try {
      const bots = read();
      viaLink.current = fromLink;
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
    if (viaLink.current && done.bots.length > 0 && done.failed.length === 0) {
      // Best effort: a link left behind stops working on its own within the hour.
      void grokConnector("DELETE").then(takeConnector, () => {});
    }
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

  const panel = (
      <div ref={root} tabIndex={-1} {...(inline ? {} : { role: "dialog", "aria-modal": true, "aria-labelledby": "grok-move-title" })} data-grok-move={report ? "report" : preview ? "preview" : "start"}
        onKeyDown={(event) => {
          if (inline || event.key !== "Escape" || importing) return;
          event.preventDefault();
          event.stopPropagation();
          if (preview) setPreview(null);
          else onClose();
        }}
        className={inline ? "mt-3 flex flex-col rounded-lg border border-hairline/40 text-left outline-none" : "ui-modal animate-pop-in flex max-h-[min(720px,calc(100dvh-32px))] w-[560px] max-w-full flex-col overflow-hidden text-left outline-none"}>
        {(!inline || preview) && <><div className="flex h-[52px] shrink-0 items-center justify-between pl-4 pr-3">
          <h2 id="grok-move-title" className="text-[14px] font-semibold leading-[22px] text-ink">
            {preview ? t("grokMove.previewTitle") : t("settings.import.grokTitle")}
          </h2>
          {!inline && <button type="button" disabled={importing} onClick={onClose} aria-label={t("common.close")} title={t("common.close")}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40">
            <X size={16} />
          </button>}
        </div>
        <div className="ui-modal-divider shrink-0" /></>}
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
              onFile={(file) => readFile.current(file)} onFound={() => void show(() => found.bots)}
              connect={local && connector.available && (
                <ConnectGrokBot url={connector.connectorUrl} stopped={connector.stopped} names={arrived.map((bot) => bot.name)} error={connectFailed} busy={connecting}
                  onConnect={() => void connect()} onUse={() => void show(() => arrived, true)} />
              )} />
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
  );
  if (inline) return panel;
  return (
    <div className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) onClose(); }}>
      {panel}
    </div>
  );
}
