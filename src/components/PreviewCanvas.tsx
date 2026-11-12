import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  ArrowLeftRight,
  Camera,
  Laptop,
  Link2,
  Maximize2,
  Minus,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import {
  computeCanvasFit,
  computeCanvasZoomAt,
  layoutCanvasArtboards,
  MAX_LIVE_CANVAS_FRAMES,
  resolveLiveArtboardIds,
  type CanvasArtboardBox,
  type CanvasViewTransform,
  type PreviewSizeGroup,
} from "@/lib/previewSizes";
import type { PreviewSource } from "@/lib/mobilePreviewUrl";
import { PreviewFrame, type PreviewFrameHandle } from "@/components/PreviewFrame";

export interface PreviewCanvasProps {
  source: PreviewSource | null;
  selectedSizeIds: string[];
  rotatedById: Record<string, boolean>;
  customSize: { width: number; height: number };
  initialTransform?: CanvasViewTransform | null;
  onTransformChange?: (transform: CanvasViewTransform) => void;
  onToggleRotateArtboard: (sizeId: string) => void;
  onFocusSingleSize: (sizeId: string) => void;
  onShareArtboard: (artboard: CanvasArtboardBox) => void;
  pendingConfirmUrl?: string | null;
  onConfirmLocalUrl?: () => void;
  onCancelLocalUrl?: () => void;
  onQuickPickUrl?: (url: string) => void;
  onOpenFilePicker?: () => void;
  scrollSync: boolean;
  onToggleScrollSync: () => void;
  frameRefsMap?: MutableRefObject<Map<string, PreviewFrameHandle>>;
}

function groupIcon(group: PreviewSizeGroup) {
  switch (group) {
    case "phone":
      return <Smartphone className="h-3.5 w-3.5 text-ink-secondary" />;
    case "tablet":
      return <Tablet className="h-3.5 w-3.5 text-ink-secondary" />;
    case "laptop":
      return <Laptop className="h-3.5 w-3.5 text-ink-secondary" />;
    default:
      return <Monitor className="h-3.5 w-3.5 text-ink-secondary" />;
  }
}

