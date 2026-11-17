import { PAGE_SHARE_NOTICE, previewShareLink, sharesLinkOnly } from "@/lib/previewSharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Bot,
  Camera,
  ChevronDown,
  ExternalLink,
  FileImage,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  History,
  Laptop,
  Maximize2,
  Monitor,
  MonitorSmartphone,
  Play,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
  Square,
  Tablet,
  Trash2,
  X,
} from "lucide-react";
import {
  applyRotation,
  clampCustomDimension,
  computeFrameScale,
  PREVIEW_SIZE_GROUPS,
  RESPONSIVE_PREVIEW_SIZE_ID,
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
import { DocumentChromeContext } from "@/components/DocumentView";
import { OPEN_PREVIEW_EVENT, type OpenPreviewDetail } from "@/lib/chatLinks";
import { PreviewFilePicker, usePreviewAutoRefreshWatcher } from "@/components/PreviewFilePicker";
import { PreviewMoreMenu } from "@/components/PreviewMoreMenu";
import { usePanelResize } from "@/lib/usePanelResize";
import { ResizeHandle } from "./ResizeHandle";
import { cn } from "@/lib/cn";
import { SHARED_HEADER_HEIGHT_CLASS } from "@/lib/layoutTokens";
import { isDeviceSource as isWebPreviewSource } from "@/lib/previewSource";
import { useStore, type Attachment } from "@/state/store";
import { testingStore, useTestingState, viewFromSession, type TestingView } from "@/lib/previewTestingStore";

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
    case "responsive":
      return MonitorSmartphone;
    case "phone":
    default:
      return Smartphone;
  }
}

function shortDeviceLabel(preset: PreviewSizePreset): string {
  if (preset.id === "custom") return "Custom";
  if (preset.id === RESPONSIVE_PREVIEW_SIZE_ID) return "Responsive";
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
  style?: React.CSSProperties;
  docked?: boolean;
  /** Hosts bot testing tabs. The app-level fallback panel sets this to false. */
  testingHost?: boolean;
}

