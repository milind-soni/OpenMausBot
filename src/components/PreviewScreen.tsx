import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Globe,
  History,
  LayoutGrid,
  Monitor,
  RefreshCw,
  RotateCw,
  Trash2,
} from "lucide-react";
import {
  applyRotation,
  clampCustomDimension,
  computeFrameScale,
  DEFAULT_CANVAS_SIZE_IDS,
  PREVIEW_SIZE_PRESETS,
  PREVIEW_ZOOM_OPTIONS,
  resolvePreviewSize,
  type CanvasArtboardBox,
  type CanvasViewTransform,
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
  loadPreviewStudioState,
  saveMobilePreviewState,
  savePreviewStudioState,
} from "@/lib/mobilePreviewState";
import { PreviewFrame, type PreviewFrameHandle, type PreviewFrameStatus } from "@/components/PreviewFrame";
import { PreviewCanvas } from "@/components/PreviewCanvas";
import { PreviewFilePicker, usePreviewAutoRefreshWatcher } from "@/components/PreviewFilePicker";
import { SharePreviewModal, type SharePreviewRequest } from "@/components/SharePreviewModal";
import { useStore, type Attachment } from "@/state/store";

export default function PreviewScreen() {
  const { dispatch } = useStore();
  const initial = useMemo(() => loadPreviewStudioState(), []);

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
  const [sourceKindTab, setSourceKindTab] = useState<"url" | "file">(() =>
    initial.source?.kind === "file" ? "file" : "url",
  );
  const [mode, setMode] = useState<"single" | "canvas">(initial.mode);
  const [presetId, setPresetId] = useState(initial.presetId);
  const [rotated, setRotated] = useState(initial.rotated);
  const [zoom, setZoom] = useState<PreviewZoomMode>(initial.zoom);
  const [customSize, setCustomSize] = useState(initial.customSize);
  const [autoRefresh, setAutoRefresh] = useState(initial.autoRefresh);
  const [selectedSizeIds, setSelectedSizeIds] = useState<string[]>(initial.selectedSizeIds);
  const [rotatedById, setRotatedById] = useState<Record<string, boolean>>(initial.rotatedById);
  const [canvasTransform, setCanvasTransform] = useState<CanvasViewTransform | null>(
    initial.canvasTransform,
  );
  const [scrollSync, setScrollSync] = useState(initial.scrollSync);

  const [urlError, setUrlError] = useState("");
  const [pendingLocalUrl, setPendingLocalUrl] = useState<string | null>(null);
  const [frameStatus, setFrameStatus] = useState<PreviewFrameStatus>("empty");
  const [historyNav, setHistoryNav] = useState({ canGoBack: false, canGoForward: false });
  const [historyList, setHistoryList] = useState<string[]>(() => getMobilePreviewUrlHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareDefaultScope, setShareDefaultScope] = useState<"current" | "all">("current");
  const [shareOverrideArtboard, setShareOverrideArtboard] = useState<CanvasArtboardBox | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [stageBounds, setStageBounds] = useState({ width: 960, height: 720 });

  const singleFrameRef = useRef<PreviewFrameHandle | null>(null);
  const canvasFrameRefs = useRef<Map<string, PreviewFrameHandle>>(new Map());
  const singleStageRef = useRef<HTMLDivElement | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);

  usePreviewAutoRefreshWatcher("preview-studio-screen", activeSource, autoRefresh);

  const activePreset = useMemo(() => resolvePreviewSize(presetId, customSize), [customSize, presetId]);
  const singleDims = useMemo(
    () => applyRotation(activePreset, activePreset.rotatable ? rotated : false),
    [activePreset, rotated],
  );
  const singleScale = useMemo(
    () => computeFrameScale(singleDims, stageBounds, zoom, 28),
    [singleDims, stageBounds, zoom],
  );

  // Measure Single mode stage bounds
  useEffect(() => {
    const el = singleStageRef.current;
    if (!el || mode !== "single") return;
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
  }, [mode]);

  // Persist Preview Studio state & keep quick preview state in sync
  useEffect(() => {
    savePreviewStudioState({
      input: inputUrl,
      source: activeSource,
      presetId,
      rotated,
      zoom,
      customSize,
      autoRefresh,
      mode,
      selectedSizeIds,
      rotatedById,
      canvasTransform,
      scrollSync,
    });
    saveMobilePreviewState({
      input: inputUrl,
      presetId,
      rotated,
      zoom,
      customSize,
      source: activeSource,
    });
  }, [
    activeSource,
    autoRefresh,
    canvasTransform,
    customSize,
    inputUrl,
    mode,
    presetId,
    rotated,
    rotatedById,
    scrollSync,
    selectedSizeIds,
    zoom,
  ]);

  // Close history dropdown on outside click
  useEffect(() => {
    if (!historyOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [historyOpen]);

  // Single-mode keyboard shortcuts: [ and ] cycle sizes, R rotates
  useEffect(() => {
    if (mode !== "single") return;
    const allIds = [...PREVIEW_SIZE_PRESETS.map((p) => p.id), "custom"];
    const isTypingTarget = (target: EventTarget | null) => {
      const tag = (target as HTMLElement | null)?.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean((target as HTMLElement | null)?.isContentEditable)
      );
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const idx = allIds.indexOf(activePreset.id);
        const delta = e.key === "]" ? 1 : -1;
        const nextIdx = (idx + delta + allIds.length) % allIds.length;
        setPresetId(allIds[nextIdx]);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (activePreset.rotatable) {
          setRotated((v) => !v);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePreset.id, activePreset.rotatable, mode]);

  const commitUrl = useCallback((url: string) => {
    setPendingLocalUrl(null);
    setUrlError("");
    setInputUrl(url);
    setSourceKindTab("url");
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
    setSourceKindTab("file");
    setActiveSource(fileSource);
    setInputUrl(describePreviewSource(fileSource));
  }, []);

  const toggleCanvasSizeId = useCallback((id: string) => {
    setSelectedSizeIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev; // Keep at least 1 active size
        return prev.filter((item) => item !== id);
      }
      return [...prev, id];
    });
  }, []);

  const toggleRotateCanvasArtboard = useCallback((id: string) => {
    setRotatedById((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const reloadAllCanvasFrames = useCallback(() => {
    for (const handle of canvasFrameRefs.current.values()) {
      handle.reload();
    }
  }, []);

  const handleShareSubmit = useCallback(
    async (request: SharePreviewRequest) => {
      if (!activeSource) return;
      const attachments: Attachment[] = [];

      if (shareOverrideArtboard) {
        const handle = canvasFrameRefs.current.get(shareOverrideArtboard.id);
        if (handle) {
          const att = await handle.captureScreenshot(request.area, {
            title: shareOverrideArtboard.preset.label,
            width: shareOverrideArtboard.width,
            height: shareOverrideArtboard.height,
          });
          attachments.push(att);
        }
      } else if (request.scope === "current" || mode === "single") {
        const handle =
          mode === "single"
            ? singleFrameRef.current
            : canvasFrameRefs.current.get(activePreset.id) ??
              canvasFrameRefs.current.values().next().value;
        if (handle) {
          const att = await handle.captureScreenshot(request.area, {
            title: activePreset.label,
            width: singleDims.width,
            height: singleDims.height,
          });
          attachments.push(att);
        }
      } else {
        for (const id of selectedSizeIds) {
          const preset = resolvePreviewSize(id, customSize);
          const dims = applyRotation(preset, Boolean(rotatedById[id]));
          const handle = canvasFrameRefs.current.get(id) ?? singleFrameRef.current;
          if (handle) {
            const att = await handle.captureScreenshot(request.area, {
              title: preset.label,
              width: dims.width,
              height: dims.height,
            });
            attachments.push(att);
          }
        }
      }

      const sourceDesc = describePreviewSource(activeSource);
      const defaultCaption =
        attachments.length > 1
          ? `Shared ${attachments.length} preview sizes for ${sourceDesc}`
          : `Preview (${shareOverrideArtboard?.preset.label ?? activePreset.label}): ${sourceDesc}`;
      const text = request.note ? `${request.note}\n\n${defaultCaption}` : defaultCaption;

      if (request.target.kind === "group") {
        dispatch({
          type: "sendGroup",
          groupId: request.target.id,
          text,
          attachments,
        });
      } else {
        dispatch({
          type: "send",
          botId: request.target.id,
          text,
          attachments,
        });
      }

      setShareOverrideArtboard(null);
      setToast(`Sent to ${request.target.name}`);
      setTimeout(() => setToast(null), 3000);
    },
    [
      activePreset.id,
      activePreset.label,
      activeSource,
      customSize,
      dispatch,
      mode,
      rotatedById,
      selectedSizeIds,
      shareOverrideArtboard,
      singleDims.height,
      singleDims.width,
    ],
  );

  const modalSizeLabel = shareOverrideArtboard?.preset.label ?? activePreset.label;
  const modalDimensionsLabel = shareOverrideArtboard
    ? `${shareOverrideArtboard.width} × ${shareOverrideArtboard.height}`
    : `${singleDims.width} × ${singleDims.height}`;

  return (
    <main
      aria-label="Preview Studio"
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface text-ink"
    >
      {/* Top Bar Row 1: Source Bar & Mode Switch */}
      <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-hairline/60 bg-raised/80 px-4 py-2">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => dispatch({ type: "togglePreview", open: false })}
            aria-label="Back to chat"
            title="Back to chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline/60 bg-inset text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[15px] font-semibold text-ink">Preview</h1>

          {/* Source Kind Switch (Web address | Project file) */}
          <div className="ml-1 flex items-center rounded-lg border border-hairline/60 bg-inset p-0.5">
            <button
              type="button"
              onClick={() => setSourceKindTab("url")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium transition-colors ${
                sourceKindTab === "url"
                  ? "bg-raised text-ink shadow-xs"
                  : "text-ink-secondary hover:text-ink"
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              Web address
            </button>
            <button
              type="button"
              onClick={() => {
                setSourceKindTab("file");
                setFilePickerOpen(true);
              }}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium transition-colors ${
                sourceKindTab === "file"
                  ? "bg-raised text-ink shadow-xs"
                  : "text-ink-secondary hover:text-ink"
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Project file
            </button>
          </div>
        </div>

        {/* Center: Address Input or Project File Selector + Auto-refresh */}
        <div className="flex min-w-[280px] max-w-[600px] flex-1 items-center gap-1.5">
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
              aria-label="Web address or project file path"
              placeholder="Enter http://localhost:3000 or choose a project file…"
              className="h-8 w-full rounded-lg border border-hairline/70 bg-inset pl-3 pr-8 font-mono text-[12px] text-ink placeholder:text-ink-muted focus:border-accent/60 focus:outline-none"
            />
            {historyList.length > 0 && (
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                aria-label="Recent preview addresses"
                title="Recent addresses"
                className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded text-ink-muted transition-colors hover:bg-hover hover:text-ink"
              >
                <History className="h-3.5 w-3.5" />
              </button>
            )}

            {historyOpen && historyList.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-hairline bg-surface shadow-xl">
                <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-1.5">
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
                <div className="max-h-52 overflow-y-auto py-1">
                  {historyList.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        setInputUrl(item);
                        handleNavigate(item);
                      }}
                      className="block w-full truncate px-3 py-1.5 text-left font-mono text-[11.5px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
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
            onClick={() => setFilePickerOpen(true)}
            aria-label="Choose a file from a project"
            title="Choose a file from a project"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline/70 bg-inset text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
          >
            <FolderOpen className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => handleNavigate()}
            className="h-8 shrink-0 rounded-lg bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Open
          </button>

          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            aria-pressed={autoRefresh}
            aria-label="Refresh automatically when files change"
            title="Refresh automatically when files change"
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-medium transition-colors ${
              autoRefresh
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-hairline/60 bg-inset text-ink-secondary hover:text-ink"
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Refresh automatically when files change</span>
            <span className="xl:hidden">Auto-refresh</span>
          </button>
        </div>

        {/* Right: Single/Canvas Mode Switch & Share to Chat */}
        <div className="flex items-center gap-2">
          {toast && (
            <span role="status" className="text-[12px] font-medium text-accent">
              {toast}
            </span>
          )}

          <div
            role="tablist"
            aria-label="Preview layout mode"
            className="flex items-center rounded-lg border border-hairline/60 bg-inset p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "single"}
              onClick={() => setMode("single")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                mode === "single"
                  ? "bg-raised text-ink shadow-xs"
                  : "text-ink-secondary hover:text-ink"
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />
              Single
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "canvas"}
              onClick={() => setMode("canvas")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                mode === "canvas"
                  ? "bg-raised text-ink shadow-xs"
                  : "text-ink-secondary hover:text-ink"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Canvas
            </button>
          </div>

          <button
            type="button"
            disabled={!activeSource}
            onClick={() => {
              setShareOverrideArtboard(null);
              setShareDefaultScope(mode === "canvas" && selectedSizeIds.length > 1 ? "all" : "current");
              setShareModalOpen(true);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-45"
          >
            <Camera className="h-3.5 w-3.5" />
            Share to chat…
          </button>
        </div>
      </header>

      {/* Top Bar Row 2: Size Bar & Viewport Controls */}
      <div className="flex min-h-[40px] flex-wrap items-center justify-between gap-2 border-b border-hairline/60 bg-raised/50 px-4 py-1.5">
        {mode === "single" ? (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <div className="mr-1 flex items-center gap-0.5 border-r border-hairline/50 pr-2">
                <button
                  type="button"
                  onClick={() => singleFrameRef.current?.goBack()}
                  disabled={!historyNav.canGoBack}
                  aria-label="Back"
                  title="Back"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => singleFrameRef.current?.goForward()}
                  disabled={!historyNav.canGoForward}
                  aria-label="Forward"
                  title="Forward"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => singleFrameRef.current?.reload()}
                  disabled={!activeSource}
                  aria-label="Reload preview"
                  title="Reload preview"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-35"
                >
                  <RotateCw
                    className={`h-3.5 w-3.5 ${frameStatus === "loading" ? "animate-spin" : ""}`}
                  />
                </button>
              </div>

              {PREVIEW_SIZE_PRESETS.map((item) => {
                const active = activePreset.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPresetId(item.id)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] transition-colors ${
                      active
                        ? "border-accent/40 bg-accent/15 font-medium text-ink"
                        : "border-transparent text-ink-secondary hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className="font-mono text-[10px] text-ink-muted">
                      {item.width}×{item.height}
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => setPresetId("custom")}
                className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] transition-colors ${
                  activePreset.id === "custom"
                    ? "border-accent/40 bg-accent/15 font-medium text-ink"
                    : "border-transparent text-ink-secondary hover:bg-hover hover:text-ink"
                }`}
              >
                <span>Custom</span>
                <span className="font-mono text-[10px] text-ink-muted">
                  {customSize.width}×{customSize.height}
                </span>
              </button>

              {activePreset.id === "custom" && (
                <div className="ml-1 flex items-center gap-1">
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
                    className="h-7 w-18 rounded border border-hairline/70 bg-inset px-2 font-mono text-[11px] text-ink"
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
                    className="h-7 w-18 rounded border border-hairline/70 bg-inset px-2 font-mono text-[11px] text-ink"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRotated((v) => !v)}
                disabled={!activePreset.rotatable}
                aria-label="Rotate preview"
                aria-pressed={rotated}
                title="Rotate (shortcut: R)"
                className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11.5px] transition-colors ${
                  rotated
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-hairline/60 bg-inset text-ink-secondary hover:text-ink"
                }`}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
                Rotate
              </button>

              <select
                value={zoom}
                onChange={(e) => setZoom(e.target.value as PreviewZoomMode)}
                aria-label="Preview zoom level"
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2 text-[11.5px] text-ink focus:border-accent/60 focus:outline-none"
              >
                {PREVIEW_ZOOM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <span className="font-mono text-[11px] text-ink-secondary">
                {singleDims.width} × {singleDims.height} · {Math.round(singleScale * 100)}%
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] font-medium text-ink-secondary">
                Sizes on canvas:
              </span>
              {PREVIEW_SIZE_PRESETS.map((item) => {
                const checked = selectedSizeIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleCanvasSizeId(item.id)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] transition-colors ${
                      checked
                        ? "border-accent/40 bg-accent/15 font-medium text-ink"
                        : "border-hairline/40 bg-inset/60 text-ink-secondary hover:text-ink"
                    }`}
                  >
                    {checked && <Check className="h-3 w-3 text-accent" />}
                    <span>{item.label}</span>
                    <span className="font-mono text-[10px] text-ink-muted">
                      {item.width}×{item.height}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedSizeIds([...DEFAULT_CANVAS_SIZE_IDS])}
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
              >
                Default 4
              </button>
              <button
                type="button"
                onClick={() =>
                  setSelectedSizeIds(
                    PREVIEW_SIZE_PRESETS.filter((p) => p.group === "phone").map((p) => p.id),
                  )
                }
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
              >
                All phones
              </button>
              <button
                type="button"
                onClick={() => setSelectedSizeIds(PREVIEW_SIZE_PRESETS.map((p) => p.id))}
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
              >
                All sizes
              </button>
              <button
                type="button"
                onClick={reloadAllCanvasFrames}
                disabled={!activeSource}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                <RotateCw className="h-3 w-3" />
                Reload all
              </button>
            </div>
          </>
        )}
      </div>

      {/* Inline URL validation error banner */}
      {urlError && (
        <div
          role="alert"
          className="border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[12px] text-danger"
        >
          {urlError}
        </div>
      )}

      {/* Main Stage: Single Mode or Canvas Mode */}
      {mode === "single" ? (
        <div
          ref={singleStageRef}
          className="relative flex flex-1 items-start justify-center overflow-auto bg-inset/50 p-6"
        >
          <PreviewFrame
            ref={singleFrameRef}
            source={activeSource}
            width={singleDims.width}
            height={singleDims.height}
            scale={singleScale}
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
            frameTitle={activePreset.label}
            showDeviceBezel={activePreset.group === "phone" || activePreset.group === "tablet"}
          />
        </div>
      ) : (
        <PreviewCanvas
          source={activeSource}
          selectedSizeIds={selectedSizeIds}
          rotatedById={rotatedById}
          customSize={customSize}
          initialTransform={canvasTransform}
          onTransformChange={setCanvasTransform}
          onToggleRotateArtboard={toggleRotateCanvasArtboard}
          onFocusSingleSize={(sizeId) => {
            setPresetId(sizeId);
            setRotated(Boolean(rotatedById[sizeId]));
            setMode("single");
          }}
          onShareArtboard={(artboard) => {
            setShareOverrideArtboard(artboard);
            setShareDefaultScope("current");
            setShareModalOpen(true);
          }}
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
          scrollSync={scrollSync}
          onToggleScrollSync={() => setScrollSync((v) => !v)}
          frameRefsMap={canvasFrameRefs}
        />
      )}

      <PreviewFilePicker
        open={filePickerOpen}
        onClose={() => setFilePickerOpen(false)}
        onSelectFile={handleSelectProjectFile}
        initialProjectId={activeSource?.kind === "file" ? activeSource.projectId : undefined}
      />

      <SharePreviewModal
        open={shareModalOpen}
        onClose={() => {
          setShareModalOpen(false);
          setShareOverrideArtboard(null);
        }}
        currentSizeLabel={modalSizeLabel}
        currentDimensionsLabel={modalDimensionsLabel}
        selectedSizesCount={mode === "canvas" ? selectedSizeIds.length : 1}
        defaultScope={shareDefaultScope}
        onSubmit={handleShareSubmit}
      />
    </main>
  );
}