export function PreviewCanvas({
  source,
  selectedSizeIds,
  rotatedById,
  customSize,
  initialTransform,
  onTransformChange,
  onToggleRotateArtboard,
  onFocusSingleSize,
  onShareArtboard,
  pendingConfirmUrl,
  onConfirmLocalUrl,
  onCancelLocalUrl,
  onQuickPickUrl,
  onOpenFilePicker,
  scrollSync,
  onToggleScrollSync,
  frameRefsMap,
}: PreviewCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const localFrameRefs = useRef<Map<string, PreviewFrameHandle>>(new Map());
  const refsMap = frameRefsMap ?? localFrameRefs;

  const { artboards, boardWidth, boardHeight } = useMemo(
    () =>
      layoutCanvasArtboards(selectedSizeIds, {
        rotatedById,
        customSize,
      }),
    [customSize, rotatedById, selectedSizeIds],
  );

  const [view, setView] = useState<CanvasViewTransform>(
    () => initialTransform ?? { x: 48, y: 56, k: 0.45 },
  );
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [promotedIds, setPromotedIds] = useState<string[]>([]);
  const [sharedScroll, setSharedScroll] = useState<{ sourceId: string; ratioY: number } | null>(null);

  const hasAutoFittedRef = useRef(Boolean(initialTransform));
  const panOriginRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number }>({
    startX: 0,
    startY: 0,
    viewX: 0,
    viewY: 0,
  });

  const liveIds = useMemo(
    () =>
      resolveLiveArtboardIds(
        artboards.map((a) => a.id),
        promotedIds,
        MAX_LIVE_CANVAS_FRAMES,
      ),
    [artboards, promotedIds],
  );

  const promoteArtboard = useCallback((id: string) => {
    setPromotedIds((prev) => [id, ...prev.filter((item) => item !== id)].slice(0, MAX_LIVE_CANVAS_FRAMES));
  }, []);

  const updateView = useCallback(
    (updater: CanvasViewTransform | ((prev: CanvasViewTransform) => CanvasViewTransform)) => {
      setView((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        onTransformChange?.(next);
        return next;
      });
    },
    [onTransformChange],
  );

  const fitAll = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || boardWidth <= 0 || boardHeight <= 0) return;
    const rect = vp.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    updateView(
      computeCanvasFit(
        { width: rect.width, height: rect.height },
        { width: boardWidth, height: boardHeight },
      ),
    );
  }, [boardHeight, boardWidth, updateView]);

  const zoomTo100 = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) {
      updateView((prev) => ({ ...prev, k: 1 }));
      return;
    }
    const rect = vp.getBoundingClientRect();
    updateView({
      k: 1,
      x: Math.max(48, (rect.width - Math.min(boardWidth, rect.width - 96)) / 2),
      y: 64,
    });
  }, [boardWidth, updateView]);

  const zoomByCenter = useCallback(
    (factor: number) => {
      const vp = viewportRef.current;
      const anchor = vp
        ? { x: vp.clientWidth / 2, y: vp.clientHeight / 2 }
        : { x: 400, y: 300 };
      updateView((prev) => computeCanvasZoomAt(prev, factor, anchor));
    },
    [updateView],
  );

  // Auto-fit on initial mount when no persisted transform exists
  useEffect(() => {
    if (hasAutoFittedRef.current || boardWidth <= 0) return;
    const id = requestAnimationFrame(() => {
      hasAutoFittedRef.current = true;
      fitAll();
    });
    return () => cancelAnimationFrame(id);
  }, [boardWidth, fitAll]);

  // Native wheel listener (passive: false) for pan and Ctrl/Cmd+wheel zoom
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = vp.getBoundingClientRect();
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const factor = Math.exp(-e.deltaY * 0.0025);
        updateView((prev) => computeCanvasZoomAt(prev, factor, anchor));
      } else {
        updateView((prev) => ({
          ...prev,
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [updateView]);

  // Space-to-pan and keyboard zoom shortcuts (0, 1, +, -)
  useEffect(() => {
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
      if (isTypingTarget(e.target)) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        fitAll();
      } else if (e.key === "1") {
        e.preventDefault();
        zoomTo100();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomByCenter(1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomByCenter(1 / 1.25);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setSpaceDown(false);
        setPanning(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [fitAll, zoomByCenter, zoomTo100]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      setPanning(true);
      panOriginRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        viewX: view.x,
        viewY: view.y,
      };
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!panning) return;
    const dx = e.clientX - panOriginRef.current.startX;
    const dy = e.clientY - panOriginRef.current.startY;
    updateView((prev) => ({
      ...prev,
      x: panOriginRef.current.viewX + dx,
      y: panOriginRef.current.viewY + dy,
    }));
  };

  const endPan = () => {
    if (panning) setPanning(false);
  };

  if (!source || pendingConfirmUrl) {
    return (
      <div className="flex flex-1 items-center justify-center bg-inset p-6">
        <PreviewFrame
          source={source}
          width={393}
          height={852}
          pendingConfirmUrl={pendingConfirmUrl}
          onConfirmLocalUrl={onConfirmLocalUrl}
          onCancelLocalUrl={onCancelLocalUrl}
          onQuickPickUrl={onQuickPickUrl}
          onOpenFilePicker={onOpenFilePicker}
        />
      </div>
    );
  }

  const snapshotCount = Math.max(0, artboards.length - liveIds.size);

  return (
    <div
      ref={viewportRef}
      role="region"
      aria-label="Multi-size preview canvas"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endPan}
      onMouseLeave={endPan}
      style={{
        backgroundImage: "radial-gradient(rgb(var(--color-hairline) / 0.55) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
      className={`relative flex-1 overflow-hidden bg-inset select-none ${
        panning ? "cursor-grabbing" : spaceDown ? "cursor-grab" : "cursor-default"
      }`}
    >
      {/* Top-left notice when >6 artboards are open */}
      {snapshotCount > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-4 top-4 z-20 rounded-xl border border-hairline/70 bg-raised/95 px-3 py-1.5 text-[11.5px] text-ink-secondary shadow-md backdrop-blur-md"
        >
          Showing <span className="font-semibold text-ink">{MAX_LIVE_CANVAS_FRAMES} live frames</span> ·{" "}
          {snapshotCount} {snapshotCount === 1 ? "snapshot" : "snapshots"} (hover or click any snapshot
          for live view)
        </div>
      )}

      {/* Single transform plane */}
      <div
        style={{
          width: `${boardWidth}px`,
          height: `${boardHeight}px`,
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})`,
          transformOrigin: "0 0",
        }}
        className="relative will-change-transform"
      >
        {artboards.map((artboard) => {
          const isLive = liveIds.has(artboard.id);
          return (
            <div
              key={artboard.id}
              style={{
                position: "absolute",
                left: `${artboard.left}px`,
                top: "40px",
                width: `${artboard.width}px`,
                height: `${artboard.height}px`,
              }}
              className="group"
            >
              {/* Counter-scaled artboard header */}
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 10px)",
                  left: 0,
                  transform: `scale(${1 / view.k})`,
                  transformOrigin: "0 100%",
                }}
                className="z-10 flex items-center gap-2 whitespace-nowrap rounded-lg border border-hairline/70 bg-raised/95 px-2.5 py-1 text-[12px] text-ink shadow-md backdrop-blur-sm"
              >
                {groupIcon(artboard.preset.group)}
                <span className="font-medium text-ink">{artboard.preset.label}</span>
                <span className="font-mono text-[11px] text-ink-secondary">
                  · {artboard.width} × {artboard.height}
                </span>
                {!isLive && (
                  <span className="rounded bg-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                    Snapshot
                  </span>
                )}

                <div className="ml-1 flex items-center gap-0.5 border-l border-hairline/50 pl-1.5">
                  <button
                    type="button"
                    onClick={() => onToggleRotateArtboard(artboard.id)}
                    aria-label={`Rotate ${artboard.preset.label}`}
                    title="Rotate artboard"
                    className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                      artboard.rotated
                        ? "bg-accent/15 text-accent"
                        : "text-ink-secondary hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <ArrowLeftRight className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => refsMap.current.get(artboard.id)?.reload()}
                    aria-label={`Reload ${artboard.preset.label}`}
                    title="Reload artboard"
                    className="flex h-6 w-6 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
                  >
                    <RotateCw className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onShareArtboard(artboard)}
                    aria-label={`Share ${artboard.preset.label} to chat`}
                    title="Share this size to chat"
                    className="flex h-6 w-6 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
                  >
                    <Camera className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onFocusSingleSize(artboard.id)}
                    aria-label={`Focus ${artboard.preset.label} in Single mode`}
                    title="Focus in Single mode"
                    className="flex h-6 w-6 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
                  >
                    <Maximize2 className="h-3 w-3" />
                  </button>
                </div>
              </div>

              {/* Artboard frame */}
              <div
                style={{ pointerEvents: panning || spaceDown ? "none" : "auto" }}
                className="h-full w-full"
              >
                <PreviewFrame
                  ref={(handle) => {
                    if (handle) {
                      refsMap.current.set(artboard.id, handle);
                    } else {
                      refsMap.current.delete(artboard.id);
                    }
                  }}
                  source={source}
                  width={artboard.width}
                  height={artboard.height}
                  scale={1}
                  live={isLive}
                  onPromoteLive={() => promoteArtboard(artboard.id)}
                  scrollSyncSourceId={artboard.id}
                  onScrollSync={
                    scrollSync
                      ? (sourceId, ratioY) => setSharedScroll({ sourceId, ratioY })
                      : undefined
                  }
                  externalScrollRatioY={
                    scrollSync && sharedScroll && sharedScroll.sourceId !== artboard.id
                      ? sharedScroll.ratioY
                      : null
                  }
                  frameTitle={artboard.preset.label}
                  showDeviceBezel={false}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom-right Canvas HUD */}
      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-xl border border-hairline/70 bg-raised/95 px-2 py-1 shadow-lg backdrop-blur-md">
        <button
          type="button"
          onClick={onToggleScrollSync}
          aria-pressed={scrollSync}
          title="Synchronize vertical scrolling across Markdown/document frames"
          className={`inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors ${
            scrollSync
              ? "bg-accent/15 text-accent"
              : "text-ink-secondary hover:bg-hover hover:text-ink"
          }`}
        >
          <Link2 className="h-3 w-3" />
          Sync scroll
        </button>

        <div className="mx-0.5 h-4 w-px bg-hairline/60" />

        <button
          type="button"
          onClick={() => zoomByCenter(1 / 1.25)}
          aria-label="Zoom out"
          title="Zoom out (-)"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[44px] text-center font-mono text-[11px] text-ink">
          {Math.round(view.k * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomByCenter(1.25)}
          aria-label="Zoom in"
          title="Zoom in (+)"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 h-4 w-px bg-hairline/60" />

        <button
          type="button"
          onClick={zoomTo100}
          className="h-7 rounded-lg px-2 font-mono text-[11px] font-medium text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          100%
        </button>
        <button
          type="button"
          onClick={fitAll}
          className="h-7 rounded-lg px-2 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          Fit all
        </button>
      </div>
    </div>
  );
}