export function MobilePreviewPanel({
  open = true,
  onClose,
  onScreenshot,
  onSendScreenshotToChat,
  className,
  style,
  docked = true,
  testingHost = true,
}: MobilePreviewPanelProps) {
  const { state, dispatch } = useStore();
  const initial = useMemo(() => loadMobilePreviewState(), []);

  const { width: previewWidth, handleProps: previewHandleProps } = usePanelResize({
    id: "preview",
    defaultWidth: () => (typeof window !== "undefined" && window.innerWidth >= 1536 ? 420 : 380),
    minWidth: 320,
    maxWidth: () => (typeof window !== "undefined" ? Math.floor(window.innerWidth * 0.6) : 864),
    edge: "left",
    label: "Resize quick preview panel",
    docked,
  });

  const [inputUrl, setInputUrl] = useState(initial.input);
  const [ownSource, setActiveSource] = useState<PreviewSource | null>(() => {
    if (initial.source) return initial.source;
    if (initial.input) {
      const check = validatePreviewUrl(initial.input);
      if (check.valid && !check.isLocalOrPrivate) {
        return { kind: "url", url: check.url, raw: initial.input, isLocalOrPrivate: false };
      }
    }
    return null;
  });
  const [ownPresetId, setOwnPresetId] = useState(initial.presetId);
  const [ownRotated, setOwnRotated] = useState(Boolean(initial.rotated));
  const [ownZoom, setOwnZoom] = useState<PreviewZoomMode>(initial.zoom ?? "fit");
  const [ownCustomSize, setOwnCustomSize] = useState(
    initial.customSize ?? { width: 1024, height: 768 },
  );

  // Bot testing: a bot tab replaces the page and size controls below with the bot's.
  const testing = useTestingState();
  const botTab = testing.tab ? testing.sessions.find((s) => s.id === testing.tab && s.target !== "active") ?? null : null;
  const attached = testing.sessions.find((s) => s.target === "active" && (s.state === "ready" || s.state === "paused")) ?? null;
  const controlSession = botTab ?? (testing.tab === null ? attached : null);
  const botTabs = testing.sessions.filter((s) => s.target !== "active");
  const botView = botTab ? testing.views[botTab.id] : undefined;
  const activeSource = botTab ? botTab.source : ownSource;
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

  const [urlError, setUrlError] = useState("");
  const [pendingLocalUrl, setPendingLocalUrl] = useState<string | null>(null);
  const [ownFrameStatus, setFrameStatus] = useState<PreviewFrameStatus>("empty");
  const [ownHistoryNav, setHistoryNav] = useState({ canGoBack: false, canGoForward: false });
  const botMeta = botTab ? testing.meta[botTab.id] : undefined;
  const frameStatus: PreviewFrameStatus = botTab ? botMeta?.status ?? "loading" : ownFrameStatus;
  const historyNav = botTab ? { canGoBack: Boolean(botMeta?.canGoBack), canGoForward: Boolean(botMeta?.canGoForward) } : ownHistoryNav;
  const [historyList, setHistoryList] = useState<string[]>(() => getMobilePreviewUrlHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [screenshotMenuOpen, setScreenshotMenuOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const filePickerTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!sizeMenuOpen) return;
    const rafId = requestAnimationFrame(() => {
      if (!sizeMenuRef.current) return;
      const selectedItem =
        sizeMenuRef.current.querySelector<HTMLButtonElement>(
          '[role="menuitem"][aria-selected="true"]',
        ) ||
        sizeMenuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]');
      selectedItem?.focus();
      selectedItem?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(rafId);
  }, [sizeMenuOpen]);

  const [sizeCoords, setSizeCoords] = useState<{ top: number; right: number } | null>(null);
  const [historyCoords, setHistoryCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const [screenshotCoords, setScreenshotCoords] = useState<{ top: number; right: number } | null>(null);

  const sizeButtonRef = useRef<HTMLButtonElement | null>(null);
  const sizeMenuRef = useRef<HTMLDivElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyMenuRef = useRef<HTMLDivElement | null>(null);
  const screenshotButtonRef = useRef<HTMLButtonElement | null>(null);
  const screenshotMenuRef = useRef<HTMLDivElement | null>(null);

  const updateSizePosition = useCallback(() => {
    if (!sizeButtonRef.current) return;
    const rect = sizeButtonRef.current.getBoundingClientRect();
    setSizeCoords({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  const updateHistoryPosition = useCallback(() => {
    if (!historyDropdownRef.current) return;
    const rect = historyDropdownRef.current.getBoundingClientRect();
    setHistoryCoords({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(220, rect.width),
    });
  }, []);

  const updateScreenshotPosition = useCallback(() => {
    if (!screenshotButtonRef.current) return;
    const rect = screenshotButtonRef.current.getBoundingClientRect();
    setScreenshotCoords({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

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

  usePreviewAutoRefreshWatcher("quick-preview-panel", ownSource, open);

  const preset = useMemo(() => resolvePreviewSize(presetId, customSize), [customSize, presetId]);

  useEffect(() => {
    if (!preset.rotatable && rotated) {
      setRotated(false);
    }
  }, [preset.rotatable, rotated]);

  const responsive = preset.id === RESPONSIVE_PREVIEW_SIZE_ID;
  const effectiveDims = useMemo(
    () =>
      responsive
        ? { width: Math.max(1, Math.floor(stageBounds.width)), height: Math.max(1, Math.floor(stageBounds.height)) }
        : applyRotation(preset, preset.rotatable ? rotated : false),
    [preset, responsive, rotated, stageBounds],
  );

  const scale = useMemo(
    () => (responsive ? 1 : computeFrameScale(effectiveDims, stageBounds, zoom, 16)),
    [effectiveDims, responsive, stageBounds, zoom],
  );

  // While a bot tab is shown, the user's hidden page keeps its own size.
  const ownLayout = useRef({ width: effectiveDims.width, height: effectiveDims.height, scale, fill: responsive, bezel: preset.group === "phone" || preset.group === "tablet", label: preset.label });
  if (!botTab) ownLayout.current = { width: effectiveDims.width, height: effectiveDims.height, scale, fill: responsive, bezel: preset.group === "phone" || preset.group === "tablet", label: preset.label };

  // Bot tabs render in PreviewTestingLayer over this panel's stage.
  useEffect(() => (testingHost ? testingStore.addHost() : undefined), [testingHost]);
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    testingStore.setSlot(stage);
    return () => { if (testingStore.state().slot === stage) testingStore.setSlot(null); };
  }, [open]);
  const menuOpen = sizeMenuOpen || moreMenuOpen || historyOpen || screenshotMenuOpen || filePickerOpen;
  useEffect(() => {
    if (!botTab) return;
    testingStore.setLayout(botTab.id, {
      width: effectiveDims.width,
      height: effectiveDims.height,
      scale,
      fill: responsive,
      padded: !responsive,
      bezel: preset.group === "phone" || preset.group === "tablet",
      interactive: !menuOpen,
      dims: botView?.dims ?? "",
    });
  }, [botTab, botView?.dims, effectiveDims.height, effectiveDims.width, menuOpen, preset.group, responsive, scale]);

  // A bot asked to act on the page the user is viewing: hand it this panel's frame.
  const attachTried = useRef(new Set<string>());
  const attachDims = useRef<string | null>(null);
  useEffect(() => {
    const api = window.gbs?.previewTesting;
    const pending = testing.sessions.find((s) => s.target === "active" && s.state === "opening" && !attachTried.current.has(s.id));
    if (!testingHost || !open || !api || !pending) return;
    if (testing.tab !== null) { testingStore.setTab(null); return; }
    if (!ownSource || ownSource.kind !== "url") {
      attachTried.current.add(pending.id);
      void api.register({ sessionId: pending.id, unavailable: ownSource ? "Quick Preview is showing a project file. Bots can attach to web pages only; use target \"new\"." : "No page is open in Quick Preview. Ask the user to open one, or use target \"new\"." });
      return;
    }
    if (ownFrameStatus === "loading" || ownFrameStatus === "empty") return;
    const webContentsId = frameRef.current?.webContentsId();
    if (webContentsId == null) return;
    attachTried.current.add(pending.id);
    attachDims.current = `${effectiveDims.width}x${effectiveDims.height}x${responsive}`;
    void api.register({ sessionId: pending.id, webContentsId, viewport: { width: effectiveDims.width, height: effectiveDims.height, responsive } })
      .catch((error: Error) => testingStore.setError(error.message));
  }, [effectiveDims.height, effectiveDims.width, open, ownFrameStatus, ownSource, responsive, testing.sessions, testing.tab, testingHost]);
  // The bot resized the user's page: show that size in this panel's own controls.
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

  // Links and images clicked in chat messages
  const navigateRef = useRef<(url: string) => void>(() => {});
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenPreviewDetail>).detail;
      if (!detail) return;
      testingStore.setTab(null);
      if ("file" in detail) {
        setActiveSource(detail.file);
        setInputUrl("");
      } else {
        setInputUrl(detail.url);
        navigateRef.current(detail.url);
      }
    };
    window.addEventListener(OPEN_PREVIEW_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PREVIEW_EVENT, onOpen);
  }, []);

  // Persist quick preview state
  useEffect(() => {
    saveMobilePreviewState({
      input: inputUrl,
      presetId: ownPresetId,
      rotated: ownRotated,
      zoom: ownZoom,
      customSize: ownCustomSize,
      source: ownSource,
    });
  }, [ownSource, ownCustomSize, inputUrl, ownPresetId, ownRotated, ownZoom]);

  // An empty panel starts in the web header so the address field is available.
  const isDeviceSource = !activeSource || isWebPreviewSource(activeSource);
  const [docStatusSlot, setDocStatusSlot] = useState<HTMLElement | null>(null);
  const [docControlsSlot, setDocControlsSlot] = useState<HTMLElement | null>(null);
  const documentChrome = useMemo(() => ({ status: docStatusSlot, controls: docControlsSlot }), [docStatusSlot, docControlsSlot]);
  const fileMeta = useMemo(() => {
    const path = activeSource?.kind === "file" ? activeSource.filePath : "";
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop() ?? "";
    const project = activeSource?.kind === "file" ? activeSource.projectName : undefined;
    const folder = [project, ...parts].filter(Boolean).join(" / ") || "Project root";
    const type = activeSource?.kind === "file" ? activeSource.fileType : undefined;
    return type === "image"
      ? { name, folder, Icon: FileImage, tone: "text-emerald-400" }
      : type === "pdf"
        ? { name, folder, Icon: FileText, tone: "text-rose-400" }
        : type === "markdown"
          ? { name, folder, Icon: FileText, tone: "text-violet-400" }
          : { name, folder, Icon: FileText, tone: "text-ink-secondary" };
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
    if (!historyOpen && !sizeMenuOpen && !screenshotMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        historyOpen &&
        historyDropdownRef.current &&
        !historyDropdownRef.current.contains(target) &&
        historyMenuRef.current &&
        !historyMenuRef.current.contains(target)
      ) {
        setHistoryOpen(false);
      }
      if (
        sizeMenuOpen &&
        sizeButtonRef.current &&
        !sizeButtonRef.current.contains(target) &&
        sizeMenuRef.current &&
        !sizeMenuRef.current.contains(target)
      ) {
        setSizeMenuOpen(false);
      }
      if (
        screenshotMenuOpen &&
        screenshotButtonRef.current &&
        !screenshotButtonRef.current.contains(target) &&
        screenshotMenuRef.current &&
        !screenshotMenuRef.current.contains(target)
      ) {
        setScreenshotMenuOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (historyOpen) {
          setHistoryOpen(false);
          historyButtonRef.current?.focus();
        }
        if (sizeMenuOpen) {
          setSizeMenuOpen(false);
          sizeButtonRef.current?.focus();
        }
        if (screenshotMenuOpen) {
          setScreenshotMenuOpen(false);
          screenshotButtonRef.current?.focus();
        }
        return;
      }

      if (sizeMenuOpen && sizeMenuRef.current) {
        const menuItems = Array.from(
          sizeMenuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'),
        );
        if (menuItems.length > 0) {
          const activeIdx = menuItems.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === "ArrowDown") {
            e.preventDefault();
            const nextIdx = (activeIdx + 1) % menuItems.length;
            menuItems[nextIdx]?.focus();
            menuItems[nextIdx]?.scrollIntoView({ block: "nearest" });
            return;
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const prevIdx = (activeIdx - 1 + menuItems.length) % menuItems.length;
            menuItems[prevIdx]?.focus();
            menuItems[prevIdx]?.scrollIntoView({ block: "nearest" });
            return;
          }
        }
      }
    };

    const handleBlur = () => {
      if (historyOpen) setHistoryOpen(false);
      if (sizeMenuOpen) setSizeMenuOpen(false);
      if (screenshotMenuOpen) setScreenshotMenuOpen(false);
    };

    const handleScrollOrResize = () => {
      if (sizeMenuOpen) updateSizePosition();
      if (historyOpen) updateHistoryPosition();
      if (screenshotMenuOpen) updateScreenshotPosition();
    };

    document.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("blur", handleBlur);
    };
  }, [historyOpen, screenshotMenuOpen, sizeMenuOpen, updateHistoryPosition, updateScreenshotPosition, updateSizePosition]);

  // The page the toolbar acts on: the bot's tab or the user's own frame.
  const viewFrame = () => (botTab ? testingStore.frame(botTab.id) : frameRef.current);
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
  navigateRef.current = handleNavigate;

  const handleSelectProjectFile = useCallback((fileSource: PreviewFileSource) => {
    testingStore.setTab(null);
    setPendingLocalUrl(null);
    setUrlError("");
    setActiveSource(fileSource);
    setInputUrl(describePreviewSource(fileSource));
  }, []);

  const handleCaptureScreenshot = useCallback(
    async (mode: "visible" | "full") => {
      setScreenshotMenuOpen(false);
      const frame = viewFrame();
      if (!activeSource || !frame || capturing) return;
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
        const attachment = await frame.captureScreenshot(mode, {
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
      botTab,
    ],
  );

  const handleOpenInPreviewPage = useCallback(() => {
    savePreviewStudioState({
      input: botTab ? botTab.url : inputUrl,
      source: activeSource,
      presetId,
      rotated,
      zoom,
      customSize,
    });
    dispatch({ type: "togglePreview", open: true });
  }, [activeSource, botTab, customSize, dispatch, inputUrl, presetId, rotated, zoom]);

  if (!open) return null;

  const canCaptureScreenshot = Boolean(onScreenshot || onSendScreenshotToChat);
  const DeviceIcon = getDeviceGroupIcon(preset.group);

  return (
    <aside
      data-panel="preview"
      data-docked={docked}
      aria-label="Quick preview panel"
      className={cn(
        "relative flex h-full shrink-0 select-none flex-col border-l border-hairline/60 bg-panel max-w-full",
        className,
      )}
      style={{ width: `${previewWidth}px`, ...style }}
    >
      <ResizeHandle {...previewHandleProps} />
      {/* Redesigned Single Header (h-[60px] aligned with Chat & Tasks headers) */}
      <header className={cn("flex shrink-0 items-center justify-between gap-1 border-b border-hairline/40 bg-panel px-2 min-w-0 max-w-full overflow-hidden", SHARED_HEADER_HEIGHT_CLASS)}>
        {isDeviceSource ? (
          /* State A: Web / HTML document preview */
          <>
            {/* Title */}
            <div className="flex items-center gap-1 shrink-0 text-ink" title="Quick preview">
              <Smartphone size={15} className="text-accent shrink-0" />
              <span className="text-[13px] font-semibold text-ink">Preview</span>
            </div>

            {/* Compact Address Field */}
            <div
              className="relative flex min-w-0 flex-1 items-center rounded-lg border border-hairline/60 bg-inset h-8 px-1 focus-within:border-accent/60 transition-colors overflow-hidden"
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
                aria-label="Web address or project file"
                placeholder="http://localhost:3000 or file"
                className="h-full min-w-0 flex-1 bg-transparent px-1 font-mono text-[11px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
              />

              {historyList.length > 0 && (
                <button
                  ref={historyButtonRef}
                  type="button"
                  onClick={() => {
                    if (!historyOpen) updateHistoryPosition();
                    setHistoryOpen((v) => !v);
                  }}
                  aria-label="Recent preview addresses"
                  title="Recent addresses"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
                >
                  <History className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Primary Controls */}
            <div className="flex items-center gap-0.5 shrink-0 ml-auto">
              {/* Reload */}
              <button
                type="button"
                onClick={reloadView}
                disabled={!activeSource}
                aria-label="Reload preview"
                title="Reload preview"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <RotateCw className={cn("h-3.5 w-3.5", frameStatus === "loading" && "animate-spin")} />
              </button>

              {/* Grouped Size Selector (Icon + Short Label) */}
              <div className="relative shrink-0" ref={sizeDropdownRef}>
                <button
                  ref={sizeButtonRef}
                  type="button"
                  onClick={() => {
                    if (!sizeMenuOpen) updateSizePosition();
                    setSizeMenuOpen((v) => !v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                      if (!sizeMenuOpen) {
                        e.preventDefault();
                        updateSizePosition();
                        setSizeMenuOpen(true);
                      }
                    }
                  }}
                  aria-label="Choose preview size"
                  aria-expanded={sizeMenuOpen}
                  aria-haspopup="menu"
                  title={`${preset.label} (${effectiveDims.width}×${effectiveDims.height})`}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline/60 bg-inset px-1.5 text-[11px] font-medium text-ink transition-colors hover:border-hairline hover:bg-raised-hover"
                >
                  <DeviceIcon className="h-3 w-3 text-ink-secondary shrink-0" />
                  <span className="shrink-0">{shortDeviceLabel(preset)}</span>
                  <ChevronDown className="h-3 w-3 text-ink-secondary shrink-0" />
                </button>
              </div>

              {/* Rotate (secondary control - visible on extra wide 2xl:flex, otherwise folded into More) */}
              <button
                type="button"
                onClick={() => setRotated((v) => !v)}
                disabled={!preset.rotatable}
                aria-label="Rotate preview"
                aria-pressed={rotated}
                title="Rotate (swap width and height)"
                className={cn(
                  "hidden 2xl:flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-35",
                  rotated
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-transparent text-ink-secondary hover:bg-raised-hover hover:text-ink",
                )}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
              </button>

              {/* Overflow Menu (•••) */}
              <PreviewMoreMenu
                activeSource={activeSource}
                capturing={capturing}
                canCaptureScreenshot={canCaptureScreenshot}
                zoom={zoom}
                setZoom={setZoom}
                rotated={rotated}
                setRotated={setRotated}
                isRotatable={Boolean(preset.rotatable)}
                zoomable={!responsive}
                onOpenInPreviewPage={handleOpenInPreviewPage}
                onCaptureScreenshot={handleCaptureScreenshot}
                historyNav={historyNav}
                onGoBack={() => { takeControl(); viewFrame()?.goBack(); }}
                onGoForward={() => { takeControl(); viewFrame()?.goForward(); }}
                onOpenChange={setMoreMenuOpen}
              />

              {/* Close Button */}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close quick preview"
                title="Close preview"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          /* State B: Full-screen file viewer (Markdown, PDF, Image) */
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline/50 bg-inset",
                  fileMeta.tone,
                )}
              >
                <fileMeta.Icon className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <button
                  type="button"
                  onClick={(e) => openFilePicker(e.currentTarget)}
                  aria-label={`Choose another file (current: ${fileMeta.name})`}
                  title={describePreviewSource(activeSource)}
                  className="group -mx-1 flex min-w-0 items-center gap-1 rounded px-1 text-left text-[13px] font-semibold leading-tight text-ink transition-colors hover:bg-raised"
                >
                  <span className="truncate">{fileMeta.name}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-ink-secondary transition-colors group-hover:text-ink" />
                </button>
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-ink-secondary">
                  <span className="min-w-0 truncate" title={fileMeta.folder}>{fileMeta.folder}</span>
                  <span ref={setDocStatusSlot} className="flex shrink-0 items-center gap-1.5 empty:hidden before:h-[3px] before:w-[3px] before:rounded-full before:bg-ink-secondary/60 before:content-['']" />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0 ml-auto">
              <span ref={setDocControlsSlot} className="mr-1 flex items-center empty:hidden" />
              <button
                type="button"
                onClick={() => {
                  setActiveSource(null);
                  setInputUrl("");
                }}
                aria-label="Open a web address instead"
                title="Open a web address"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <Globe className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={reloadView}
                aria-label="Reload file"
                title="Reload file"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <RotateCw className={cn("h-3.5 w-3.5", frameStatus === "loading" && "animate-spin")} />
              </button>

              <button
                type="button"
                onClick={handleOpenExternally}
                aria-label="Open externally in new tab"
                title="Open in new tab"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>

              {canCaptureScreenshot && (
                <div className="relative shrink-0" ref={screenshotDropdownRef}>
                  <button
                    ref={screenshotButtonRef}
                    type="button"
                    onClick={() => {
                      if (!screenshotMenuOpen) updateScreenshotPosition();
                      setScreenshotMenuOpen((v) => !v);
                    }}
                    disabled={!activeSource || capturing}
                    aria-label="Send screenshot to chat"
                    title="Send screenshot to chat"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-35"
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={handleOpenInPreviewPage}
                aria-label="Open in Preview page"
                title="Open in Preview page"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={onClose}
                aria-label="Close quick preview"
                title="Close preview"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </header>

      {(botTabs.length > 0 || attached) && (
        <div role="tablist" aria-label="Preview tabs" className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/40 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            role="tab"
            aria-selected={!botTab}
            onClick={() => testingStore.setTab(null)}
            className={cn("flex max-w-[180px] shrink-0 items-center gap-1.5 truncate rounded-md px-2.5 py-1 text-[11.5px]", !botTab ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised")}
          >
            {attached && <Bot className="h-3 w-3 shrink-0" aria-label={`${attached.botName} is on this page`} />}
            <span className="truncate">Your page</span>
          </button>
          {botTabs.map((s) => (
            <div key={s.id} className={cn("flex max-w-[220px] shrink-0 items-center rounded-md text-[11.5px]", s.id === botTab?.id ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised")}>
              <button type="button" role="tab" aria-selected={s.id === botTab?.id} onClick={() => testingStore.setTab(s.id)} className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1" title={`${s.botName} · ${s.name}`}>
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.state === "paused" ? "bg-ink-secondary" : s.state === "error" ? "bg-danger" : "animate-pulse bg-accent")} />
                <span className="truncate">{s.botName} · {s.name}</span>
              </button>
              <button type="button" aria-label={`End ${s.botName}'s test`} title="End this test" onClick={() => void testingStore.control(s.id, "close")} className="rounded p-1 hover:text-ink">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {controlSession && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline/40 bg-accent/5 px-3 py-1.5 text-[11.5px]">
          {controlSession.state === "paused" ? <Hand className="h-3.5 w-3.5 shrink-0 text-ink-secondary" /> : <Bot className="h-3.5 w-3.5 shrink-0 text-accent" />}
          <span role="status" className="min-w-0 flex-1 truncate text-ink-secondary">
            {controlSession.state === "error"
              ? controlSession.error ?? "This test needs attention"
              : controlSession.state === "paused"
                ? controlSession.canResume
                  ? "You have control"
                  : `Page replaced · ask ${controlSession.botName} to start a new test`
                : <><span className="font-medium text-ink">{controlSession.botName}</span> {botTab ? "is in control" : "is in control of your page"} · {controlSession.activity}</>}
          </span>
          {controlSession.state === "paused"
            ? controlSession.canResume && (
                <button type="button" onClick={() => void testingStore.control(controlSession.id, "resume")} className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] text-white">
                  <Play className="h-3 w-3" />Resume bot
                </button>
              )
            : controlSession.state !== "error" && (
                <button type="button" onClick={() => void testingStore.control(controlSession.id, "pause")} className="flex shrink-0 items-center gap-1 rounded-md border border-hairline/60 bg-raised px-2 py-1 text-[11px] text-ink">
                  <Square className="h-2.5 w-2.5" />Stop / take control
                </button>
              )}
          {!botTab && (
            <button type="button" aria-label={`End ${controlSession.botName}'s test`} title="End this test" onClick={() => void testingStore.control(controlSession.id, "close")} className="shrink-0 rounded p-1 text-ink-secondary hover:text-ink">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {testing.error && (botTab || attached) && (
        <div role="alert" className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11.5px] text-danger">{testing.error}</div>
      )}
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
      <DocumentChromeContext.Provider value={documentChrome}>
      <div
        ref={stageRef}
        className={cn("relative flex flex-1 items-start justify-center overflow-auto", isDeviceSource && !responsive ? "bg-inset/50 p-4" : "bg-panel p-0")}
      >
        {(sizeMenuOpen || moreMenuOpen || historyOpen || screenshotMenuOpen) && (
          <div
            className="absolute inset-0 z-20 cursor-default bg-transparent"
            onMouseDown={(e) => {
              e.preventDefault();
              setSizeMenuOpen(false);
              setMoreMenuOpen(false);
              setHistoryOpen(false);
              setScreenshotMenuOpen(false);
            }}
          />
        )}
        {/* The user's own page stays mounted (hidden) while a bot tab is shown. */}
        <div className="contents" style={{ visibility: botTab ? "hidden" : undefined }} aria-hidden={botTab ? true : undefined}>
        <PreviewFrame
          ref={frameRef}
          source={ownSource}
          width={ownLayout.current.width}
          height={ownLayout.current.height}
          scale={ownLayout.current.scale}
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
          frameTitle={ownLayout.current.label}
          showDeviceBezel={ownLayout.current.bezel}
          fill={ownLayout.current.fill}
        />
        </div>
      </div>
      </DocumentChromeContext.Provider>

      {/* Footer status strip (file viewers only need it for notices and errors) */}
      {(isDeviceSource || toast || frameStatus === "error" || frameStatus === "blocked") && (
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
      )}

      {/* Portaled Size Selector Dropdown */}
      {sizeMenuOpen &&
        sizeCoords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={sizeMenuRef}
            role="menu"
            aria-label="Choose preview size"
            style={{
              position: "fixed",
              top: `${sizeCoords.top}px`,
              right: `${sizeCoords.right}px`,
              zIndex: 60,
            }}
            className="w-64 max-h-[min(360px,calc(100vh-80px))] overflow-y-auto rounded-xl border border-hairline/60 bg-panel p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          >
            <div className="max-h-72 overflow-y-auto">
              <button
                type="button"
                role="menuitem"
                aria-selected={responsive}
                tabIndex={responsive ? 0 : -1}
                onClick={() => {
                  setPresetId(RESPONSIVE_PREVIEW_SIZE_ID);
                  setSizeMenuOpen(false);
                  sizeButtonRef.current?.focus();
                }}
                className={`mb-1.5 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors ${
                  responsive ? "bg-accent/15 font-medium text-ink" : "text-ink-secondary hover:bg-raised-hover hover:text-ink"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <MonitorSmartphone className="h-3.5 w-3.5" />
                  Responsive
                </span>
                <span className="text-[10.5px] text-ink-secondary">Fills panel</span>
              </button>
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
                        role="menuitem"
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        onClick={() => {
                          setPresetId(item.id);
                          setSizeMenuOpen(false);
                          sizeButtonRef.current?.focus();
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
                  role="menuitem"
                  aria-selected={preset.id === "custom"}
                  tabIndex={preset.id === "custom" ? 0 : -1}
                  onClick={() => {
                    setPresetId("custom");
                    sizeButtonRef.current?.focus();
                  }}
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
          </div>,
          document.body,
        )}

      {/* Portaled History Dropdown */}
      {historyOpen &&
        historyList.length > 0 &&
        historyCoords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={historyMenuRef}
            role="listbox"
            aria-label="Recent preview addresses"
            style={{
              position: "fixed",
              top: `${historyCoords.top}px`,
              left: `${historyCoords.left}px`,
              width: `${historyCoords.width}px`,
              zIndex: 60,
            }}
            className="max-h-48 overflow-y-auto rounded-xl border border-hairline/60 bg-panel shadow-2xl animate-in fade-in zoom-in-95 duration-100"
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
                  historyButtonRef.current?.focus();
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
                    setHistoryOpen(false);
                    historyButtonRef.current?.focus();
                  }}
                  className="block w-full truncate px-2.5 py-1.5 text-left font-mono text-[11px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}

      {/* Portaled Screenshot Dropdown in State B */}
      {screenshotMenuOpen &&
        screenshotCoords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={screenshotMenuRef}
            style={{
              position: "fixed",
              top: `${screenshotCoords.top}px`,
              right: `${screenshotCoords.right}px`,
              zIndex: 60,
            }}
            className="w-48 overflow-hidden rounded-xl border border-hairline/60 bg-panel p-1 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          >
            <button
              type="button"
              onClick={() => {
                setScreenshotMenuOpen(false);
                void handleCaptureScreenshot("visible");
                screenshotButtonRef.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink transition-colors hover:bg-raised-hover"
            >
              Send visible area to chat
            </button>
            <button
              type="button"
              onClick={() => {
                setScreenshotMenuOpen(false);
                void handleCaptureScreenshot("full");
                screenshotButtonRef.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] text-ink transition-colors hover:bg-raised-hover"
            >
              Send full page to chat
            </button>
          </div>,
          document.body,
        )}

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
