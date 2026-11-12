// A bot's page in the chat, artifact-style: its version stepper, Point, Share, Open in new tab and Full screen.
import { createContext, useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Copy, Crosshair, Download, Globe, Loader2, Maximize2, Pin, PinOff, Share2, Trash2, X } from "lucide-react";
import { useStore } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { serverErrorText } from "@/lib/server-error";
import { addPointedChip, usePointedChips } from "@/lib/pointed-chips";
import { latestWebPanels, setWebPanels, useWebPanels } from "@/lib/web-panel-preferences";
import { findPinnedPage, MAX_WEB_PANELS, togglePinnedPage, type PinnedChatPage } from "@/lib/web-panels";
import type { AppDocument, AppPayload } from "../../../shared/app";
import { marksMessage, pointMessage, readPointEvent } from "../../../shared/app-frame/point";
import type { PublishedPageCard } from "../../../shared/published-page";
import { canonicalDownloadFilename } from "../AttachmentPreview";
import { appDownloadPath, publishAppPage, unpublishPage } from "./app-api";
import { AppFrame, type AppFrameHandle } from "./AppFrame";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_CHIP_PICKED, ASK_PRIMARY_BUTTON } from "../AskCard";

/** A page starts at this height in the chat and grows to its content up to the cap, then scrolls inside. */
export const PAGE_HEIGHT = { start: 520, cap: 560 } as const;
const FLASH_MS = 2_500;
const TOOL =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40";

/** The oldest version a row's page still keeps, and its current one. */
export function pageVersions(app: AppPayload): { first: number; last: number } {
  const last = app.rev ?? 0;
  return { first: Math.max(0, last - (app.history?.length ?? 0)), last };
}

/** Which version the card shows (null: the newest), and the "Updated" flash when show_html replaces it. */
export function usePageVersion(app: AppPayload): { rev: number; first: number; last: number; latest: boolean; flash: boolean; show(rev: number | null): void } {
  const { first, last } = pageVersions(app);
  const [viewing, setViewing] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const seen = useRef(last);
  useEffect(() => {
    const grew = last > seen.current;
    seen.current = last;
    if (!grew) return undefined;
    setViewing(null);
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [last]);
  const rev = viewing === null ? last : Math.min(last, Math.max(first, viewing));
  return { rev, first, last, latest: rev === last, flash, show: (next) => setViewing(next === null || next >= last ? null : next) };
}

type Share =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "refused"; text: string; card?: PublishedPageCard }
  | { kind: "unpublishing" }
  | { kind: "unpublish-failed" };

/** The page's public link, as the row's published card says (publish_page's, or this card's own Share), and Share and
 * Unpublish. The server patches the card, so every window sees the same link. */
export function usePageShare(threadId: string, messageId: string, published: PublishedPageCard | undefined) {
  const [share, setShare] = useState<Share>({ kind: "idle" });
  const [again, setAgain] = useState(false);
  const live = published?.state === "live" && published.url ? published : null;
  const run = async (rev: number) => {
    setShare({ kind: "busy" });
    const outcome = await publishAppPage(threadId, messageId, rev);
    setAgain(Boolean(live) && outcome.ok);
    if (outcome.ok) setShare({ kind: "idle" });
    else setShare({ kind: "refused", text: outcome.card?.message ?? outcome.error, ...(outcome.card ? { card: outcome.card } : {}) });
  };
  const unpublish = async () => {
    if (!live?.pageId) return;
    setShare({ kind: "unpublishing" });
    setShare(await unpublishPage(live.pageId) ? { kind: "idle" } : { kind: "unpublish-failed" });
    setAgain(false);
  };
  return { share, url: live?.url, again, unpublished: published?.state === "unpublished", run, unpublish };
}

