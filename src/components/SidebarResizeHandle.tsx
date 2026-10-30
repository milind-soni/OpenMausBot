import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { t } from "@/lib/i18n";
import {
  SIDEBAR_WIDTH_KEY,
  SIMPLE_SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";

export function sidebarDefaultWidth(density: SidebarDensity, simple: boolean): number {
  return density === "compact" ? 272 : simple ? 280 : 320;
}

export type SidebarSizing = ReturnType<typeof useSidebarWidth>;

export function useSidebarWidth({ simple, density, sidePanelOpen, sidebarRef }: {
  simple: boolean;
  density: SidebarDensity;
  sidePanelOpen: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
}) {
  const key = simple ? SIMPLE_SIDEBAR_WIDTH_KEY : SIDEBAR_WIDTH_KEY;
  const defaultWidth = sidebarDefaultWidth(density, simple);
  const cap = simple ? 400 : 480;
  const maxWidth = sidePanelOpen ? defaultWidth : Math.min(cap, window.innerWidth - 320);
  const [savedWidth, setSavedWidth] = useState<number | null>(() => loadSidebarWidth(undefined, key));
  const widthRef = useRef(savedWidth);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const width = loadSidebarWidth(undefined, key);
    widthRef.current = width;
    setSavedWidth(width);
  }, [key]);
  const resizeTo = (width: number) => {
    const next = clampSidebarWidth(width, sidePanelOpen ? defaultWidth + 320 : window.innerWidth, cap);
    if (next === Math.round(sidebarRef.current?.getBoundingClientRect().width ?? defaultWidth)) return null;
    widthRef.current = next;
    sidebarRef.current?.style.setProperty("--sidebar-width", `${next}px`);
    return next;
  };
  const save = (width: number) => {
    setSavedWidth(width);
    saveSidebarWidth(width, undefined, key);
  };
  const finishResize = () => {
    setResizing(false);
    if (widthRef.current !== null) save(widthRef.current);
  };
  return {
    width: Math.min(widthRef.current ?? defaultWidth, cap),
    defaultWidth,
    maxWidth,
    resizing,
    valueNow: Math.min(savedWidth ?? defaultWidth, maxWidth),
    startResize: () => setResizing(true),
    resizeTo,
    finishResize,
    stepResize: (step: number) => {
      const next = resizeTo(Math.min(widthRef.current ?? defaultWidth, maxWidth) + step);
      if (next !== null) save(next);
    },
  };
}

export function SidebarResizeHandle({ sizing, sidebarRef, style }: {
  sizing: SidebarSizing;
  sidebarRef: RefObject<HTMLElement | null>;
  style?: CSSProperties;
}) {
  return (
    <div
      role="separator"
      aria-label={t("sidebar.resize")}
      aria-orientation="vertical"
      aria-valuemin={240}
      aria-valuemax={sizing.maxWidth}
      aria-valuenow={sizing.valueNow}
      tabIndex={0}
      data-sidebar-resize
      className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none hover:bg-accent/20 focus-visible:bg-accent/30 md:block"
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        sizing.startResize();
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const next = sizing.resizeTo(event.clientX - (sidebarRef.current?.getBoundingClientRect().left ?? 0));
        if (next !== null) event.currentTarget.setAttribute("aria-valuenow", String(next));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) sizing.finishResize();
      }}
      onPointerCancel={sizing.finishResize}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        sizing.stepResize(event.key === "ArrowRight" ? 16 : -16);
      }}
    />
  );
}
