import { PAGE_SHARE_NOTICE, previewShareLink, sharesLinkOnly } from "@/lib/previewSharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  History,
  Maximize2,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import {
  applyRotation,
  clampCustomDimension,
  computeFrameScale,
  PREVIEW_SIZE_GROUPS,
  PREVIEW_ZOOM_OPTIONS,
  resolvePreviewSize,
  type PreviewZoomMode,
} from "@/lib/previewSizes";
import {
  describePreviewSource,
  validatePreviewUrl,
  type PreviewFileSource,
  type PreviewSource,
} from "@/lib/mobilePreviewUrl";
import {
  addMobilePreviewUrlToHistory,
  clearMobilePreviewUrlHistory,
  getMobilePreviewUrlHistory,
} from "@/lib/mobilePreviewHistory";
import {
  loadMobilePreviewState,
  saveMobilePreviewState,
  savePreviewStudioState,
} from "@/lib/mobilePreviewState";
import { PreviewFrame, type PreviewFrameHandle, type PreviewFrameStatus } from "@/components/PreviewFrame";
import { PreviewFilePicker, usePreviewAutoRefreshWatcher } from "@/components/PreviewFilePicker";
import { cn } from "@/lib/cn";
import { useStore, type Attachment } from "@/state/store";

export interface MobilePreviewPanelProps {
  open?: boolean;
  onClose: () => void;
  onScreenshot?: (attachment: Attachment) => void;
  onSendScreenshotToChat?: (attachment: Attachment, caption?: string) => void;
  className?: string;
}

