import { CachedChatImage } from "./CachedChatImage";
import { useCallback, useEffect, useRef, useState } from "react";
import { overlayPortal as createPortal } from "@/components/ModalPresence";
import { Download, ImageOff, LoaderCircle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { canonicalDownloadFilename } from "@/lib/download-filename";
import { t } from "@/lib/i18n";
import type { PreviewImage } from "./AttachmentPreview";
import { previewKeyAction, usePreviewGestures, nextImageIndex } from "./AttachmentPreviewNavigation";
import { CopyImageButton } from "./CopyImageButton";
import { useDismissMotion, useHeldMenuMotion } from "./MenuMotion";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";

export function AttachmentPreviewDialog({
  image,
  images,
  initialIndex = 0,
  onClose,
}: {
  image: PreviewImage;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const items = images?.length ? images : [image];
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const current = items[index] ?? image;
  const dialogRef = useRef<HTMLDivElement>(null);
  const motion = useDismissMotion(onClose);
  const [loadedSources, setLoadedSources] = useState<Set<string>>(() => new Set());
  const [failedSources, setFailedSources] = useState<Set<string>>(() => new Set());
  const [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuMotion = useHeldMenuMotion(menu);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>("button:not([disabled]), a")?.focus();
  }, [menu]);

  const navigate = useCallback((step: -1 | 1) => {
    cancelPress();
    if (menuRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
    setMenu(null);
    setIndex((value) => nextImageIndex(value, step, items.length));
  }, [items.length, cancelPress]);
  const { drag, zoom, animateZoom, handlers, tapSurface, clearTap } = usePreviewGestures(index, items.length, navigate, motion.dismiss, cancelPress);

  useEffect(() => {
    if (!motion.open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuRef.current && !menuRef.current.hasAttribute("inert")) {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        dialogRef.current?.focus();
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        setMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        return;
      }
      const action = previewKeyAction(event.key, items.length);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "close") motion.dismiss();
        else navigate(action === "previous" ? -1 : 1);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter(element => !element.closest("[inert]"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [items.length, navigate, motion.open, motion.dismiss]);

  if (!motion.shown) return null;

  const loaded = loadedSources.has(current.src);
  const failed = failedSources.has(current.src);
  const retry = () => {
    setFailedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setLoadedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setAttempt((value) => value + 1);
  };

  return createPortal(
    <div
      ref={dialogRef}
      {...motion.exitProps}
      data-overlay-fade={motion.open ? "in" : "out"}
      role="dialog"
      aria-modal="true"
      aria-label={t("attach.previewAria", { name: current.name })}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex touch-none items-center justify-center overflow-hidden bg-black outline-none"
      {...handlers}
      onClick={event => {
        if (menu && !menuRef.current?.contains(event.target as Node)) {
          if (menuRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
          setMenu(null);
        } else if (!menu) {
          tapSurface(event);
        }
      }}
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        cancelPress();
        clearTap();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className={cn("pointer-events-none absolute inset-0", drag === null && "motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out")}
        style={{ transform: `translateX(calc(${-100 * index}% + ${drag?.x ?? 0}px)) translateY(${drag?.y ?? 0}px)` }}>
        {items.slice(Math.max(0, index - 1), index + 2).map((item, offset) => {
          const position = Math.max(0, index - 1) + offset;
          const active = position === index;
          return (
            <div key={position} inert={!active} aria-hidden={!active} className="absolute inset-y-0 flex w-full items-center justify-center"
              style={{ left: `${position * 100}%` }}>
              {active && !loaded && !failed && (
                <div className="absolute inset-0 flex animate-pulse items-center justify-center bg-white/[0.055]" role="status">
                  <span className="flex items-center gap-2 text-[13px] text-white/55">
                    <LoaderCircle size={17} className="animate-spin" /> {t("attach.imageLoading")}
                  </span>
                </div>
              )}
              {active && failed ? (
                <div className="pointer-events-auto flex flex-col items-center gap-3 text-white/60" role="alert">
                  <ImageOff size={34} />
                  <span className="text-[13px]">{t("attach.imageFailed")}</span>
                  <button
                    type="button"
                    onClick={retry}
                    className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-[12px] text-white hover:bg-white/15"
                  >
                    <RotateCcw size={13} /> {t("chat.retry")}
                  </button>
                </div>
              ) : (
                <CachedChatImage
                  key={attempt}
                  src={item.src}
                  version={item.version}
                  alt={active ? item.name : ""}
                  draggable={false}
                  data-preview-active-image={active ? "" : undefined}
                  style={active ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined}
                  onPointerDown={event => {
                    if (event.pointerType !== "touch") return;
                    cancelPress();
                    if (!event.isPrimary) return;
                    const { clientX: x, clientY: y } = event;
                    press.current = { x, y, timer: setTimeout(() => setMenu({ x, y }), 500) };
                  }}
                  onPointerMove={event => {
                    const start = press.current;
                    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelPress();
                  }}
                  onPointerUp={cancelPress}
                  onPointerCancel={cancelPress}
                  onLoad={() => setLoadedSources((sources) => sources.has(item.src) ? sources : new Set(sources).add(item.src))}
                  onError={() => setFailedSources((sources) => sources.has(item.src) ? sources : new Set(sources).add(item.src))}
                  className={cn(
                    "pointer-events-auto block max-h-full max-w-full select-none object-contain [-webkit-touch-callout:none]",
                    active && !loaded && "opacity-0",
                    active && animateZoom && "preview-zoom-transition",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
      {menuMotion.shown && menuMotion.value && (
        <div ref={menuRef} {...menuMotion.exitProps} data-overlay-fade={menuMotion.closing ? "out" : "in"} role="group" aria-label={current.name}
          className={cn("fixed z-20 w-52 max-w-[calc(100vw-16px)]", MENU_SHEET)}
          style={{ left: Math.max(8, Math.min(menuMotion.value.x, window.innerWidth - 216)), top: Math.max(8, Math.min(menuMotion.value.y, window.innerHeight - 112)) }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
          <CopyImageButton key={current.src} src={current.src} name={current.name} />
          <a href={current.downloadUrl ?? current.src}
            download={current.downloadName ?? canonicalDownloadFilename({ fallback: current.name, source: current.src })}
            target="_blank" rel="noreferrer"
            aria-label={t("attach.downloadAria", { name: current.name })}
            className={cn(MENU_ITEM, "text-ink interaction:bg-raised/50")}>
            <Download size={16} /> {t("attach.download")}
          </a>
        </div>
      )}
    </div>,
    document.body,
  );
}
