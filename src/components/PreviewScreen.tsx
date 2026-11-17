import { isDeviceSource } from "@/lib/previewSource";
import { sharesLinkOnly, previewShareLink } from "@/lib/previewSharing";
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
  RESPONSIVE_PREVIEW_SIZE_ID,
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
import { PreviewBotBar } from "@/components/PreviewBotBar";
import { SHOW_TESTING_EVENT, testingStore, useTestingState, viewFromSession, type ShowTestingDetail, type TestingView } from "@/lib/previewTestingStore";

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
  const deviceSource = isDeviceSource(activeSource);
  const [sourceKindTab, setSourceKindTab] = useState<"url" | "file">(() =>
    initial.source?.kind === "file" ? "file" : "url",
  );
  const [mode, setMode] = useState<"single" | "canvas">(initial.mode);
  const [ownPresetId, setOwnPresetId] = useState(initial.presetId);
  const [ownRotated, setOwnRotated] = useState(initial.rotated);
  const [ownZoom, setOwnZoom] = useState<PreviewZoomMode>(initial.zoom);
  const [ownCustomSize, setOwnCustomSize] = useState(initial.customSize);

  // Bot testing: a bot tab takes over the stage, and the toolbar acts on the bot's page and size.
  const testing = useTestingState();
  const botTab = testing.tab ? testing.sessions.find((s) => s.id === testing.tab && s.target !== "active") ?? null : null;
  const attached = testing.sessions.find((s) => s.target === "active" && (s.state === "ready" || s.state === "paused")) ?? null;
  const controlSession = botTab ?? (testing.tab === null ? attached : null);
  const botTabs = testing.sessions.filter((s) => s.target !== "active");
  const botView = botTab ? testing.views[botTab.id] : undefined;
  const botMeta = botTab ? testing.meta[botTab.id] : undefined;
  const presetId = botView?.presetId ?? ownPresetId;
  const rotated = botView ? botView.rotated : ownRotated;
  const zoom = botView?.zoom ?? ownZoom;
  const customSize = botView?.customSize ?? ownCustomSize;
  function routed<K extends "presetId" | "rotated" | "zoom" | "customSize">(key: K, own: React.Dispatch<React.SetStateAction<TestingView[K]>>) {
    return (value: React.SetStateAction<TestingView[K]>) => {
      if (!botTab || !botView) return own(value);
      const next = typeof value === "function" ? (value as (previous: TestingView[K]) => TestingView[K])(botView[key]) : value;
      testingStore.setView(botTab.id, { [key]: next } as Partial<TestingView>);
    };
  }
  const setPresetId = routed("presetId", setOwnPresetId);
  const setRotated = routed("rotated", setOwnRotated);
  const setZoom = routed("zoom", setOwnZoom);
  const setCustomSize = routed("customSize", setOwnCustomSize);
  // Bot tabs are always shown as a single page, whatever the user's layout mode.
  const viewDevice = botTab ? isDeviceSource(botTab.source) : deviceSource;
  const viewMode = botTab ? "single" : mode;
  const [autoRefresh, setAutoRefresh] = useState(initial.autoRefresh);
  const [selectedSizeIds, setSelectedSizeIds] = useState<string[]>(initial.selectedSizeIds);
  const [rotatedById, setRotatedById] = useState<Record<string, boolean>>(initial.rotatedById);
  const [canvasTransform, setCanvasTransform] = useState<CanvasViewTransform | null>(
    initial.canvasTransform,
  );
  const [scrollSync, setScrollSync] = useState(initial.scrollSync);

  const [urlError, setUrlError] = useState("");
  const [pendingLocalUrl, setPendingLocalUrl] = useState<string | null>(null);
  const [ownFrameStatus, setFrameStatus] = useState<PreviewFrameStatus>("empty");
  const [ownHistoryNav, setHistoryNav] = useState({ canGoBack: false, canGoForward: false });
  const frameStatus: PreviewFrameStatus = botTab ? botMeta?.status ?? "loading" : ownFrameStatus;
  const historyNav = botTab ? { canGoBack: Boolean(botMeta?.canGoBack), canGoForward: Boolean(botMeta?.canGoForward) } : ownHistoryNav;
  const [historyList, setHistoryList] = useState<string[]>(() => getMobilePreviewUrlHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const filePickerTriggerRef = useRef<HTMLElement | null>(null);
  const shareTriggerRef = useRef<HTMLElement | null>(null);

  const openFilePicker = (trigger?: HTMLElement | null) => {
    filePickerTriggerRef.current =
      trigger || (typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
    setFilePickerOpen(true);
  };

  const openShareModal = (trigger?: HTMLElement | null) => {
    shareTriggerRef.current =
      trigger || (typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
    setShareModalOpen(true);
  };
  const [shareDefaultScope, setShareDefaultScope] = useState<"current" | "all">("current");
  const [shareOverrideArtboard, setShareOverrideArtboard] = useState<CanvasArtboardBox | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [stageBounds, setStageBounds] = useState({ width: 960, height: 720 });

  const singleFrameRef = useRef<PreviewFrameHandle | null>(null);
  const canvasFrameRefs = useRef<Map<string, PreviewFrameHandle>>(new Map());
  const singleStageRef = useRef<HTMLDivElement | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);

  usePreviewAutoRefreshWatcher("preview-studio-screen", activeSource, autoRefresh);

  // The user's own page.
  const ownPreset = useMemo(() => resolvePreviewSize(ownPresetId, ownCustomSize), [ownCustomSize, ownPresetId]);
  const ownResponsive = ownPreset.id === RESPONSIVE_PREVIEW_SIZE_ID;
  const ownDims = useMemo(
    () =>
      ownResponsive
        // The stage has 24px padding on each side.
        ? { width: Math.max(240, Math.floor(stageBounds.width - 48)), height: Math.max(200, Math.floor(stageBounds.height - 48)) }
        : applyRotation(ownPreset, ownPreset.rotatable ? ownRotated : false),
    [ownPreset, ownResponsive, ownRotated, stageBounds],
  );
  const ownScale = useMemo(
    () => (ownResponsive ? 1 : computeFrameScale(ownDims, stageBounds, ownZoom, 28)),
    [ownDims, ownResponsive, ownZoom, stageBounds],
  );

  // What the toolbar shows: the bot's tab when one is open, otherwise the user's page.
  const [botStage, setBotStage] = useState<HTMLDivElement | null>(null);
  const [botBounds, setBotBounds] = useState({ width: 960, height: 720 });
  const activePreset = useMemo(() => resolvePreviewSize(presetId, customSize), [customSize, presetId]);
  const viewResponsive = activePreset.id === RESPONSIVE_PREVIEW_SIZE_ID;
  const botDims = useMemo(
    () =>
      viewResponsive
        ? { width: Math.max(240, Math.floor(botBounds.width)), height: Math.max(200, Math.floor(botBounds.height)) }
        : applyRotation(activePreset, activePreset.rotatable ? rotated : false),
    [activePreset, botBounds, rotated, viewResponsive],
  );
  const botScale = useMemo(
    () => (viewResponsive ? 1 : computeFrameScale(botDims, botBounds, zoom, 16)),
    [botBounds, botDims, viewResponsive, zoom],
  );
  const singleDims = botTab ? botDims : ownDims;
  const singleScale = botTab ? botScale : ownScale;

  // Measure Single mode stage bounds
  useEffect(() => {
    const el = singleStageRef.current;
    if (!el || (deviceSource && mode !== "single")) return;
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
  }, [mode, deviceSource]);

  // Persist Preview Studio state & keep quick preview state in sync
  useEffect(() => {
    savePreviewStudioState({
      input: inputUrl,
      source: activeSource,
      presetId: ownPresetId,
      rotated: ownRotated,
      zoom: ownZoom,
      customSize: ownCustomSize,
      autoRefresh,
      mode,
      selectedSizeIds,
      rotatedById,
      canvasTransform,
      scrollSync,
    });
    saveMobilePreviewState({
      input: inputUrl,
      presetId: ownPresetId,
      rotated: ownRotated,
      zoom: ownZoom,
      customSize: ownCustomSize,
      source: activeSource,
    });
  }, [
    activeSource,
    autoRefresh,
    canvasTransform,
    ownCustomSize,
    inputUrl,
    mode,
    ownPresetId,
    ownRotated,
    rotatedById,
    scrollSync,
    selectedSizeIds,
    ownZoom,
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

  // Escape handling on Preview page: closes dropdown/confirm first, otherwise returns to chat
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (filePickerOpen || shareModalOpen) return;
      e.preventDefault();
      if (historyOpen) {
        setHistoryOpen(false);
        return;
      }
      if (pendingLocalUrl) {
        setPendingLocalUrl(null);
        return;
      }
      dispatch({ type: "togglePreview", open: false });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, filePickerOpen, historyOpen, pendingLocalUrl, shareModalOpen]);

  // Single-mode keyboard shortcuts: [ and ] cycle sizes, R rotates
  useEffect(() => {
    if (!viewDevice || viewMode !== "single") return;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreset.id, activePreset.rotatable, viewMode, viewDevice, botTab?.id]);

  // Full-screen Preview hosts bot tests while it is open (no chat's Quick Preview is mounted).
  useEffect(() => testingStore.addHost(), []);
  useEffect(() => {
    const onShow = (event: Event) => { (event as CustomEvent<ShowTestingDetail>).detail.handled = true; };
    window.addEventListener(SHOW_TESTING_EVENT, onShow);
    return () => window.removeEventListener(SHOW_TESTING_EVENT, onShow);
  }, []);
  // Bot pages render in PreviewTestingLayer over this stage.
  useEffect(() => {
    if (!botStage) return;
    testingStore.setSlot(botStage);
    const measure = () => {
      const rect = botStage.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setBotBounds({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(botStage);
    return () => {
      observer?.disconnect();
      if (testingStore.state().slot === botStage) testingStore.setSlot(null);
    };
  }, [botStage]);
  const overlayOpen = historyOpen || filePickerOpen || shareModalOpen;
  useEffect(() => {
    if (!botTab) return;
    testingStore.setLayout(botTab.id, {
      width: botDims.width,
      height: botDims.height,
      scale: botScale,
      fill: viewResponsive,
      padded: !viewResponsive,
      bezel: activePreset.group === "phone" || activePreset.group === "tablet",
      interactive: !overlayOpen,
      dims: botView?.dims ?? "",
    });
  }, [activePreset.group, botDims.height, botDims.width, botScale, botTab, botView?.dims, overlayOpen, viewResponsive]);

  // A bot asked to act on the page the user is viewing: hand it this screen's single-page frame.
  const attachTried = useRef(new Set<string>());
  const attachDims = useRef<string | null>(null);
  useEffect(() => {
    const api = window.gbs?.previewTesting;
    const pending = testing.sessions.find((s) => s.target === "active" && s.state === "opening" && !attachTried.current.has(s.id));
    if (!api || !pending) return;
    if (testing.tab !== null) { testingStore.setTab(null); return; }
    if (activeSource?.kind !== "url" || mode !== "single") {
      attachTried.current.add(pending.id);
      void api.register({ sessionId: pending.id, unavailable: activeSource?.kind !== "url" ? "Preview is not showing a web page. Bots can attach to web pages only; use target \"new\"." : "Preview is in Canvas layout. Ask the user to switch to Single, or use target \"new\"." });
      return;
    }
    if (ownFrameStatus === "loading" || ownFrameStatus === "empty") return;
    const webContentsId = singleFrameRef.current?.webContentsId();
    if (webContentsId == null) return;
    attachTried.current.add(pending.id);
    attachDims.current = `${ownDims.width}x${ownDims.height}x${ownResponsive}`;
    void api.register({ sessionId: pending.id, webContentsId, viewport: { width: ownDims.width, height: ownDims.height, responsive: ownResponsive } })
      .catch((error: Error) => testingStore.setError(error.message));
  }, [activeSource, mode, ownDims.height, ownDims.width, ownFrameStatus, ownResponsive, testing.sessions, testing.tab]);
  // The bot resized the user's page: show that size in the user's own controls.
  useEffect(() => {
    if (!attached) return;
    const dims = `${attached.width}x${attached.height}x${attached.responsive}`;
    if (attachDims.current === dims) return;
    attachDims.current = dims;
    const view = viewFromSession(attached, ownZoom);
    setOwnPresetId(view.presetId);
    setOwnRotated(view.rotated);
    if (view.presetId === "custom") setOwnCustomSize(view.customSize);
  }, [attached, ownZoom]);

  // The page the toolbar acts on: the bot's tab or the user's own frame.
  const viewFrame = () => (botTab ? testingStore.frame(botTab.id) : singleFrameRef.current);
  /** Any user navigation on a bot-controlled page is a takeover, so the bot cannot act on a page it did not expect. */
  const takeControl = () => {
    if (controlSession && controlSession.state !== "paused") void testingStore.control(controlSession.id, "pause");
  };
  const [botInput, setBotInput] = useState<string | null>(null);
  useEffect(() => setBotInput(null), [botTab?.id, botTab?.url]);
  // Keep the address bar truthful while a bot moves the user's own page.
  useEffect(() => {
    if (attached?.url && attached.url !== "about:blank") setInputUrl(attached.url);
  }, [attached?.url]);
  const reloadView = () => {
    takeControl();
    if (botTab?.source.kind === "file") testingStore.frame(botTab.id)?.loadURL(botTab.url);
    else viewFrame()?.reload();
  };

  const commitUrl = useCallback((url: string) => {
    testingStore.setTab(null);
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
      const target = rawInput !== undefined ? rawInput : botTab ? botInput ?? botTab.url : inputUrl;
      setHistoryOpen(false);
      const check = validatePreviewUrl(target);
      if (!check.valid) {
        setUrlError(check.error || "Invalid web address");
        return;
      }
      setUrlError("");
      // Navigate controlled pages in place; remounting would end the bot's session.
      if (botTab || (attached && !testing.tab)) {
        takeControl();
        if (viewFrame()?.loadURL(check.url)) {
          setBotInput(null);
          if (!botTab) setInputUrl(check.url);
          setHistoryList(addMobilePreviewUrlToHistory(check.url));
          return;
        }
      }
      if (check.isLocalOrPrivate && (activeSource?.kind !== "url" || activeSource.url !== check.url)) {
        setPendingLocalUrl(check.url);
        return;
      }
      commitUrl(check.url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSource, attached, botInput, botTab, commitUrl, inputUrl, testing.tab],
  );

  const handleSelectProjectFile = useCallback((fileSource: PreviewFileSource) => {
    testingStore.setTab(null);
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

      const linkOnly = sharesLinkOnly(activeSource, Boolean(window.gbs));
      if (linkOnly) {
        // Browser frames cannot supply a faithful page screenshot.
      } else if (!deviceSource) {
        const handle = singleFrameRef.current;
        if (!handle) throw new Error("Open the file viewer before sharing it.");
        attachments.push(await handle.captureScreenshot(request.area, { title: "Full-screen file", width: stageBounds.width, height: stageBounds.height }));
      } else if (shareOverrideArtboard) {
        const handle = canvasFrameRefs.current.get(shareOverrideArtboard.id);
        if (!handle) throw new Error("This preview is not ready to capture. Reload it and try again.");
        attachments.push(await handle.captureScreenshot(request.area, {
          title: shareOverrideArtboard.preset.label,
          width: shareOverrideArtboard.width,
          height: shareOverrideArtboard.height,
        }));
      } else if (request.scope === "current" || mode === "single") {
        const handle =
          mode === "single"
            ? singleFrameRef.current
            : canvasFrameRefs.current.get(activePreset.id) ??
              canvasFrameRefs.current.values().next().value;
        if (!handle) throw new Error("This preview is not ready to capture. Reload it and try again.");
        attachments.push(await handle.captureScreenshot(request.area, {
          title: activePreset.label,
          width: singleDims.width,
          height: singleDims.height,
        }));
      } else {
        for (const id of selectedSizeIds) {
          const preset = resolvePreviewSize(id, customSize);
          const dims = applyRotation(preset, Boolean(rotatedById[id]));
          const handle = canvasFrameRefs.current.get(id) ?? singleFrameRef.current;
          if (!handle) throw new Error(`The ${preset.label} preview is not ready to capture. Reload it and try again.`);
          attachments.push(await handle.captureScreenshot(request.area, {
            title: preset.label,
            width: dims.width,
            height: dims.height,
          }));
        }
      }

      const sourceDesc = linkOnly ? previewShareLink(activeSource, window.location.origin) : describePreviewSource(activeSource);
      const defaultCaption =
        attachments.length > 1
          ? `Shared ${attachments.length} preview sizes for ${sourceDesc}`
          : deviceSource ? `Preview (${shareOverrideArtboard?.preset.label ?? activePreset.label}): ${sourceDesc}` : `Preview: ${sourceDesc}`;
      const caption = linkOnly ? `${defaultCaption}\nShared as a link; no screenshot was captured.` : defaultCaption;
      const text = request.note ? `${request.note}\n\n${caption}` : caption;

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
      deviceSource,
      stageBounds.width,
      stageBounds.height,
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

  const modalSizeLabel = deviceSource ? shareOverrideArtboard?.preset.label ?? activePreset.label : "Full-screen file";
  const modalDimensionsLabel = !deviceSource ? "Viewer" : shareOverrideArtboard
    ? `${shareOverrideArtboard.width} × ${shareOverrideArtboard.height}`
    : `${singleDims.width} × ${singleDims.height}`;

  const statusPill = activeSource && frameStatus !== "empty" && (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-inset px-2.5 py-0.5 text-[11px] font-medium text-ink-secondary"
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
  );

  return (
    <main
      aria-label="Preview Studio"
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink"
    >
      {/* Top Bar Row 1: Source Bar & Mode Switch */}
      <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-hairline/60 bg-panel px-4 py-3">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => dispatch({ type: "togglePreview", open: false })}
            aria-label="Back to chat"
            title="Back to chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline/60 bg-inset text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
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
              onClick={(e) => {
                setSourceKindTab("file");
                openFilePicker(e.currentTarget);
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
        <div className="order-3 flex w-full min-w-0 items-center gap-1.5">
          <div className="relative flex min-w-0 flex-1 items-center" ref={historyDropdownRef}>
            <input
              type="text"
              value={botTab ? botInput ?? botTab.url : inputUrl}
              onChange={(e) => {
                if (botTab) setBotInput(e.target.value);
                else setInputUrl(e.target.value);
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
              className="h-8 w-full rounded-lg border border-hairline/70 bg-inset pl-3 pr-8 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none"
            />
            {historyList.length > 0 && (
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                aria-label="Recent preview addresses"
                title="Recent addresses"
                className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <History className="h-3.5 w-3.5" />
              </button>
            )}

            {historyOpen && historyList.length > 0 && (
              <div
                role="listbox"
                aria-label="Recent preview addresses"
                className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-hairline bg-panel shadow-xl"
              >
                <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-1.5">
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
                <div className="max-h-52 overflow-y-auto py-1">
                  {historyList.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        setInputUrl(item);
                        handleNavigate(item);
                      }}
                      className="block w-full truncate px-3 py-1.5 text-left font-mono text-[11.5px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
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
            onClick={(e) => openFilePicker(e.currentTarget)}
            aria-label="Choose a file from a project"
            title="Choose a file from a project"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline/70 bg-inset text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
          >
            <FolderOpen className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => handleNavigate()}
            className="h-8 shrink-0 rounded-lg bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:brightness-110"
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
            <span>Auto-refresh</span>
          </button>
        </div>

        {/* Right: Single/Canvas Mode Switch & Share to Chat */}
        <div className="flex items-center gap-2">
          {toast && (
            <span role="status" className="text-[12px] font-medium text-accent">
              {toast}
            </span>
          )}

          {deviceSource && !botTab && <div
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
          </div>}

          <button
            type="button"
            disabled={!activeSource || Boolean(botTab)}
            title={botTab ? "Switch to Your page to share it" : undefined}
            onClick={(e) => {
              setShareOverrideArtboard(null);
              setShareDefaultScope(deviceSource && mode === "canvas" && selectedSizeIds.length > 1 ? "all" : "current");
              openShareModal(e.currentTarget);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-white transition-colors hover:brightness-110 disabled:opacity-45"
          >
            <Camera className="h-3.5 w-3.5" />
            Share to chat…
          </button>
        </div>
      </header>

      {/* Top Bar Row 2: Size Bar & Viewport Controls */}
      {viewDevice && <div className="flex min-h-[40px] flex-wrap items-center justify-between gap-2 border-b border-hairline/60 bg-raised/50 px-4 py-1.5">
        {viewMode === "single" ? (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <div className="mr-1 flex items-center gap-0.5 border-r border-hairline/50 pr-2">
                {window.gbs ? (
                  <>
                    <button
                      type="button"
                      onClick={() => { takeControl(); viewFrame()?.goBack(); }}
                      disabled={!historyNav.canGoBack}
                      aria-label="Back"
                      title="Back"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { takeControl(); viewFrame()?.goForward(); }}
                      disabled={!historyNav.canGoForward}
                      aria-label="Forward"
                      title="Forward"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35"
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
                  onClick={reloadView}
                  disabled={!activeSource && !botTab}
                  aria-label="Reload preview"
                  title="Reload preview"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35"
                >
                  <RotateCw
                    className={`h-3.5 w-3.5 ${frameStatus === "loading" ? "animate-spin" : ""}`}
                  />
                </button>
              </div>

              <button
                type="button"
                onClick={() => setPresetId(RESPONSIVE_PREVIEW_SIZE_ID)}
                title="Fill the preview area"
                className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] transition-colors ${
                  viewResponsive
                    ? "border-accent/40 bg-accent/15 font-medium text-ink"
                    : "border-transparent text-ink-secondary hover:bg-raised-hover hover:text-ink"
                }`}
              >
                Responsive
              </button>
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
                        : "border-transparent text-ink-secondary hover:bg-raised-hover hover:text-ink"
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className="font-mono text-[10px] text-ink-secondary">
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
                    : "border-transparent text-ink-secondary hover:bg-raised-hover hover:text-ink"
                }`}
              >
                <span>Custom</span>
                <span className="font-mono text-[10px] text-ink-secondary">
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
                    className="h-7 w-18 rounded border border-hairline/70 bg-inset px-2 font-mono text-[11px] text-ink"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {statusPill}

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
                    <span className="font-mono text-[10px] text-ink-secondary">
                      {item.width}×{item.height}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              {statusPill}

              <button
                type="button"
                onClick={() => setSelectedSizeIds([...DEFAULT_CANVAS_SIZE_IDS])}
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
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
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                All phones
              </button>
              <button
                type="button"
                onClick={() => setSelectedSizeIds(PREVIEW_SIZE_PRESETS.map((p) => p.id))}
                className="h-7 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                All sizes
              </button>
              <button
                type="button"
                onClick={reloadAllCanvasFrames}
                disabled={!activeSource}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-hairline/60 bg-inset px-2.5 text-[11px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-40"
              >
                <RotateCw className="h-3 w-3" />
                Reload all
              </button>
            </div>
          </>
        )}
      </div>

      }

      <PreviewBotBar botTabs={botTabs} botTab={botTab} attached={attached} controlSession={controlSession} error={testing.error} className="px-4" />

      {/* Inline URL validation error banner */}
      {urlError && (
        <div
          role="alert"
          className="border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-[12px] text-danger"
        >
          {urlError}
        </div>
      )}

      {/* Main Stage: Single Mode or Canvas Mode. A bot tab covers it; the user's page stays loaded underneath. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {!deviceSource || mode === "single" ? (
        <div
          ref={singleStageRef}
          className={`relative flex min-h-0 flex-1 items-start justify-center bg-inset/50 ${deviceSource ? "overflow-auto p-6" : "overflow-hidden"}`}
        >
          <PreviewFrame
            ref={singleFrameRef}
            source={activeSource}
            width={ownDims.width}
            height={ownDims.height}
            scale={ownScale}
            fill={ownResponsive}
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
            frameTitle={ownPreset.label}
            showDeviceBezel={ownPreset.group === "phone" || ownPreset.group === "tablet"}
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
            openShareModal();
          }}
          onStatusChange={setFrameStatus}
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
          scrollSync={scrollSync}
          onToggleScrollSync={() => setScrollSync((v) => !v)}
          frameRefsMap={canvasFrameRefs}
        />
      )}
      {botTab && <div ref={setBotStage} data-panel="preview-bot-stage" className="absolute inset-0 bg-app" />}
      </div>

      <PreviewFilePicker
        open={filePickerOpen}
        triggerRef={filePickerTriggerRef}
        onClose={() => setFilePickerOpen(false)}
        onSelectFile={handleSelectProjectFile}
        initialProjectId={activeSource?.kind === "file" ? activeSource.projectId : undefined}
      />

      <SharePreviewModal
        open={shareModalOpen}
        triggerRef={shareTriggerRef}
        fileViewer={!deviceSource}
        linkOnly={sharesLinkOnly(activeSource, Boolean(window.gbs))}
        onClose={() => {
          setShareModalOpen(false);
          setShareOverrideArtboard(null);
        }}
        currentSizeLabel={modalSizeLabel}
        currentDimensionsLabel={modalDimensionsLabel}
        selectedSizesCount={deviceSource && mode === "canvas" ? selectedSizeIds.length : 1}
        defaultScope={deviceSource ? shareDefaultScope : "current"}
        onSubmit={handleShareSubmit}
      />
    </main>
  );
}