export function MobilePreviewPanel({
  open = true,
  onClose,
  onScreenshot,
  onSendScreenshotToChat,
  className,
}: MobilePreviewPanelProps) {
  const { state, dispatch } = useStore();
  const initial = useMemo(() => loadMobilePreviewState(), []);

  const [inputUrl, setInputUrl] = useState(initial.input);
  const [activeSource, setActiveSource] = useState<PreviewSource | null>(() => {
    if (initial.source) return initial.source;
    if (initial.input) {
      const check = validatePreviewUrl(initial.input);
      if (check.valid && !check.isLocalOrPrivate) {
        return { kind: "url", url: check.url, raw: initial.input, isLocalOrPrivate: false };
      }
    }
    return null;
  });
  const [presetId, setPresetId] = useState(initial.presetId);
  const [rotated, setRotated] = useState(Boolean(initial.rotated));
  const [zoom, setZoom] = useState<PreviewZoomMode>(initial.zoom ?? "fit");
  const [customSize, setCustomSize] = useState(
    initial.customSize ?? { width: 1024, height: 768 },
  );

  const [urlError, setUrlError] = useState("");
  const [pendingLocalUrl, setPendingLocalUrl] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<PreviewFrameStatus>("empty");
  const [historyNav, setHistoryNav] = useState({ canGoBack: false, canGoForward: false });
  const [historyList, setHistoryList] = useState<string[]>(() => getMobilePreviewUrlHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stageBounds, setStageBounds] = useState({ width: 380, height: 640 });

  const frameRef = useRef<PreviewFrameHandle | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);
  const sizeDropdownRef = useRef<HTMLDivElement | null>(null);
  const screenshotDropdownRef = useRef<HTMLDivElement | null>(null);

  usePreviewAutoRefreshWatcher("quick-preview-panel", activeSource, open);

  const preset = useMemo(() => resolvePreviewSize(presetId, customSize), [customSize, presetId]);

  useEffect(() => {
    if (!preset.rotatable && rotated) {
      setRotated(false);
    }
  }, [preset.rotatable, rotated]);

  const effectiveDims = useMemo(
    () => applyRotation(preset, preset.rotatable ? rotated : false),
    [preset, rotated],
  );

  const scale = useMemo(
    () => computeFrameScale(effectiveDims, stageBounds, zoom, 16),
    [effectiveDims, stageBounds, zoom],
  );

  // Measure viewport stage for Fit zoom
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !open) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageBounds({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSize);
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, [open]);

  // Persist quick preview state
  useEffect(() => {
    saveMobilePreviewState({
      input: inputUrl,
      presetId,
      rotated,
      zoom,
      customSize,
      source: activeSource,
    });
  }, [activeSource, customSize, inputUrl, presetId, rotated, zoom]);

  // Close menus on outside click
  useEffect(() => {
    if (!historyOpen && !sizeMenuOpen && !screenshotMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (historyOpen && historyDropdownRef.current && !historyDropdownRef.current.contains(target)) {
        setHistoryOpen(false);
      }
      if (sizeMenuOpen && sizeDropdownRef.current && !sizeDropdownRef.current.contains(target)) {
        setSizeMenuOpen(false);
      }
      if (
        screenshotMenuOpen &&
        screenshotDropdownRef.current &&
        !screenshotDropdownRef.current.contains(target)
      ) {
        setScreenshotMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [historyOpen, screenshotMenuOpen, sizeMenuOpen]);

  const commitUrl = useCallback((url: string) => {
    setPendingLocalUrl(null);
    setUrlError("");
    setInputUrl(url);
    setActiveSource({
      kind: "url",
      url,
      raw: url,
      isLocalOrPrivate: false,
    });
    const updated = addMobilePreviewUrlToHistory(url);
    setHistoryList(updated);
  }, []);

  const handleNavigate = useCallback(
    (rawInput?: string) => {
      const target = rawInput !== undefined ? rawInput : inputUrl;
      setHistoryOpen(false);
      const check = validatePreviewUrl(target);
      if (!check.valid) {
        setUrlError(check.error || "Invalid web address");
        return;
      }
      setUrlError("");
      if (check.isLocalOrPrivate && (activeSource?.kind !== "url" || activeSource.url !== check.url)) {
        setPendingLocalUrl(check.url);
        return;
      }
      commitUrl(check.url);
    },
    [activeSource, commitUrl, inputUrl],
  );

  const handleSelectProjectFile = useCallback((fileSource: PreviewFileSource) => {
    setPendingLocalUrl(null);
    setUrlError("");
    setActiveSource(fileSource);
    setInputUrl(describePreviewSource(fileSource));
  }, []);

  const handleCaptureScreenshot = useCallback(
    async (mode: "visible" | "full") => {
      setScreenshotMenuOpen(false);
      if (!activeSource || !frameRef.current || capturing) return;
      setCapturing(true);
      setToast(null);
      try {
        if (sharesLinkOnly(activeSource, Boolean(window.gbs))) {
          const text = `Preview: ${previewShareLink(activeSource, window.location.origin)}\nShared as a link; no screenshot was captured.`;
          window.dispatchEvent(new CustomEvent("gbs:preview-share-link", { detail: { targetId: state.selectedId, text } }));
          setToast("Link added to chat");
          setTimeout(() => setToast(null), 2500);
          return;
        }
        const attachment = await frameRef.current.captureScreenshot(mode, {
          title: preset.label,
          width: effectiveDims.width,
          height: effectiveDims.height,
        });
        const sourceDesc = describePreviewSource(activeSource);
        const caption = `Preview (${preset.label} — ${effectiveDims.width}×${effectiveDims.height}): ${sourceDesc}`;
        onScreenshot?.(attachment);
        onSendScreenshotToChat?.(attachment, caption);
        setToast("Sent to chat");
        setTimeout(() => setToast(null), 2500);
      } catch {
        setToast("Screenshot failed");
        setTimeout(() => setToast(null), 2500);
      } finally {
        setCapturing(false);
      }
    },
    [
      activeSource,
      state.selectedId,
      capturing,
      effectiveDims.height,
      effectiveDims.width,
      onScreenshot,
      onSendScreenshotToChat,
      preset.label,
    ],
  );

  const handleOpenInPreviewPage = useCallback(() => {
    savePreviewStudioState({
      input: inputUrl,
      source: activeSource,
      presetId,
      rotated,
      zoom,
      customSize,
    });
    dispatch({ type: "togglePreview", open: true });
  }, [activeSource, customSize, dispatch, inputUrl, presetId, rotated, zoom]);

  if (!open) return null;

  const canCaptureScreenshot = Boolean(onScreenshot || onSendScreenshotToChat);

  return (
    <aside
      aria-label="Quick preview panel"
      className={cn(
        "flex h-full w-[420px] shrink-0 select-none flex-col border-l border-hairline/60 bg-raised/90 xl:w-[460px]",
        className,
      )}
    >
      {/* Row 1: Source Bar */}
      <div className="flex h-10 items-center gap-1.5 border-b border-hairline/50 px-2.5">
        <button
          type="button"
          onClick={() => setFilePickerOpen(true)}
          aria-label="Choose a project file"
          title="Choose a file from a project"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline/60 bg-inset text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>

        <div className="relative flex min-w-0 flex-1 items-center" ref={historyDropdownRef}>
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => {
              setInputUrl(e.target.value);
              if (urlError) setUrlError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleNavigate();
              }
            }}
            aria-label="Web address or project file"
            placeholder="http://localhost:3000 or project file"
            className="h-7 w-full rounded-lg border border-hairline/70 bg-inset pl-2.5 pr-7 font-mono text-[12px] text-ink placeholder:text-ink-muted focus:border-accent/60 focus:outline-none"
          />
          {historyList.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-label="Recent preview addresses"
              title="Recent addresses"
              className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            >
              <History className="h-3 w-3" />
            </button>
          )}

          {historyOpen && historyList.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-hairline bg-surface shadow-xl">
              <div className="flex items-center justify-between border-b border-hairline/40 px-2.5 py-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                  Recent addresses
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearMobilePreviewUrlHistory();
                    setHistoryList([]);
                    setHistoryOpen(false);
                  }}
                  className="inline-flex items-center gap-1 text-[10px] text-ink-muted transition-colors hover:text-danger"
                >
                  <Trash2 className="h-2.5 w-2.5" />
                  Clear
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto py-1">
                {historyList.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setInputUrl(item);
                      handleNavigate(item);
                    }}
                    className="block w-full truncate px-2.5 py-1.5 text-left font-mono text-[11px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => handleNavigate()}
          className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-hover"
        >
          Open
        </button>
      </div>

      {/* Row 2: Navigation, Size, Rotate, Zoom, Screenshot, Open in Preview page & Close */}
      <div className="flex h-9 items-center justify-between gap-1 border-b border-hairline/60 px-2.5">
        <div className="flex items-center gap-0.5">
          {window.gbs ? (
            <>
              <button
                type="button"
                onClick={() => frameRef.current?.goBack()}
                disabled={!historyNav.canGoBack}
                aria-label="Back"
                title="Back"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => frameRef.current?.goForward()}
                disabled={!historyNav.canGoForward}
                aria-label="Forward"
                title="Forward"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <span className="max-w-[80px] px-1 text-[10px] leading-tight text-ink-secondary" title="Back and Forward are available in the desktop app. Use Open in new tab for browser history.">
              History needs the desktop app
            </span>
          )}

          <button
            type="button"
            onClick={() => frameRef.current?.reload()}
            disabled={!activeSource}
            aria-label="Reload preview"
            title="Reload preview"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <RotateCw className={`h-3.5 w-3.5 ${frameStatus === "loading" ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Grouped Size Picker + Rotate + Zoom */}
        <div className="flex items-center gap-1">
          <div className="relative" ref={sizeDropdownRef}>
            <button
              type="button"
              onClick={() => setSizeMenuOpen((v) => !v)}
              aria-label="Choose preview size"
              aria-expanded={sizeMenuOpen}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline/60 bg-inset px-2 text-[11px] font-medium text-ink transition-colors hover:border-hairline hover:bg-hover"
            >
              <span className="max-w-[104px] truncate">{preset.label}</span>
              <span className="font-mono text-[10px] text-ink-muted">
                {effectiveDims.width}×{effectiveDims.height}
              </span>
              <ChevronDown className="h-3 w-3 text-ink-muted" />
            </button>

            {sizeMenuOpen && (
              <div className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-xl border border-hairline bg-surface p-1.5 shadow-xl">
                <div className="max-h-72 overflow-y-auto">
                  {PREVIEW_SIZE_GROUPS.map((group) => (
                    <div key={group.group} className="mb-1.5 last:mb-0">
                      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        {group.label}
                      </div>
                      {group.presets.map((item) => {
                        const active = item.id === preset.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setPresetId(item.id);
                              setSizeMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors ${
                              active
                                ? "bg-accent/15 font-medium text-ink"
                                : "text-ink-secondary hover:bg-hover hover:text-ink"
                            }`}
                          >
                            <span>{item.label}</span>
                            <span className="font-mono text-[10.5px] text-ink-muted">
                              {item.width} × {item.height}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}

                  <div className="mt-1 border-t border-hairline/50 pt-1.5">
                    <button
                      type="button"
                      onClick={() => setPresetId("custom")}
                      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors ${
                        preset.id === "custom"
                          ? "bg-accent/15 font-medium text-ink"
                          : "text-ink-secondary hover:bg-hover hover:text-ink"
                      }`}
                    >
                      <span>Custom size</span>
                      <span className="font-mono text-[10.5px] text-ink-muted">
                        {customSize.width} × {customSize.height}
                      </span>
                    </button>
                    {preset.id === "custom" && (
                      <div className="mt-1.5 flex items-center gap-1.5 px-2 pb-1">
                        <input
                          type="number"
                          min={240}
                          max={3840}
                          value={customSize.width}
                          onChange={(e) =>
                            setCustomSize((prev) => ({
                              ...prev,
                              width: clampCustomDimension(Number(e.target.value)),
                            }))
                          }
                          aria-label="Custom width"
                          className="h-7 w-20 rounded border border-hairline/70 bg-inset px-2 font-mono text-[11px] text-ink"
                        />
                        <span className="text-[11px] text-ink-muted">×</span>
                        <input
                          type="number"
                          min={240}
                          max={3840}
                          value={customSize.height}
                          onChange={(e) =>
                            setCustomSize((prev) => ({
                              ...prev,
                              height: clampCustomDimension(Number(e.target.value)),
                            }))
                          }
                          aria-label="Custom height"
                          className="h-7 w-20 rounded border border-hairline/70 bg-inset px-2 font-mono text-[11px] text-ink"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setRotated((v) => !v)}
            disabled={!preset.rotatable}
            aria-label="Rotate preview"
            aria-pressed={rotated}
            title="Rotate (swap width and height)"
            className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
              rotated
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-transparent text-ink-secondary hover:bg-hover hover:text-ink"
            } disabled:opacity-35`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>

          <select
            value={zoom}
            onChange={(e) => setZoom(e.target.value as PreviewZoomMode)}
            aria-label="Preview zoom level"
            className="h-7 rounded-md border border-hairline/60 bg-inset px-1.5 text-[11px] text-ink focus:border-accent/60 focus:outline-none"
          >
            {PREVIEW_ZOOM_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Right actions: Screenshot, Open in Preview page, Close */}
        <div className="flex items-center gap-0.5">
          {canCaptureScreenshot && (
            <div className="relative" ref={screenshotDropdownRef}>
              <button
                type="button"
                onClick={() => setScreenshotMenuOpen((v) => !v)}
                disabled={!activeSource || capturing}
                aria-label={sharesLinkOnly(activeSource, Boolean(window.gbs)) ? "Add preview link to chat" : "Send screenshot to chat"}
                title={sharesLinkOnly(activeSource, Boolean(window.gbs)) ? PAGE_SHARE_NOTICE : "Send screenshot to chat"}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35"
              >
                <Camera className="h-3.5 w-3.5" />
              </button>
              {screenshotMenuOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-xl border border-hairline bg-surface p-1 shadow-xl">
                  <button
                    type="button"
                    onClick={() => void handleCaptureScreenshot("visible")}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink transition-colors hover:bg-hover"
                  >
                    {sharesLinkOnly(activeSource, Boolean(window.gbs)) ? "Add preview link to chat" : "Send visible area to chat"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCaptureScreenshot("full")}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink transition-colors hover:bg-hover"
                  >
                    {sharesLinkOnly(activeSource, Boolean(window.gbs)) ? "Add preview link to chat" : "Send full page to chat"}
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleOpenInPreviewPage}
            aria-label="Open in Preview page"
            title="Open in Preview page"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close quick preview"
            title="Close preview"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {sharesLinkOnly(activeSource, Boolean(window.gbs)) && (
        <p role="status" className="border-b border-hairline px-3 py-2 text-[11px] text-ink-secondary">{PAGE_SHARE_NOTICE}</p>
      )}
      {/* Inline validation error banner */}
      {urlError && (
        <div
          role="alert"
          className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11.5px] text-danger"
        >
          {urlError}
        </div>
      )}

      {/* Viewport stage */}
      <div
        ref={stageRef}
        className="relative flex flex-1 items-start justify-center overflow-auto bg-inset/50 p-4"
      >
        <PreviewFrame
          ref={frameRef}
          source={activeSource}
          width={effectiveDims.width}
          height={effectiveDims.height}
          scale={scale}
          pendingConfirmUrl={pendingLocalUrl}
          onConfirmLocalUrl={() => {
            if (pendingLocalUrl) commitUrl(pendingLocalUrl);
          }}
          onCancelLocalUrl={() => setPendingLocalUrl(null)}
          onQuickPickUrl={(presetUrl) => {
            setInputUrl(presetUrl);
            handleNavigate(presetUrl);
          }}
          onOpenFilePicker={() => setFilePickerOpen(true)}
          onStatusChange={setFrameStatus}
          onHistoryStateChange={setHistoryNav}
          frameTitle={preset.label}
          showDeviceBezel={preset.group === "phone" || preset.group === "tablet"}
        />
      </div>

      {/* Footer status strip */}
      <div className="flex h-7 items-center justify-between border-t border-hairline/50 bg-raised/70 px-3 text-[11px] text-ink-muted">
        <div className="flex items-center gap-1.5 truncate">
          <span className="font-medium text-ink-secondary">{preset.label}</span>
          <span>·</span>
          <span className="font-mono">
            {effectiveDims.width} × {effectiveDims.height}
          </span>
          {rotated && <span className="text-accent">(Rotated)</span>}
        </div>
        <div className="flex items-center gap-2">
          {toast ? (
            <span className="font-medium text-accent">{toast}</span>
          ) : (
            <span className="font-mono">{Math.round(scale * 100)}%</span>
          )}
        </div>
      </div>

      <PreviewFilePicker
        open={filePickerOpen}
        onClose={() => setFilePickerOpen(false)}
        onSelectFile={handleSelectProjectFile}
        initialProjectId={activeSource?.kind === "file" ? activeSource.projectId : undefined}
      />
    </aside>
  );
}
