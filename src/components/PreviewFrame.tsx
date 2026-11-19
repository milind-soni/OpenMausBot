import { isDeviceSource } from "@/lib/previewSource";
import { scrollRatio, syncWebviewScroll } from "@/lib/previewScrollSync";
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
import { DocumentView } from "@/components/DocumentView";
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
  stop: () => void;
  goBack: () => void;
  goForward: () => void;
  /** Desktop guest id of the live page, for attaching a bot session to it. */
  webContentsId: () => number | null;
  /** Navigates the live page in place without remounting it; false when unsupported. */
  loadURL: (url: string) => boolean;
  captureScreenshot: (
    mode: "visible" | "full",
    meta: { title: string; width: number; height: number },
  ) => Promise<Attachment>;
}

export interface PreviewFrameProps {
  testingSessionId?: string;
  testingActive?: boolean;
  onTestingError?: (message: string) => void;
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
  onNavigate?: (url: string) => void;
  onHistoryStateChange?: (state: { canGoBack: boolean; canGoForward: boolean }) => void;
  scrollSyncSourceId?: string;
  onScrollSync?: (sourceId: string, ratioY: number) => void;
  externalScrollRatioY?: number | null;
  frameTitle?: string;
  showDeviceBezel?: boolean;
  /** Responsive size: the page fills the whole preview area with no device frame. */
  fill?: boolean;
}

function dataUrlByteSize(dataUrl: string): number {
  const base64Index = dataUrl.indexOf(",");
  const base64 = base64Index >= 0 ? dataUrl.slice(base64Index + 1) : dataUrl;
  return Math.ceil((base64.length * 3) / 4);
}