/** On a phone the OS share sheet (Save to Files, Share); elsewhere a download, which Electron turns into its save dialog. */
async function saveToDevice(file: File): Promise<void> {
  if (window.matchMedia?.("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== "AbortError") throw error;
    }
    return;
  }
  // Security: octet-stream, so a browser that ignores download never renders the bot's HTML as the app's own page.
  const url = URL.createObjectURL(new Blob([file], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Chromium may consume the Blob after the click task.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** The page's version as one .html file on this device. */
export function usePageSave(threadId: string, messageId: string, title: string) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const run = async (rev: number) => {
    setBusy(true);
    setReason("");
    try {
      const response = await fetch(appDownloadPath(threadId, messageId, rev));
      if (!response.ok) throw new Error(serverErrorText(await response.json().catch(() => null), t("chat.preview.saveFailed")));
      const name = canonicalDownloadFilename({ contentDisposition: response.headers.get("content-disposition"), fallback: `${title}.html` });
      await saveToDevice(new File([await response.blob()], name, { type: "text/html" }));
    } catch (error) {
      setReason(error instanceof Error && error.message ? error.message : t("chat.preview.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return { busy, reason, run };
}

/** Point mode on whichever frame shows the page. Security: a pick counts only from that frame's own window and only
 * while the person has Point on, so a page cannot fill the composer by itself. Point stays on after a pick so several
 * parts can be marked in one pass; once it ends after any pick, `picked` runs and the composer takes focus. */
export function usePagePoint(args: { frame(): HTMLIFrameElement | null | undefined; view?: string; threadId: string; appId: string; rev: number; title: string; picked(): void }) {
  const [pointing, setPointing] = useState(false);
  const on = useRef(false);
  on.current = pointing;
  const pickedAny = useRef(false);
  const latest = useRef(args);
  latest.current = args;
  const say = useCallback((next: boolean) => latest.current.frame()?.contentWindow?.postMessage(pointMessage(next), "*"), []);
  const set = useCallback((next: boolean) => {
    on.current = next;
    setPointing(next);
    say(next);
    if (next || !pickedAny.current) return;
    pickedAny.current = false;
    latest.current.picked();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-tour=\"composer\"] textarea")?.focus());
  }, [say]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const heard = readPointEvent({ source: event.source, data: event.data }, latest.current.frame()?.contentWindow ?? null);
      if (!heard || !on.current) return;
      if (heard.kind === "ended") return set(false);
      const { threadId, appId, rev, title } = latest.current;
      if (addPointedChip(threadId, { appId, rev, title, ...heard.part })) pickedAny.current = true;
      else set(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && on.current) set(false);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [set]);
  // Numbered outlines on this version's parts waiting in the composer; a chip from another page or version keeps its
  // number with an empty selector, so the page's numbers match the composer's.
  const chips = usePointedChips(args.threadId);
  const marks = JSON.stringify(chips.map((chip) => (chip.appId === args.appId && chip.rev === args.rev ? chip.selector : "")));
  useEffect(() => {
    const iframe = latest.current.frame();
    const send = () => iframe?.contentWindow?.postMessage(marksMessage(JSON.parse(marks) as string[]), "*");
    send();
    // A new frame (full screen, a reload) gets them again once its page has loaded.
    iframe?.addEventListener("load", send);
    return () => iframe?.removeEventListener("load", send);
  }, [marks, pointing, args.view]);
  return { pointing, toggle: () => set(!on.current), stop: () => { if (on.current) set(false); } };
}

/** Pin to sidebar: the page joins the sidebar's pinned panels, which show in Advanced mode, so the button does too. */
export function usePagePin(page: PinnedChatPage, title: string) {
  const advanced = useAdvancedMode();
  const panels = useWebPanels();
  const pinned = Boolean(findPinnedPage(panels, page));
  return { show: advanced, pinned, full: !pinned && panels.length >= MAX_WEB_PANELS, toggle: () => {
    // Base the edit on the stored list, not this render's: another window may have pinned or unpinned since.
    const latest = latestWebPanels();
    if (Boolean(findPinnedPage(latest, page)) === pinned) setWebPanels(togglePinnedPage(latest, page, title));
  } };
}

export interface PageToolsProps {
  version: ReturnType<typeof usePageVersion>;
  point: ReturnType<typeof usePagePoint>;
  share: ReturnType<typeof usePageShare>;
  save: ReturnType<typeof usePageSave>;
  ready: boolean;
  /** pane: the page opens in the chat's page pane, beside a usable message box, instead of covering the window. */
  fullScreen: { open: boolean; toggle(): void; pane?: boolean };
  /** Shown in a room: view-only, so no Point and no Share. */
  room?: boolean;
  pin?: ReturnType<typeof usePagePin>;
}

/** The card's toolbar: ‹ v2 › and Updated on the left; Point, Share, Open in new tab and Full screen on the right. */
export function PageToolbar({ version, point, share, save, ready, fullScreen, room, pin, className }: PageToolsProps & { className?: string }) {
  const label = version.latest ? t("chat.preview.version", { n: version.rev + 1 }) : t("chat.preview.versionOf", { n: version.rev + 1, count: version.last + 1 });
  const busy = share.share.kind === "busy";
  return (
    <div data-page-tools className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-2", className)}>
      <div className="flex items-center gap-0.5 text-[13px] text-ink-secondary">
        <button type="button" className={TOOL} aria-label={t("chat.preview.older")} title={t("chat.preview.older")} disabled={version.rev <= version.first}
          onClick={() => version.show(version.rev - 1)}><ChevronLeft size={15} /></button>
        <span data-page-version className="min-w-6 text-center tabular-nums">{label}</span>
        <button type="button" className={TOOL} aria-label={t("chat.preview.newer")} title={t("chat.preview.newer")} disabled={version.latest}
          onClick={() => version.show(version.rev + 1)}><ChevronRight size={15} /></button>
        {!version.latest && <button type="button" className="ms-1 rounded px-1 text-accent-text hover:underline" onClick={() => version.show(null)}>{t("chat.preview.latest")}</button>}
        {version.flash && <span role="status" data-page-updated className="ms-1 rounded-full bg-accent/15 px-2 py-px font-medium text-accent-text">{t("chat.preview.updated")}</span>}
      </div>
      <div className="ms-auto flex flex-wrap items-center gap-1">
        {!room && <>
          <button type="button" aria-pressed={point.pointing} onClick={point.toggle} disabled={!ready} title={t("chat.preview.pointHint")}
            className={cn(ASK_CHIP, point.pointing ? ASK_CHIP_PICKED : ASK_CHIP_IDLE)}>
            <Crosshair size={14} />{t("chat.preview.point")}
          </button>
          <button type="button" onClick={() => void share.run(version.rev)} disabled={busy} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}{t("chat.preview.share")}
          </button>
          {pin?.show && (
            <button type="button" data-page-pin aria-pressed={pin.pinned} onClick={pin.toggle} disabled={pin.full}
              title={pin.full ? t("chat.preview.pinFull", { max: MAX_WEB_PANELS }) : t(pin.pinned ? "chat.preview.unpinHint" : "chat.preview.pinHint")}
              className={cn(ASK_CHIP, pin.pinned ? ASK_CHIP_PICKED : ASK_CHIP_IDLE)}>
              {pin.pinned ? <PinOff size={14} /> : <Pin size={14} />}{t(pin.pinned ? "chat.preview.unpin" : "chat.preview.pin")}
            </button>
          )}
        </>}
        <button type="button" className={TOOL} disabled={save.busy} onClick={() => void save.run(version.rev)}
          aria-label={t("chat.preview.save")} title={t("chat.preview.save")}>
          {save.busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
        </button>
        <button type="button" className={TOOL} disabled={!share.url} onClick={() => share.url && void openExternalLink(share.url)}
          aria-label={t("chat.preview.openTab")} title={share.url ? t("chat.preview.openTab") : t("chat.preview.openTabNeedsLink")}>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" className={TOOL} onClick={fullScreen.toggle} aria-pressed={fullScreen.open}
          aria-label={fullScreenLabel(fullScreen)} title={fullScreenLabel(fullScreen)}>
          {fullScreen.open ? <X size={16} /> : <Maximize2 size={14} />}
        </button>
      </div>
      {!room && pin?.show && pin.full && <p data-page-pin-full className="basis-full text-end text-xs text-ink-secondary">{t("chat.preview.pinFull", { max: MAX_WEB_PANELS })}</p>}
    </div>
  );
}

/** Under the toolbar: the public link with Copy, Update link and Unpublish once shared, or why sharing failed; the Point
 * hint. */
export function PageNotes({ version, point, share, save, room, className }: Pick<PageToolsProps, "version" | "point" | "share" | "save" | "room"> & { className?: string }) {
  const { dispatch } = useStore();
  const { state: copied, copy } = useCopyFeedback(share.url ?? "");
  const state = share.share;
  const rows: ReactNode[] = [];
  if (share.url) {
    rows.push(
      <div key="link" data-page-link className="flex min-w-0 flex-wrap items-center gap-2 rounded-2xl bg-inset px-3 py-2 text-[13px]">
        <Globe size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
        <span className="shrink-0 font-medium text-ink">{share.again ? t("chat.preview.updatedLink") : t("chat.preview.published")}</span>
        <a href={share.url} dir="ltr" onClick={(event) => { event.preventDefault(); void openExternalLink(share.url!); }}
          className="min-w-0 flex-1 truncate text-accent-text hover:underline">{share.url}</a>
        <button type="button" onClick={copy} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          {copied === "copied" ? <Check size={14} /> : <Copy size={14} />}{t(copied === "copied" ? "chat.page.copied" : "chat.page.copyLink")}
        </button>
        {!room && (
          <button type="button" onClick={() => void share.run(version.rev)} disabled={state.kind === "busy"} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
            {t("chat.preview.republish")}
          </button>
        )}
        <button type="button" onClick={() => void share.unpublish()} disabled={state.kind === "unpublishing"} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          {state.kind === "unpublishing" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}{t("chat.page.unpublish")}
        </button>
      </div>,
    );
  }
  if (share.unpublished && !share.url) rows.push(<p key="gone" className="px-1 text-[13px] text-ink-secondary">{t("chat.page.unpublished")}</p>);
  if (state.kind === "unpublish-failed") rows.push(<p key="stuck" role="alert" className="px-1 text-[13px] text-danger">{t("chat.page.unpublishFailed")}</p>);
  if (state.kind === "refused") {
    rows.push(
      <div key="refused" role="alert" className="flex items-center gap-2 rounded-2xl bg-inset px-3 py-2 text-[13px] text-ink-secondary">
        <span dir="auto" className="min-w-0 flex-1">{state.text}</span>
        {state.card?.upgrade && window.ogb?.cloudAccount && !window.ogb.remoteClient?.active && (
          <button type="button" className={ASK_PRIMARY_BUTTON} onClick={() => dispatch({ type: "openCloudAdd", source: "app_pages" })}>{t("chat.page.morePages")}</button>
        )}
      </div>,
    );
  }
  if (save.reason) rows.push(<p key="save" role="alert" dir="auto" className="px-1 text-[13px] text-danger">{save.reason}</p>);
  if (point.pointing) rows.push(<div key="hint" role="status" className="rounded-2xl bg-accent/10 px-3 py-2 text-[13px] text-ink">{t("chat.preview.pointHint")}</div>);
  return rows.length ? <div className={cn("flex flex-col gap-2", className)}>{rows}</div> : null;
}

/** The page over the whole chat. Esc stops Point first, then closes. */
function fullScreenLabel({ open, pane }: PageToolsProps["fullScreen"]): string {
  if (pane) return open ? t("chat.preview.closePage") : t("chat.preview.openPage");
  return open ? t("chat.preview.exitFullScreen") : t("chat.preview.fullScreen");
}

/** The chat's page pane: the messages area, above the transcript and below the message box. null outside a bot chat. */
export const PagePaneContext = createContext<HTMLElement | null>(null);

/** How tall the compact card in the chat is when a page opens in the pane. */
export const PAGE_PREVIEW_HEIGHT = 220;

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

export function PageFullScreen(props: PageToolsProps & {
  title: string;
  doc: AppDocument;
  botId: string;
  threadId: string;
  handle: MutableRefObject<AppFrameHandle | null>;
  close(): void;
  /** Open in this pane, leaving the message box usable, rather than over the whole window. */
  pane?: HTMLElement | null;
}) {
  const { point, close, pane } = props;
  const closer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Beside the message box, Esc while typing belongs to the box (it clears a reply), not to the page.
      if (pane && typing(event.target)) return;
      event.preventDefault();
      if (point.pointing) point.stop();
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [point, close, pane]);
  useEffect(() => { closer.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus(); }, []);
  return createPortal(
    <div {...(pane ? { role: "region", "data-page-pane": props.doc.messageId } : { role: "dialog", "aria-modal": true })}
      aria-label={props.title} data-page-fullscreen={props.doc.messageId}
      className={cn(pane ? "absolute inset-x-0 top-0 z-[1] bottom-[var(--page-pane-bottom,0px)] pt-[var(--glass-top,0px)]" : "fixed inset-0 z-50",
        "flex flex-col bg-panel")}>
      <div ref={closer} className="flex flex-col gap-2 border-b border-hairline/40 px-4 pb-3 pt-3">
        <div className="truncate text-[15px] font-semibold text-ink" title={props.title}><bdi dir="auto">{props.title}</bdi></div>
        <PageToolbar {...props} />
        <PageNotes version={props.version} point={point} share={props.share} save={props.save} room={props.room} />
      </div>
      <div className={cn("relative min-h-0 flex-1 bg-app", point.pointing && "ring-2 ring-inset ring-accent/60")}>
        <AppFrame doc={props.doc} botId={props.botId} threadId={props.threadId} title={props.title} height={600} handle={props.handle}
          onHeight={() => {}} onProblem={() => {}} onTeardownRequested={close} fill />
      </div>
    </div>,
    pane ?? document.body,
  );
}
