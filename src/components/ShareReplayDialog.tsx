// Share replay: a finished job as a page of its steps and screenshots. The person sees every step, takes out any
// picture, and only then publishes a link or downloads the file.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Download, Film, Link2, Loader2, X } from "lucide-react";

import { useModalDialog } from "@/hooks/use-modal-dialog";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { closeShareReplay, downloadReplay, loadReplay, publishReplay, useShareReplayTarget, type ReplayPreview } from "@/lib/share-replay";
import type { PublishedPageCard } from "../../shared/published-page";

const button = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40";
const quiet = "inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-40";

/** Mounted once; draws the dialog for the conversation openShareReplay names. */
export function ShareReplayHost() {
  const target = useShareReplayTarget();
  return target ? <ShareReplayDialog key={target.threadId} threadId={target.threadId} /> : null;
}

function ShareReplayDialog({ threadId }: { threadId: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<ReplayPreview | null>(null);
  const [request, setRequest] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<"load" | "publish" | "download" | null>("load");
  const [error, setError] = useState("");
  const [card, setCard] = useState<PublishedPageCard | null>(null);
  const [copied, setCopied] = useState(false);
  useModalDialog(dialog, () => { if (busy !== "publish") closeShareReplay(); });

  useEffect(() => {
    let live = true;
    setBusy("load");
    setError("");
    loadReplay(threadId, request).then((loaded) => {
      if (!live) return;
      setPreview(loaded);
      setTitle(loaded.replay.title);
      setRemoved(new Set());
      setCard(null);
    }).catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (live) setBusy(null); });
    return () => { live = false; };
  }, [threadId, request]);

  const replay = preview?.replay;
  const choice = () => ({ request: replay!.requestId, title: title.trim() || replay!.title, leaveOut: [...removed] });
  const pictures = replay?.steps.filter((step) => step.imageUrl).length ?? 0;
  const run = async (kind: "publish" | "download") => {
    if (!replay || busy) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "publish") {
        const published = await publishReplay(threadId, choice());
        setCard(published);
        if (published.state !== "live") setError(published.message ?? t("replay.notPublished"));
      } else {
        await downloadReplay(threadId, choice());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const toggle = (n: number) => setRemoved((current) => {
    const next = new Set(current);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });

  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    onMouseDown={(event) => { if (event.target === event.currentTarget && busy !== "publish") closeShareReplay(); }}>
    <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-label={t("replay.title")} aria-busy={busy !== null || undefined} data-share-replay
      className="flex max-h-[min(720px,calc(100vh-32px))] w-full max-w-[600px] flex-col rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-hairline/40 p-5 pb-4">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Film size={16} />{t("replay.title")}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("replay.subtitle")}</p>
        </div>
        <button type="button" aria-label={t("common.close")} onClick={closeShareReplay} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {busy === "load" && !replay && <p className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("replay.loading")}</p>}
        {replay && (
          <>
            {preview!.jobs.length > 1 && (
              <label className="block text-[12px] text-ink-secondary">{t("replay.job")}
                <select value={replay.requestId} disabled={busy !== null} onChange={(event) => setRequest(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-1.5 text-[13px] text-ink focus:border-focus focus:outline-none">
                  {preview!.jobs.map((job) => <option key={job.requestId} value={job.requestId}>{job.text || job.requestId}</option>)}
                </select>
              </label>
            )}
            <label className="mt-3 block text-[12px] text-ink-secondary">{t("replay.pageTitle")}
              <input value={title} maxLength={200} disabled={busy !== null} onChange={(event) => setTitle(event.target.value)}
                className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-1.5 text-[13px] text-ink focus:border-focus focus:outline-none" />
            </label>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary" data-replay-counts>
              {t("replay.counts", { steps: replay.steps.length, pictures: pictures - removed.size })}
              {replay.leftOutToFit > 0 ? ` ${t("replay.leftOutToFit", { count: replay.leftOutToFit })}` : ""}
            </p>
            {pictures === 0 && <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary" data-replay-no-pictures>{t("replay.noPictures")}</p>}
            <ol className="mt-3 flex flex-col gap-2">
              {replay.steps.map((step) => (
                <li key={step.n} className="rounded-xl border border-hairline/40 bg-card p-3" data-replay-step={step.n}>
                  <div className="flex items-baseline gap-2 text-[13px]">
                    <span className="w-5 shrink-0 text-[11px] text-ink-secondary">{step.n}</span>
                    <span className={step.ok ? "text-success" : "text-danger"} aria-hidden>{step.ok ? "✓" : "✗"}</span>
                    <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{step.action}</span>
                  </div>
                  {(step.site || step.detail) && <div className="ms-7 mt-0.5 text-[12px] text-ink-secondary [overflow-wrap:anywhere]">{[step.site, step.detail].filter(Boolean).join(" · ")}</div>}
                  {step.imageUrl && (
                    <div className="ms-7 mt-2">
                      {removed.has(step.n)
                        ? <p className="text-[12px] text-ink-secondary">{t("replay.pictureRemoved")}</p>
                        : <img src={step.imageUrl} alt="" loading="lazy" className={cn("w-full rounded-lg border border-hairline/40", !step.pictured && "opacity-50")} />}
                      <button type="button" className="mt-1 text-[12px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline" data-replay-toggle={step.n}
                        disabled={busy !== null} onClick={() => toggle(step.n)}>
                        {removed.has(step.n) ? t("replay.keepPicture") : t("replay.removePicture")}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <div className="border-t border-hairline/40 p-5 pt-4">
        {card?.state === "live" && card.url && (
          <div role="status" className="mb-3 flex items-center gap-2 rounded-lg bg-inset px-3 py-2 text-[13px]" data-replay-link>
            <Link2 size={14} className="shrink-0 text-ink-secondary" />
            <span className="min-w-0 flex-1 truncate">{card.url}</span>
            <button type="button" className="inline-flex items-center gap-1 text-ink-secondary hover:text-ink"
              onClick={() => { void copyText(card.url!).then((done) => setCopied(done === "copied")); }}>
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}{t(copied ? "replay.copied" : "replay.copy")}
            </button>
          </div>
        )}
        {error && <p role="alert" className="mb-3 text-[12px] text-danger">{error}</p>}
        <p className="mb-3 text-[12px] leading-relaxed text-ink-secondary">{t("replay.privacy")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={quiet} disabled={!replay || busy !== null} onClick={() => void run("download")} data-replay-download>
            {busy === "download" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}{t("replay.download")}
          </button>
          <button type="button" className={button} disabled={!replay || busy !== null} onClick={() => void run("publish")} data-replay-publish>
            {busy === "publish" ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}{t(card?.state === "live" ? "replay.republish" : "replay.publish")}
          </button>
        </div>
      </div>
    </div>
  </div>, document.body);
}
