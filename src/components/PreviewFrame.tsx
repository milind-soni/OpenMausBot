import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import {
  buildProjectFilePreviewUrl,
  describePreviewSource,
  type PreviewSource,
} from "@/lib/mobilePreviewUrl";
import { captureMarkdown, captureProjectFileSizes } from "@/lib/previewSharing";
import type { Attachment } from "@/state/store";

const LOAD_TIMEOUT_MS = 15_000;
const SLOW_WARNING_MS = 6_000;

export type PreviewFrameStatus = "empty" | "confirm" | "loading" | "loaded" | "blocked" | "error";

export interface PreviewFrameHandle {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  captureScreenshot: (
    mode: "visible" | "full",
    meta: { title: string; width: number; height: number },
  ) => Promise<Attachment>;
}

export interface PreviewFrameProps {
  source: PreviewSource | null;
  width: number;
  height: number;
  scale?: number;
  live?: boolean;
  snapshotDataUrl?: string | null;
  onPromoteLive?: () => void;
  pendingConfirmUrl?: string | null;
  onConfirmLocalUrl?: () => void;
  onCancelLocalUrl?: () => void;
  onQuickPickUrl?: (url: string) => void;
  onOpenFilePicker?: () => void;
  onStatusChange?: (status: PreviewFrameStatus) => void;
  onHistoryStateChange?: (state: { canGoBack: boolean; canGoForward: boolean }) => void;
  scrollSyncSourceId?: string;
  onScrollSync?: (sourceId: string, ratioY: number) => void;
  externalScrollRatioY?: number | null;
  frameTitle?: string;
  showDeviceBezel?: boolean;
}

function dataUrlByteSize(dataUrl: string): number {
  const base64Index = dataUrl.indexOf(",");
  const base64 = base64Index >= 0 ? dataUrl.slice(base64Index + 1) : dataUrl;
  return Math.ceil((base64.length * 3) / 4);
}