export const PreviewFrame = forwardRef<PreviewFrameHandle, PreviewFrameProps>(function PreviewFrame(
  {
    source,
    testingSessionId,
    testingActive = true,
    onTestingError,
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
    onNavigate,
    scrollSyncSourceId,
    onScrollSync,
    externalScrollRatioY,
    frameTitle = "Preview",
    showDeviceBezel = true,
    fill = false,
  },
  ref,
) {
  const isElectron = typeof window !== "undefined" && Boolean(window.gbs);
  const [status, setStatus] = useState<PreviewFrameStatus>(
    pendingConfirmUrl ? "confirm" : source ? "loading" : "empty",
  );
  const statusRef = useRef(status);
  statusRef.current = status;
  const [errorMessage, setErrorMessage] = useState("");
  const [slowWarning, setSlowWarning] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [markdownContent, setMarkdownContent] = useState("");
  const [documentMtime, setDocumentMtime] = useState<number | null>(null);
  const loadedDocumentKey = useRef("");

  const webviewRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const markdownScrollRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const deviceSource = isDeviceSource(source);
  const fileViewer = Boolean(source && !deviceSource);
  const pageScrollSync = useRef<ReturnType<typeof syncWebviewScroll> | null>(null);
  const scrollReporter = useRef(onScrollSync);
  scrollReporter.current = onScrollSync;
  const syncEnabled = Boolean(deviceSource && onScrollSync && scrollSyncSourceId);

  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateStatus = useCallback(
    (next: PreviewFrameStatus) => {
      statusRef.current = next;
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

  // Only report history changes. The PDF viewer fires navigation events continuously,
  // and a fresh object on each one re-rendered the whole panel every time.
  const lastHistoryRef = useRef<string>("");
  const reportHistory = useCallback(
    (canGoBack: boolean, canGoForward: boolean) => {
      const key = `${canGoBack}:${canGoForward}`;
      if (lastHistoryRef.current === key) return;
      lastHistoryRef.current = key;
      onHistoryStateChange?.({ canGoBack, canGoForward });
    },
    [onHistoryStateChange],
  );

  const syncWebviewHistory = useCallback(() => {
    const el = webviewRef.current as any;
    if (!el || !isElectron) {
      reportHistory(false, false);
      return;
    }
    try {
      reportHistory(
        typeof el.canGoBack === "function" ? Boolean(el.canGoBack()) : false,
        typeof el.canGoForward === "function" ? Boolean(el.canGoForward()) : false,
      );
    } catch {
      reportHistory(false, false);
    }
  }, [isElectron, reportHistory]);

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

  const stop = useCallback(() => {
    const element = webviewRef.current as (HTMLElement & { stop?: () => void }) | null;
    element?.stop?.();
    clearTimers();
    setSlowWarning(false);
    updateStatus("loaded");
  }, [clearTimers, updateStatus]);

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
      if (fileViewer) {
        const bounds = viewerRef.current?.getBoundingClientRect();
        if (!bounds || bounds.width < 1 || bounds.height < 1) throw new Error("Open the file viewer before sharing it.");
        meta = { title: "Full-screen file", width: Math.round(bounds.width), height: Math.round(bounds.height) };
      }
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
      if (source?.kind === "file" && (source.fileType === "markdown" || source.fileType === "text") && markdownScrollRef.current) {
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
    [fileViewer, isElectron, source],
  );

  useImperativeHandle(
    ref,
    () => ({
      reload,
      stop,
      goBack,
      goForward,
      webContentsId: () => {
        const el = webviewRef.current as any;
        try { return isElectron && el && typeof el.getWebContentsId === "function" ? el.getWebContentsId() : null; } catch { return null; }
      },
      loadURL: (url: string) => {
        const el = webviewRef.current as any;
        if (!isElectron || !el || typeof el.loadURL !== "function") return false;
        void el.loadURL(url).catch(() => {});
        return true;
      },
      captureScreenshot,
    }),
    [captureScreenshot, goBack, goForward, isElectron, reload, stop],
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

  useEffect(() => {
    const view = webviewRef.current as any;
    if (!isElectron || !view || !live || !syncEnabled || !source ||
        (source.kind === "file" && source.fileType !== "html")) return;
    const bridge = syncWebviewScroll(view, ratio => {
      if (scrollSyncSourceId) scrollReporter.current?.(scrollSyncSourceId, ratio);
    });
    pageScrollSync.current = bridge;
    return () => { bridge.close(); if (pageScrollSync.current === bridge) pageScrollSync.current = null; };
  }, [isElectron, live, source, reloadNonce, syncEnabled, scrollSyncSourceId]);

  useEffect(() => {
    const ratio = scrollRatio(externalScrollRatioY);
    if (!live || !syncEnabled || ratio === null) return;
    pageScrollSync.current?.apply(ratio);
  }, [externalScrollRatioY, live, syncEnabled, source, reloadNonce]);

  const fileSourceKey = source?.kind === "file" ? `${source.projectId}\u0000${source.filePath}` : "";
  const saveDocument = useCallback(async (content: string, baseMtimeMs: number | null): Promise<number> => {
    const [projectId, path] = fileSourceKey.split("\u0000");
    const res = await fetch("/api/preview/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, path, content, baseMtimeMs }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Couldn't save the file (${res.status}).`), { status: res.status });
    return body.mtimeMs;
  }, [fileSourceKey]);
  const reloadDocument = useCallback(() => setReloadNonce((n) => n + 1), []);

  const initialConfirmation = source ? null : pendingConfirmUrl;

  // Manage loading states & Markdown fetching
  useEffect(() => {
    clearTimers();
    setSlowWarning(false);

    if (initialConfirmation) {
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

    if (source.kind === "file" && (source.fileType === "markdown" || source.fileType === "text")) {
      let cancelled = false;
      const documentKey = `${source.projectId}/${source.filePath}`;
      // Re-reads after a save or an external change keep the editor on screen.
      if (loadedDocumentKey.current !== documentKey) updateStatus("loading");
      setErrorMessage("");
      const url = buildProjectFilePreviewUrl(source.projectId, source.filePath, reloadNonce || 1);
      fetch(url)
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Failed to load file (${res.status})`);
          }
          const mtime = Number(res.headers.get("x-file-mtime"));
          return { text: await res.text(), mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : null };
        })
        .then(({ text, mtime }) => {
          if (cancelled) return;
          loadedDocumentKey.current = documentKey;
          setMarkdownContent(text);
          setDocumentMtime(mtime);
          updateStatus("loaded");
        })
        .catch((err) => {
          if (cancelled) return;
          loadedDocumentKey.current = "";
          setErrorMessage(err instanceof Error ? err.message : "Couldn't read the file.");
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
  }, [clearTimers, initialConfirmation, live, reloadNonce, source, updateStatus]);

  useEffect(() => {
    const el = webviewRef.current as any;
    if (!el || !testingActive || !testingSessionId || !window.gbs?.previewTesting) return;
    let registered = false;
    const ready = () => {
      if (registered) return;
      registered = true;
      void window.gbs!.previewTesting!.register({ sessionId: testingSessionId, webContentsId: el.getWebContentsId() })
        .catch((error: Error) => onTestingError?.(error.message));
    };
    el.addEventListener("dom-ready", ready);
    return () => el.removeEventListener("dom-ready", ready);
  }, [testingSessionId, testingActive, reloadNonce, onTestingError]);

  // Attach Electron <webview> lifecycle listeners
  useEffect(() => {
    const el = webviewRef.current as any;
    if (!isElectron || !el || !source || !live) return;
    if (source.kind === "file" && (source.fileType === "markdown" || source.fileType === "text" || source.fileType === "image")) {
      return;
    }

    const onStart = () => {
      updateStatus("loading");
      setErrorMessage("");
    };
    const onStop = () => {
      clearTimers();
      setSlowWarning(false);
      // Decide from the latest status outside the updater: calling the parent's setter
      // inside a state updater is a render-phase update React warns about.
      const prev = statusRef.current;
      if (prev !== "error" && prev !== "blocked") updateStatus("loaded");
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
    const onNavigation = (event: Event & { url?: string; isMainFrame?: boolean }) => {
      if (event.isMainFrame === false) return;
      if (source?.kind === "url" && event.url) onNavigate?.(event.url);
      syncWebviewHistory();
    };
    el.addEventListener("did-navigate", onNavigation);
    el.addEventListener("did-navigate-in-page", onNavigation);

    return () => {
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onFail);
      el.removeEventListener("did-navigate", onNavigation);
      el.removeEventListener("did-navigate-in-page", onNavigation);
    };
  }, [clearTimers, isElectron, live, onNavigate, onStatusChange, reloadNonce, source, syncWebviewHistory, updateStatus]);

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

  const confirmation = pendingConfirmUrl && (
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

  if (!source || status === "empty") {
    return confirmation || (
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
      ref={viewerRef}
      data-preview-file-viewer={fileViewer || undefined}
      style={fileViewer || fill ? { width: "100%", height: "100%", flex: "1 1 auto", minHeight: 0 } : { width: `${scaledW}px`, height: `${scaledH}px` }}
      className="relative shrink-0 select-none"
    >
      <div
        style={{
          width: fileViewer || fill ? "100%" : `${width}px`,
          height: fileViewer || fill ? "100%" : `${height}px`,
          transform: !fileViewer && !fill && scale !== 1 ? `scale(${scale})` : undefined,
          transformOrigin: "top left",
        }}
        className={
          fileViewer || fill ? "relative h-full w-full overflow-hidden bg-panel" : showDeviceBezel
            // Rings sit outside the box, so the page keeps the preset's exact viewport.
            ? "relative overflow-hidden rounded-[22px] ring-[3px] ring-hairline bg-panel shadow-xl"
            : "relative overflow-hidden rounded-xl ring-1 ring-hairline bg-panel shadow-lg"
        }
      >
        {confirmation && (
          <div className="absolute inset-0 z-30 flex overflow-auto bg-app/80 p-3">
            {confirmation}
          </div>
        )}

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
        ) : source.kind === "file" && (source.fileType === "markdown" || source.fileType === "text") ? (
          <DocumentView
            key={fileSourceKey}
            ref={markdownScrollRef}
            kind={source.fileType}
            fileName={source.filePath}
            projectId={source.projectId}
            content={markdownContent}
            mtimeMs={documentMtime}
            onSave={saveDocument}
            onReload={reloadDocument}
          />
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
            key={source.kind === "url" ? "web-preview" : `${frameUrl}-${reloadNonce}`}
            ref={(el) => {
              webviewRef.current = el;
            }}
            src={frameUrl}
            style={{ width: "100%", height: "100%", border: "0", backgroundColor: "#ffffff", visibility: pendingConfirmUrl ? "hidden" : undefined }}
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
            inert={Boolean(pendingConfirmUrl)}
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
