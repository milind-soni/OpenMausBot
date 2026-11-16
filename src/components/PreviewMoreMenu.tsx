import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { PREVIEW_ZOOM_OPTIONS, type PreviewZoomMode } from "@/lib/previewSizes";
import { sharesLinkOnly } from "@/lib/previewSharing";
import type { PreviewSource } from "@/lib/mobilePreviewUrl";

export interface PreviewMoreMenuProps {
  activeSource: PreviewSource | null;
  capturing?: boolean;
  canCaptureScreenshot?: boolean;
  zoom: PreviewZoomMode;
  setZoom: (z: PreviewZoomMode) => void;
  rotated: boolean;
  setRotated: React.Dispatch<React.SetStateAction<boolean>>;
  isRotatable: boolean;
  /** Responsive size always renders at 100%, so zoom doesn't apply. */
  zoomable?: boolean;
  onOpenInPreviewPage: () => void;
  onCaptureScreenshot: (mode: "visible" | "full") => void;
  historyNav: { canGoBack: boolean; canGoForward: boolean };
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function PreviewMoreMenu({
  activeSource,
  capturing = false,
  canCaptureScreenshot = false,
  zoom,
  setZoom,
  rotated,
  setRotated,
  isRotatable,
  zoomable = true,
  onOpenInPreviewPage,
  onCaptureScreenshot,
  historyNav,
  onGoBack,
  onGoForward,
  onOpenChange,
  className,
}: PreviewMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const updatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuCoords({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  };

  const handleToggle = () => {
    if (!open) {
      updatePosition();
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;

    // Focus first active menuitem
    const rafId = requestAnimationFrame(() => {
      const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
      firstItem?.focus();
    });

    const onBlur = () => {
      setOpen(false);
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (!menuRef.current) return;
      const menuItems = Array.from(
        menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'),
      );
      if (menuItems.length === 0) return;

      const activeIdx = menuItems.indexOf(document.activeElement as HTMLButtonElement);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIdx = (activeIdx + 1) % menuItems.length;
        menuItems[nextIdx]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIdx = (activeIdx - 1 + menuItems.length) % menuItems.length;
        menuItems[prevIdx]?.focus();
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          const prevIdx = (activeIdx - 1 + menuItems.length) % menuItems.length;
          menuItems[prevIdx]?.focus();
        } else {
          const nextIdx = (activeIdx + 1) % menuItems.length;
          menuItems[nextIdx]?.focus();
        }
      }
    };

    const onScrollOrResize = () => {
      updatePosition();
    };

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("blur", onBlur);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const hasGbs = typeof window !== "undefined" && Boolean(window.gbs);

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="More preview options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="More options"
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            if (!open) {
              e.preventDefault();
              updatePosition();
              setOpen(true);
            }
          }
        }}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      {open &&
        menuCoords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="More preview options"
            style={{
              position: "fixed",
              top: `${menuCoords.top}px`,
              right: `${menuCoords.right}px`,
              zIndex: 60,
            }}
            className="w-56 max-h-[calc(100vh-80px)] overflow-y-auto rounded-xl border border-hairline/60 bg-panel p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
          >
            {/* Open in Preview page */}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onOpenInPreviewPage();
                triggerRef.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover focus:bg-raised-hover focus:outline-none"
            >
              <Maximize2 className="h-3.5 w-3.5 text-ink-secondary shrink-0" />
              <span>Open in Preview page</span>
            </button>

            {/* Rotate option (folded from header when space is tight) */}
            {isRotatable && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  setRotated((v) => !v);
                  triggerRef.current?.focus();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover focus:bg-raised-hover focus:outline-none"
              >
                <ArrowLeftRight className="h-3.5 w-3.5 text-ink-secondary shrink-0" />
                <span>{rotated ? "Rotate to portrait" : "Rotate to landscape"}</span>
              </button>
            )}

            {/* Screenshot options */}
            {canCaptureScreenshot && (
              <div className="mt-1 border-t border-hairline/40 pt-1">
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                  Share to chat
                </div>
                {sharesLinkOnly(activeSource, hasGbs) ? (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      setOpen(false);
                      onCaptureScreenshot("visible");
                      triggerRef.current?.focus();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover focus:bg-raised-hover focus:outline-none"
                  >
                    <Camera className="h-3.5 w-3.5 text-ink-secondary shrink-0" />
                    <span>Add preview link to chat</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={!activeSource || capturing}
                      onClick={() => {
                        setOpen(false);
                        onCaptureScreenshot("visible");
                        triggerRef.current?.focus();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover focus:bg-raised-hover focus:outline-none disabled:opacity-35"
                    >
                      <Camera className="h-3.5 w-3.5 text-ink-secondary shrink-0" />
                      <span>Send visible area</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={!activeSource || capturing}
                      onClick={() => {
                        setOpen(false);
                        onCaptureScreenshot("full");
                        triggerRef.current?.focus();
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover focus:bg-raised-hover focus:outline-none disabled:opacity-35"
                    >
                      <Camera className="h-3.5 w-3.5 text-ink-secondary shrink-0" />
                      <span>Send full page</span>
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Zoom options */}
            {zoomable && <div className="mt-1 border-t border-hairline/40 pt-1">
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                Zoom
              </div>
              {PREVIEW_ZOOM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setZoom(opt.value as PreviewZoomMode);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors focus:outline-none",
                    zoom === opt.value
                      ? "bg-accent/15 font-medium text-ink focus:bg-accent/25"
                      : "text-ink-secondary hover:bg-raised-hover hover:text-ink focus:bg-raised-hover",
                  )}
                >
                  <span>{opt.label}</span>
                  {zoom === opt.value && <Check className="h-3 w-3 text-accent shrink-0" />}
                </button>
              ))}
            </div>}

            {/* History navigation */}
            {hasGbs && (
              <div className="mt-1 border-t border-hairline/40 pt-1">
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
                  History
                </div>
                <div className="flex items-center gap-1 px-1">
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={!historyNav.canGoBack}
                    onClick={() => {
                      onGoBack();
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 bg-inset px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus:bg-raised-hover focus:outline-none disabled:opacity-35"
                  >
                    <ChevronLeft className="h-3 w-3 shrink-0" />
                    <span>Back</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    disabled={!historyNav.canGoForward}
                    onClick={() => {
                      onGoForward();
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 bg-inset px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus:bg-raised-hover focus:outline-none disabled:opacity-35"
                  >
                    <span>Forward</span>
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  </button>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