export const PreviewFrame = forwardRef<PreviewFrameHandle, PreviewFrameProps>(function PreviewFrame(
  {
    source,
    width,
    height,
    scale = 1,
    live = true,
    snapshotDataUrl = null,
    onPromoteLive,
    pendingConfirmUrl = null,
    onConfirmLocalUrl,
    onCancelLocalUrl,
    onQuickPickUrl,
    onOpenFilePicker,
    onStatusChange,
    onHistoryStateChange,
    scrollSyncSourceId,
    onScrollSync,
    externalScrollRatioY,
    frameTitle = "Preview",
    showDeviceBezel = true,
  },
  ref,
) {
  const isElectron = typeof window !== "undefined" && Boolean(window.gbs);
  const [status, setStatus] = useState<PreviewFrameStatus>(
    pendingConfirmUrl ? "confirm" : source ? "loading" : "empty",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [slowWarning, setSlowWarning] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [markdownContent, setMarkdownContent] = useState("");

  const webviewRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const markdownScrollRef = useRef<HTMLDivElement | null>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateStatus = useCallback(
    (next: PreviewFrameStatus) => {
      setStatus(next);
      onStatusChange?.(next);
    },
    [onStatusChange],
  );

  const clearTimers = useCallback(() => {
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
  }, []);

  const syncWebviewHistory = useCallback(() => {
    const el = webviewRef.current as any;
    if (!el || !isElectron) {
      onHistoryStateChange?.({ canGoBack: false, canGoForward: false });
      return;
    }
    try {
      onHistoryStateChange?.({
        canGoBack: typeof el.canGoBack === "function" ? Boolean(el.canGoBack()) : false,
        canGoForward: typeof el.canGoForward === "function" ? Boolean(el.canGoForward()) : false,
      });
    } catch {
      onHistoryStateChange?.({ canGoBack: false, canGoForward: false });
    }
  }, [isElectron, onHistoryStateChange]);

  const reload = useCallback(() => {
    if (!source) return;
    setErrorMessage("");
    setSlowWarning(false);
    updateStatus("loading");
    const el = webviewRef.current as any;
    if (isElectron && el && typeof el.reload === "function" && source.kind === "url") {
      try {
        el.reload();
        return;
      } catch {
        // Fallback to key increment
      }
    }
    setReloadNonce((n) => n + 1);
  }, [isElectron, source, updateStatus]);

  const goBack = useCallback(() => {
    const el = webviewRef.current as any;
    if (isElectron && el && typeof el.canGoBack === "function" && el.canGoBack()) {
      el.goBack();
      setTimeout(syncWebviewHistory, 120);
    }
  }, [isElectron, syncWebviewHistory]);

  const goForward = useCallback(() => {
    const el = webviewRef.current as any;
    if (isElectron && el && typeof el.canGoForward === "function" && el.canGoForward()) {
      el.goForward();
      setTimeout(syncWebviewHistory, 120);
    }
  }, [isElectron, syncWebviewHistory]);

  const captureScreenshot = useCallback(
    async (
      mode: "visible" | "full",
      meta: { title: string; width: number; height: number },
    ): Promise<Attachment> => {
      const safeSlug = meta.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preview";
      const fileName = `preview-${safeSlug}-${meta.width}x${meta.height}-${Date.now()}.png`;


      const el = webviewRef.current as any;
      if (
        isElectron &&
        window.gbs?.previewScreenshot &&
        el &&
        typeof el.getWebContentsId === "function" &&
        (source?.kind === "url" || (source?.kind === "file" && (source.fileType === "html" || source.fileType === "pdf")))
      ) {
        try {
          const wcId = el.getWebContentsId();
          const res: unknown = await window.gbs.previewScreenshot({
            webContentsId: wcId,
            fullPage: mode === "full",
          });
          const dataUrl =
            typeof res === "string"
              ? res
              : res && typeof res === "object" && "dataUrl" in res && typeof (res as any).dataUrl === "string"
                ? (res as any).dataUrl
                : "";
          if (dataUrl) {
            return {
              id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: fileName,
              mimeType: "image/png",
              size: dataUrlByteSize(dataUrl),
              dataUrl,
            };
          }
        } catch {
          // Never manufacture a screenshot when native capture fails.
        }
      }

      let dataUrl: string;
      if (source?.kind === "file" && source.fileType === "markdown" && markdownScrollRef.current) {
        dataUrl = await captureMarkdown(markdownScrollRef.current, meta.width, meta.height, mode === "full");
      } else if (source?.kind === "file" && (source.fileType === "markdown" || source.fileType === "image")) {
        return (await captureProjectFileSizes(source, [meta], mode === "full"))[0];
      } else {
        throw new Error("Page screenshots need the desktop app. Share the preview link instead.");
      }

      return {
        id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: fileName,
        mimeType: "image/png",
        size: dataUrlByteSize(dataUrl),
        dataUrl,
      };
    },
    [isElectron, source],
  );

  useImperativeHandle(
    ref,
    () => ({
      reload,
      goBack,
      goForward,
      captureScreenshot,
    }),
    [captureScreenshot, goBack, goForward, reload],
  );

  // Listen for auto-refresh SSE reload events matching the active project file
  useEffect(() => {
    if (!source || source.kind !== "file") return;
    const onPreviewReload = (event: Event) => {
      const detail = (event as CustomEvent)?.detail;
      if (!detail) return;
      if (detail.projectId === source.projectId && detail.path === source.filePath) {
        setReloadNonce((n) => n + 1);
      }
    };
    window.addEventListener("gbs:preview-reload", onPreviewReload);
    return () => window.removeEventListener("gbs:preview-reload", onPreviewReload);
  }, [source]);

  // Apply external scroll ratio for Markdown previews when scroll sync is active
  useEffect(() => {
    if (externalScrollRatioY === null || externalScrollRatioY === undefined) return;
    const container = markdownScrollRef.current;
    if (!container) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll > 0) {
      container.scrollTop = externalScrollRatioY * maxScroll;
    }
  }, [externalScrollRatioY]);

  // Manage loading states & Markdown fetching
  useEffect(() => {
    clearTimers();
    setSlowWarning(false);

    if (pendingConfirmUrl) {
      updateStatus("confirm");
      return;
    }

    if (!source) {
      updateStatus("empty");
      return;
    }

    if (!live) {
      return;
    }

    if (source.kind === "file" && source.fileType === "markdown") {
      let cancelled = false;
      updateStatus("loading");
      setErrorMessage("");
      const url = buildProjectFilePreviewUrl(source.projectId, source.filePath, reloadNonce || 1);
      fetch(url)
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Failed to load file (${res.status})`);
          }
          return res.text();
        })
        .then((text) => {
          if (cancelled) return;
          setMarkdownContent(text);
          updateStatus("loaded");
        })
        .catch((err) => {
          if (cancelled) return;
          setErrorMessage(err instanceof Error ? err.message : "Couldn't read Markdown file.");
          updateStatus("error");
        });
      return () => {
        cancelled = true;
      };
    }

    updateStatus("loading");
    setErrorMessage("");

    slowTimerRef.current = setTimeout(() => {
      setSlowWarning(true);
    }, SLOW_WARNING_MS);

    loadTimerRef.current = setTimeout(() => {
      updateStatus(source.kind === "url" ? "blocked" : "error");
      setErrorMessage(
        "Timed out after 15 seconds. Make sure your local server is running and the address is spelled correctly.",
      );
    }, LOAD_TIMEOUT_MS);

    return () => {
      clearTimers();
    };
  }, [clearTimers, live, pendingConfirmUrl, reloadNonce, source, updateStatus]);

  // Attach Electron <webview> lifecycle listeners
  useEffect(() => {
    const el = webviewRef.current as any;
    if (!isElectron || !el || !source || !live) return;
    if (source.kind === "file" && (source.fileType === "markdown" || source.fileType === "image")) {
      return;
    }

    const onStart = () => {
      updateStatus("loading");
      setErrorMessage("");
    };
    const onStop = () => {
      clearTimers();
      setSlowWarning(false);
      setStatus((prev) => {
        const next = prev === "error" || prev === "blocked" ? prev : "loaded";
        onStatusChange?.(next);
        return next;
      });
      syncWebviewHistory();
    };
    const onFail = (e: any) => {
      if (e?.errorCode === -3) return; // ERR_ABORTED
      clearTimers();
      setSlowWarning(false);
      const desc = String(e?.errorDescription || "");
      if (/BLOCKED_BY_RESPONSE|CSP|X-Frame-Options/i.test(desc) || e?.errorCode === -27) {
        updateStatus("blocked");
        setErrorMessage(desc || "Blocked by response headers.");
        return;
      }
      updateStatus("error");
      setErrorMessage(
        desc
          ? `Failed to load (${desc}). Make sure your server is running.`
          : "Make sure your local server is running and the address is spelled correctly.",
      );
    };

    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onFail);
    el.addEventListener("did-navigate", syncWebviewHistory);
    el.addEventListener("did-navigate-in-page", syncWebviewHistory);

    return () => {
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onFail);
      el.removeEventListener("did-navigate", syncWebviewHistory);
      el.removeEventListener("did-navigate-in-page", syncWebviewHistory);
    };
  }, [clearTimers, isElectron, live, reloadNonce, source, syncWebviewHistory, updateStatus]);

  const sourceLabel = describePreviewSource(source);
  const hostname = (() => {
    if (!source || source.kind !== "url") return sourceLabel;
    try {
      return new URL(source.url).hostname;
    } catch {
      return source.url;
    }
  })();

  const frameUrl = (() => {
    if (!source) return "";
    if (source.kind === "url") return source.url;
    return buildProjectFilePreviewUrl(source.projectId, source.filePath, reloadNonce || undefined);
  })();

  const scaledW = Math.round(width * scale);
  const scaledH = Math.round(height * scale);

  if (status === "confirm" && pendingConfirmUrl) {
    return (
      <div className="mx-auto my-auto flex max-w-[380px] flex-col items-center rounded-2xl border border-hairline/70 bg-panel p-6 text-center shadow-lg">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <ShieldAlert className="h-5 w-5" />
        </div>
        <h3 className="text-[15px] font-semibold text-ink">Local or private address</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">
          You are about to open a local or private network address (
          <span className="font-mono text-ink">{pendingConfirmUrl}</span>). Only continue if you trust
          the server running at this address.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onCancelLocalUrl}
            className="h-8 rounded-lg border border-hairline bg-raised px-3 text-[12px] font-medium text-ink transition-colors hover:bg-raised-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirmLocalUrl}
            className="h-8 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-white transition-colors hover:brightness-110"
          >
            Load preview
          </button>
        </div>
      </div>
    );
  }

  if (!source || status === "empty") {
    return (
      <div className="mx-auto my-auto flex max-w-[380px] flex-col items-center rounded-2xl border border-hairline/70 bg-panel p-6 text-center shadow-sm">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-raised text-ink-secondary">
          <Globe className="h-5 w-5" />
        </div>
        <h3 className="text-[15px] font-semibold text-ink">Preview a page or file</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">
          Enter a web address like <span className="font-mono text-ink">http://localhost:3000</span> or
          pick an HTML, PDF, Markdown, or image file from your project.
        </p>
        {(onQuickPickUrl || onOpenFilePicker) && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {onQuickPickUrl &&
              ["http://localhost:3000", "http://localhost:5173", "http://localhost:8080"].map((presetUrl) => (
                <button
                  key={presetUrl}
                  type="button"
                  onClick={() => onQuickPickUrl(presetUrl)}
                  className="rounded-lg border border-hairline/60 bg-raised px-2.5 py-1 font-mono text-[11px] text-ink-secondary transition-colors hover:border-hairline hover:bg-raised-hover hover:text-ink"
                >
                  {presetUrl.replace("http://", "")}
                </button>
              ))}
            {onOpenFilePicker && (
              <button
                type="button"
                onClick={onOpenFilePicker}
                className="inline-flex items-center gap-1 rounded-lg border border-hairline/60 bg-raised px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:border-hairline hover:bg-raised-hover hover:text-ink"
              >
                <FolderOpen className="h-3 w-3" />
                Pick a project file…
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{ width: `${scaledW}px`, height: `${scaledH}px` }}
      className="relative shrink-0 select-none"
    >
      <div
        style={{
          width: `${width}px`,
          height: `${height}px`,
          transform: scale !== 1 ? `scale(${scale})` : undefined,
          transformOrigin: "top left",
        }}
        className={
          showDeviceBezel
            ? "relative overflow-hidden rounded-[22px] border-[3px] border-hairline bg-panel shadow-xl"
            : "relative overflow-hidden rounded-xl border border-hairline bg-panel shadow-lg"
        }
      >
        {/* Top 2px loading bar */}
        {status === "loading" && live && (
          <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-accent/20">
            <div className="h-full w-1/2 animate-pulse bg-accent" />
          </div>
        )}

        {/* Loading overlay */}
        {status === "loading" && live && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-panel/90 p-6 text-center backdrop-blur-[2px]"
          >
            <RefreshCw className="h-5 w-5 animate-spin text-accent" />
            <span className="text-[12.5px] font-medium text-ink">Loading preview…</span>
            {slowWarning && (
              <span className="max-w-[260px] text-[11.5px] text-ink-secondary">
                Still waiting for <span className="font-mono text-ink">{hostname}</span>…
              </span>
            )}
          </div>
        )}

        {/* Blocked-site state */}
        {status === "blocked" && (
          <div
            role="alert"
            className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-panel p-6 text-center"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-warning/15 text-warning">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <h4 className="text-[15px] font-semibold text-ink">
              This site may not allow embedding
            </h4>
            <p className="mt-1.5 max-w-[320px] text-[12.5px] leading-relaxed text-ink-secondary">
              We couldn't confirm that <span className="font-mono text-ink">{hostname}</span> loaded.
              Some sites only open in their own tab. You can open it there or try again.
            </p>
            <div className="mt-4 flex items-center gap-2">
              {source.kind === "url" && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-white transition-colors hover:brightness-110"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open in new tab
                </a>
              )}
              <button
                type="button"
                onClick={reload}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-raised px-3 text-[12px] font-medium text-ink transition-colors hover:bg-raised-hover"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Error state */}
        {status === "error" && (
          <div
            role="alert"
            className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-panel p-6 text-center"
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-danger/15 text-danger">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h4 className="text-[15px] font-semibold text-ink">Couldn&apos;t load this preview</h4>
            <p className="mt-1.5 max-w-[320px] text-[12.5px] leading-relaxed text-ink-secondary">
              {errorMessage ||
                "Make sure your local server is running and the address is spelled correctly."}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={reload}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-raised px-3.5 text-[12px] font-medium text-ink transition-colors hover:bg-raised-hover"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
              </button>
              {source.kind === "url" && (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline/60 bg-inset px-3 text-[12px] text-ink-secondary transition-colors hover:text-ink"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open in new tab
                </a>
              )}
            </div>
          </div>
        )}

        {/* Snapshot placeholder when >6 artboards are open in Canvas mode */}
        {!live ? (
          <div
            onClick={onPromoteLive}
            onMouseEnter={onPromoteLive}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPromoteLive?.();
              }
            }}
            className=" flex h-full w-full cursor-pointer flex-col items-center justify-center bg-inset/80 p-6 text-center transition-colors hover:bg-raised/70"
          >
            {snapshotDataUrl ? (
              <img
                src={snapshotDataUrl}
                alt={`${frameTitle} snapshot`}
                className="h-full w-full object-cover opacity-80"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-ink-secondary">
                <FileCode2 className="h-7 w-7 text-ink-secondary" />
                <span className="text-[13px] font-medium text-ink">{frameTitle}</span>
                <span className="font-mono text-[11px] text-ink-secondary">
                  {width} × {height}
                </span>
              </div>
            )}
            <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-hairline bg-panel/95 px-3 py-1 text-[11px] font-medium text-ink-secondary shadow-md">
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-accent" />
                Snapshot · hover or click for live view
              </span>
            </div>
          </div>
        ) : source.kind === "file" && source.fileType === "markdown" ? (
          <div
            ref={markdownScrollRef}
            onScroll={(e) => {
              if (!onScrollSync || !scrollSyncSourceId) return;
              const target = e.currentTarget;
              const maxScroll = target.scrollHeight - target.clientHeight;
              if (maxScroll > 0) {
                onScrollSync(scrollSyncSourceId, target.scrollTop / maxScroll);
              }
            }}
            className="h-full w-full overflow-y-auto bg-panel p-6 text-left text-ink select-text"
          >
            <ChatMarkdown text={markdownContent} />
          </div>
        ) : source.kind === "file" && source.fileType === "image" ? (
          <div className="flex h-full w-full items-center justify-center bg-inset p-4">
            <img
              ref={imageRef}
              key={`${frameUrl}-${reloadNonce}`}
              src={frameUrl}
              alt={source.filePath}
              onLoad={() => {
                clearTimers();
                setSlowWarning(false);
                updateStatus("loaded");
              }}
              onError={() => {
                clearTimers();
                setSlowWarning(false);
                setErrorMessage("Couldn't load this image file from the project.");
                updateStatus("error");
              }}
              className="max-h-full max-w-full rounded object-contain shadow-sm"
            />
          </div>
        ) : isElectron ? (
          <webview
            key={`${frameUrl}-${reloadNonce}`}
            ref={(el) => {
              webviewRef.current = el;
            }}
            src={frameUrl}
            style={{ width: "100%", height: "100%", border: "0", backgroundColor: "#ffffff" }}
            // @ts-expect-error Electron webview attributes
            allowpopups="false"
            webpreferences="contextIsolation=yes, sandbox=yes"
          />
        ) : (
          <iframe
            key={`${frameUrl}-${reloadNonce}`}
            ref={iframeRef}
            src={frameUrl}
            title={`${frameTitle} (${width} × ${height})`}
            // HTML keeps an opaque origin. PDFs alone need the native PDF viewer,
            // which Chromium disables inside a sandbox (also exempt in server CSP).
            sandbox={source.kind === "file"
              ? source.fileType === "pdf" ? undefined : "allow-scripts allow-forms"
              : "allow-scripts allow-same-origin allow-forms"}
            referrerPolicy="no-referrer"
            onLoad={() => {
              clearTimers();
              setSlowWarning(false);
              // A refused navigation can still emit load after the user opens
              // recovery. Only Retry should dismiss that recovery state.
              if (status !== "blocked" && status !== "error") updateStatus("loaded");
            }}
            onError={() => {
              clearTimers();
              setSlowWarning(false);
              updateStatus("blocked");
            }}
            className="h-full w-full border-0 bg-white"
          />
        )}
        {/* Browsers fire load even for an embedding refusal and hide the response.
            Keep honest recovery available without claiming every opaque frame failed. */}
        {live && !isElectron && source.kind === "url" && status !== "blocked" && status !== "error" && (
          <div className="absolute inset-x-2 bottom-2 z-20 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-2 text-[11px] text-ink shadow" role="status">
            <button type="button" className="underline" onClick={() => updateStatus("blocked")}>Preview blank?</button>
            <span>Some sites don&apos;t allow embedding.</span>
            <a href={source.url} target="_blank" rel="noreferrer" className="font-medium text-accent underline">Open in new tab</a>
            <button type="button" onClick={reload} className="font-medium text-accent underline">Retry</button>
          </div>
        )}
      </div>
    </div>
  );
});
