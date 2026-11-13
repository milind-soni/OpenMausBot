import { PAGE_SHARE_NOTICE, previewShareLink, sharesLinkOnly } from "@/lib/previewSharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  History,
  Laptop,
  Maximize2,
  Monitor,
  MoreHorizontal,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
  Tablet,
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
  type PreviewSizeGroup,
  type PreviewSizePreset,
  type PreviewZoomMode,
} from "@/lib/previewSizes";
import {
  buildProjectFilePreviewUrl,
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

function getDeviceGroupIcon(group: PreviewSizeGroup) {
  switch (group) {
    case "tablet":
      return Tablet;
    case "laptop":
      return Laptop;
    case "desktop":
      return Monitor;
    case "custom":
      return SlidersHorizontal;
    case "phone":
    default:
      return Smartphone;
  }
}

function shortDeviceLabel(preset: PreviewSizePreset): string {
  if (preset.id === "custom") return "Custom";
  switch (preset.group) {
    case "tablet":
      return "Tablet";
    case "laptop":
      return "Laptop";
    case "desktop":
      return "Desktop";
    case "phone":
    default:
      return "Phone";
  }
}

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
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const filePickerTriggerRef = useRef<HTMLElement | null>(null);

  const openFilePicker = (trigger?: HTMLElement | null) => {
    filePickerTriggerRef.current =
      trigger || (typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
    setFilePickerOpen(true);
  };
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stageBounds, setStageBounds] = useState({ width: 380, height: 640 });

  const frameRef = useRef<PreviewFrameHandle | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);
  const sizeDropdownRef = useRef<HTMLDivElement | null>(null);
  const screenshotDropdownRef = useRef<HTMLDivElement | null>(null);
  const moreDropdownRef = useRef<HTMLDivElement | null>(null);

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

  const isDeviceSource = useMemo(() => {
    if (!activeSource) return true;
    if (activeSource.kind === "url") return true;
    return activeSource.fileType === "html";
  }, [activeSource]);

  const handleOpenExternally = useCallback(() => {
    if (!activeSource) return;
    if (activeSource.kind === "url") {
      window.open(activeSource.url, "_blank", "noreferrer");
    } else {
      const fileUrl = buildProjectFilePreviewUrl(activeSource.projectId, activeSource.filePath);
      window.open(fileUrl, "_blank", "noreferrer");
    }
  }, [activeSource]);

  // Close menus on outside click or Escape
  useEffect(() => {
    if (!historyOpen && !sizeMenuOpen && !screenshotMenuOpen && !moreMenuOpen) return;
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
      if (
        moreMenuOpen &&
        moreDropdownRef.current &&
        !moreDropdownRef.current.contains(target)
      ) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setHistoryOpen(false);
      setSizeMenuOpen(false);
      setScreenshotMenuOpen(false);
      setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyOpen, moreMenuOpen, screenshotMenuOpen, sizeMenuOpen]);

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
  const DeviceIcon = getDeviceGroupIcon(preset.group);

  return (
    <aside
      aria-label="Quick preview panel"
      className={cn(
        "flex h-full w-[380px] shrink-0 select-none flex-col border-l border-hairline/60 bg-panel 2xl:w-[420px]",
        className,
      )}
    >
      {/* Redesigned Single Header (h-[53px] aligned with Chat & Tasks headers) */}
      <header className="flex h-[53px] shrink-0 items-center justify-between gap-1.5 border-b border-hairline/40 bg-panel px-3">
        {isDeviceSource ? (
          /* State A: Web / HTML document preview */
          <>
            {/* Title */}
            <div className="flex items-center gap-1.5 shrink-0 text-ink" title="Quick preview">
              <Smartphone size={15} className="text-accent shrink-0" />
              <span className="text-[13px] font-semibold text-ink hidden 2xl:inline">Preview</span>
            </div>

            {/* Compact Address Field */}
            <div
              className="relative flex min-w-[130px] flex-1 items-center rounded-lg border border-hairline/60 bg-inset h-8 px-1 focus-within:border-accent/60 transition-colors"
              ref={historyDropdownRef}
            >
              <button
                type="button"
                onClick={(e) => openFilePicker(e.currentTarget)}
                aria-label="Choose a project file"
                title="Choose a file from a project"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>

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
                placeholder="http://localhost:3000 or file"
                className="h-full min-w-0 flex-1 bg-transparent px-1 font-mono text-[11px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
              />

              {historyList.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  aria-label="Recent preview addresses"
                  title="Recent addresses"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
                >
                  <History className="h-3 w-3" />
                </button>
              )}

              {/* History Dropdown */}
              {historyOpen && historyList.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Recent preview addresses"
                  className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-hairline bg-panel shadow-xl"
                >
                  <div className="flex items-center justify-between border-b border-hairline/40 px-2.5 py-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-secondary">
                      Recent addresses
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        clearMobilePreviewUrlHistory();
                        setHistoryList([]);
                        setHistoryOpen(false);
                      }}
                      className="inline-flex items-center gap-1 text-[10px] text-ink-secondary transition-colors hover:text-danger"
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
                        className="block w-full truncate px-2.5 py-1.5 text-left font-mono text-[11px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Primary Controls */}
            <div className="flex items-center gap-0.5 shrink-0">
              {/* Reload */}
              <button
                type="button"
                onClick={() => frameRef.current?.reload()}
                disabled={!activeSource}
                aria-label="Reload preview"
                title="Reload preview"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <RotateCw className={cn("h-3.5 w-3.5", frameStatus === "loading" && "animate-spin")} />
              </button>

              {/* Grouped Size Selector (Icon + Short Label) */}
              <div className="relative shrink-0" ref={sizeDropdownRef}>
                <button
                  type="button"
                  onClick={() => setSizeMenuOpen((v) => !v)}
                  aria-label="Choose preview size"
                  aria-expanded={sizeMenuOpen}
                  title={`${preset.label} (${effectiveDims.width}×${effectiveDims.height})`}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline/60 bg-inset px-1.5 text-[11px] font-medium text-ink transition-colors hover:border-hairline hover:bg-raised-hover"
                >
                  <DeviceIcon className="h-3 w-3 text-ink-secondary shrink-0" />
                  <span className="shrink-0">{shortDeviceLabel(preset)}</span>
                  <ChevronDown className="h-3 w-3 text-ink-secondary shrink-0" />
                </button>

                {sizeMenuOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-hairline bg-panel p-1.5 shadow-xl">
                    <div className="max-h-72 overflow-y-auto">
                      {PREVIEW_SIZE_GROUPS.map((group) => (
                        <div key={group.group} className="mb-1.5 last:mb-0">
                          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
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
                                    : "text-ink-secondary hover:bg-raised-hover hover:text-ink"
                                }`}
                              >
                                <span>{item.label}</span>
                                <span className="font-mono text-[10.5px] text-ink-secondary">
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
                              : "text-ink-secondary hover:bg-raised-hover hover:text-ink"
                          }`}
                        >
                          <span>Custom size</span>
                          <span className="font-mono text-[10.5px] text-ink-secondary">
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
                            <span className="text-[11px] text-ink-secondary">×</span>
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

              {/* Rotate */}
              <button
                type="button"
                onClick={() => setRotated((v) => !v)}
                disabled={!preset.rotatable}
                aria-label="Rotate preview"
                aria-pressed={rotated}
                title="Rotate (swap width and height)"
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:opacity-35",
                  rotated
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-transparent text-ink-secondary hover:bg-raised-hover hover:text-ink",
                )}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
              </button>

              {/* Overflow Menu (•••) */}
              <div className="relative" ref={moreDropdownRef}>
                <button
                  type="button"
                  onClick={() => setMoreMenuOpen((v) => !v)}
                  aria-label="More preview options"
                  aria-expanded={moreMenuOpen}
                  title="More options"
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink",
                    moreMenuOpen && "bg-raised text-ink",
                  )}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>

                {moreMenuOpen && (
                  <div
                    role="menu"
                    aria-label="More preview options"
                    className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-hairline bg-panel p-1.5 shadow-xl"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        handleOpenInPreviewPage();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover"
                    >
                      <Maximize2 className="h-3.5 w-3.5 text-ink-secondary" />
                      <span>Open in Preview page</span>
                    </button>

                    {canCaptureScreenshot && (
                      <div className="mt-1 border-t border-hairline/40 pt-1">
                        <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                          Share to chat
                        </div>
                        {sharesLinkOnly(activeSource, Boolean(window.gbs)) ? (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMoreMenuOpen(false);
                              void handleCaptureScreenshot("visible");
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover"
                          >
                            <Camera className="h-3.5 w-3.5 text-ink-secondary" />
                            <span>Add preview link to chat</span>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={!activeSource || capturing}
                              onClick={() => {
                                setMoreMenuOpen(false);
                                void handleCaptureScreenshot("visible");
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-35"
                            >
                              <Camera className="h-3.5 w-3.5 text-ink-secondary" />
                              <span>Send visible area</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={!activeSource || capturing}
                              onClick={() => {
                                setMoreMenuOpen(false);
                                void handleCaptureScreenshot("full");
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-35"
                            >
                              <Camera className="h-3.5 w-3.5 text-ink-secondary" />
                              <span>Send full page</span>
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    <div className="mt-1 border-t border-hairline/40 pt-1">
                      <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                        Zoom
                      </div>
                      {PREVIEW_ZOOM_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setZoom(opt.value as PreviewZoomMode);
                            setMoreMenuOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors",
                            zoom === opt.value
                              ? "bg-accent/15 font-medium text-ink"
                              : "text-ink-secondary hover:bg-raised-hover hover:text-ink",
                          )}
                        >
                          <span>{opt.label}</span>
                          {zoom === opt.value && <Check className="h-3 w-3 text-accent" />}
                        </button>
                      ))}
                    </div>

                    {window.gbs && (
                      <div className="mt-1 border-t border-hairline/40 pt-1">
                        <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                          History
                        </div>
                        <div className="flex items-center gap-1 px-1">
                          <button
                            type="button"
                            disabled={!historyNav.canGoBack}
                            onClick={() => {
                              frameRef.current?.goBack();
                              setMoreMenuOpen(false);
                            }}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 bg-inset px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-35"
                          >
                            <ChevronLeft className="h-3 w-3" />
                            <span>Back</span>
                          </button>
                          <button
                            type="button"
                            disabled={!historyNav.canGoForward}
                            onClick={() => {
                              frameRef.current?.goForward();
                              setMoreMenuOpen(false);
                            }}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 bg-inset px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-35"
                          >
                            <span>Forward</span>
                            <ChevronRight className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Close Button */}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close quick preview"
                title="Close preview"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          /* State B: Full-screen file viewer (Markdown, PDF, Image) */
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <FolderOpen size={15} className="text-accent shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12.5px] font-semibold text-ink" title={describePreviewSource(activeSource)}>
                  {describePreviewSource(activeSource)}
                </span>
                {activeSource?.kind === "file" && (
                  <span className="text-[10px] uppercase tracking-wider text-ink-secondary">
                    {activeSource.fileType} viewer
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={(e) => openFilePicker(e.currentTarget)}
                aria-label="Choose another file"
                title="Choose another file"
                className="ml-1 inline-flex h-6 items-center gap-1 rounded border border-hairline/60 bg-inset px-1.5 text-[10.5px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink shrink-0"
              >
                Change
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveSource(null);
                  setInputUrl("");
                }}
                aria-label="Enter web address"
                title="Switch to web address"
                className="inline-flex h-6 items-center gap-1 rounded border border-hairline/60 bg-inset px-1.5 text-[10.5px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink shrink-0"
              >
                Web URL
              </button>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={() => frameRef.current?.reload()}
                aria-label="Reload file"
                title="Reload file"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <RotateCw className={cn("h-3.5 w-3.5", frameStatus === "loading" && "animate-spin")} />
              </button>

              <button
                type="button"
                onClick={handleOpenExternally}
                aria-label="Open externally in new tab"
                title="Open in new tab"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>

              {canCaptureScreenshot && (
                <div className="relative" ref={screenshotDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setScreenshotMenuOpen((v) => !v)}
                    disabled={!activeSource || capturing}
                    aria-label="Send screenshot to chat"
                    title="Send screenshot to chat"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35"
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </button>
                  {screenshotMenuOpen && (
                    <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-xl border border-hairline bg-panel p-1 shadow-xl">
                      <button
                        type="button"
                        onClick={() => void handleCaptureScreenshot("visible")}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink transition-colors hover:bg-raised-hover"
                      >
                        Send visible area to chat
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCaptureScreenshot("full")}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink transition-colors hover:bg-raised-hover"
                      >
                        Send full page to chat
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
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={onClose}
                aria-label="Close quick preview"
                title="Close preview"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </header>

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
          onOpenFilePicker={() => openFilePicker()}
          onStatusChange={setFrameStatus}
          onHistoryStateChange={setHistoryNav}
          frameTitle={preset.label}
          showDeviceBezel={preset.group === "phone" || preset.group === "tablet"}
        />
      </div>

      {/* Footer status strip */}
      <div className="flex h-7 items-center justify-between border-t border-hairline/50 bg-raised/70 px-3 text-[11px] text-ink-secondary">
        <div className="flex items-center gap-1.5 truncate">
          {isDeviceSource ? (
            <>
              <span className="font-medium text-ink">{preset.label}</span>
              <span>·</span>
              <span className="font-mono">
                {effectiveDims.width} × {effectiveDims.height}
              </span>
              {rotated && <span className="text-accent">(Rotated)</span>}
            </>
          ) : (
            <>
              <span className="font-medium text-ink">File viewer</span>
              {activeSource?.kind === "file" && (
                <>
                  <span>·</span>
                  <span className="uppercase">{activeSource.fileType}</span>
                </>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeSource && frameStatus !== "empty" && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-secondary"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  frameStatus === "loaded"
                    ? "bg-success"
                    : frameStatus === "loading"
                      ? "animate-pulse bg-accent"
                      : "bg-danger"
                }`}
              />
              {frameStatus === "loading"
                ? "Loading preview…"
                : frameStatus === "loaded"
                  ? "Preview loaded"
                  : "Couldn't open this page"}
            </span>
          )}
          {toast ? (
            <span className="font-medium text-accent">{toast}</span>
          ) : isDeviceSource ? (
            <span className="font-mono">{Math.round(scale * 100)}%</span>
          ) : null}
        </div>
      </div>

      <PreviewFilePicker
        open={filePickerOpen}
        triggerRef={filePickerTriggerRef}
        onClose={() => setFilePickerOpen(false)}
        onSelectFile={handleSelectProjectFile}
        initialProjectId={activeSource?.kind === "file" ? activeSource.projectId : undefined}
      />
    </aside>
  );
}
