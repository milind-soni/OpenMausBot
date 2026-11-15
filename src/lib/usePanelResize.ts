import { useCallback, useEffect, useRef, useState } from "react";

export function getStoredPanelWidth(id: string, fallback: number | (() => number)): number {
  const def = typeof fallback === "function" ? fallback() : fallback;
  if (typeof window === "undefined") return def;
  try {
    const raw = localStorage.getItem(`gbs-panel-width-${id}`);
    if (!raw) return def;
    const val = parseInt(raw, 10);
    return Number.isNaN(val) || val <= 0 ? def : val;
  } catch {
    return def;
  }
}

export function setStoredPanelWidth(id: string, width: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`gbs-panel-width-${id}`, String(Math.round(width)));
  } catch {}
}

export function getOtherDockedWidths(selfId: string): number {
  if (typeof document === "undefined") return 0;
  const panels = document.querySelectorAll<HTMLElement>("[data-panel]");
  let total = 0;
  panels.forEach((el) => {
    const panelId = el.getAttribute("data-panel");
    if (panelId && panelId !== selfId) {
      // Only count panels in horizontal flex flow (exclude floating drawers)
      const isFloating =
        el.classList.contains("absolute") ||
        el.classList.contains("fixed") ||
        (typeof window !== "undefined" &&
          (window.getComputedStyle(el).position === "absolute" ||
            window.getComputedStyle(el).position === "fixed"));
      if (!isFloating) {
        total += el.getBoundingClientRect().width;
      }
    }
  });
  return total;
}

export interface UsePanelResizeOptions {
  id: string; // "sidebar" | "preview" | "tasks" | "settings"
  defaultWidth: number | (() => number);
  minWidth: number;
  maxWidth: number | (() => number);
  edge: "left" | "right";
  label: string;
  docked?: boolean;
  minChatWidth?: number; // default 300
  onResize?: (width: number) => void;
}

export interface UsePanelResizeReturn {
  width: number;
  isDragging: boolean;
  effectiveMaxWidth: number;
  resetToDefault: () => void;
  setWidth: (width: number) => void;
  handleProps: {
    edge: "left" | "right";
    width: number;
    minWidth: number;
    maxWidth: number;
    label: string;
    isDragging: boolean;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e?: React.PointerEvent) => void;
    onLostPointerCapture: (e?: React.PointerEvent) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

export function usePanelResize({
  id,
  defaultWidth,
  minWidth,
  maxWidth,
  edge,
  label,
  docked: _docked = true,
  minChatWidth = 300,
  onResize,
}: UsePanelResizeOptions): UsePanelResizeReturn {
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const getEffectiveMaxWidth = useCallback((): number => {
    const configuredMax = typeof maxWidth === "function" ? maxWidth() : maxWidth;
    if (typeof window === "undefined") return configuredMax;
    const otherWidth = getOtherDockedWidths(id);
    const available = window.innerWidth - otherWidth - minChatWidth;
    const maxAllowedByChat = Math.max(minWidth, available);
    return Math.max(minWidth, Math.min(configuredMax, maxAllowedByChat));
  }, [id, maxWidth, minWidth, minChatWidth]);

  // The user's chosen width. Only user actions (drag, keyboard, reset) change and persist it;
  // window and neighbour changes clamp the rendered width without overwriting this preference.
  const preferredRef = useRef<number>(getStoredPanelWidth(id, defaultWidth));

  const [width, setWidthState] = useState<number>(() => {
    const raw = preferredRef.current;
    if (typeof window === "undefined") return raw;
    const effMax = getEffectiveMaxWidth();
    return Math.max(minWidth, Math.min(raw, effMax));
  });

  const widthRef = useRef(width);
  widthRef.current = width;

  const applyWidth = useCallback(
    (newWidth: number): number => {
      const effMax = getEffectiveMaxWidth();
      const clamped = Math.max(minWidth, Math.min(newWidth, effMax));
      if (clamped !== widthRef.current) {
        widthRef.current = clamped;
        setWidthState(clamped);
        window.dispatchEvent(new CustomEvent("gbs-panel-resize", { detail: { id, width: clamped } }));
        onResize?.(clamped);
      }
      return clamped;
    },
    [id, minWidth, getEffectiveMaxWidth, onResize],
  );

  const updateWidth = useCallback(
    (newWidth: number) => {
      const clamped = applyWidth(newWidth);
      preferredRef.current = clamped;
      setStoredPanelWidth(id, clamped);
    },
    [id, applyWidth],
  );

  const resetToDefault = useCallback(() => {
    const def = typeof defaultWidth === "function" ? defaultWidth() : defaultWidth;
    updateWidth(def);
  }, [defaultWidth, updateWidth]);

  // Window resize & other panels resize: fit the preferred width into the space available,
  // growing back toward it when space returns. Never persisted.
  useEffect(() => {
    const handleCheckClamp = () => {
      if (isDraggingRef.current) return;
      applyWidth(preferredRef.current);
    };

    handleCheckClamp();
    window.addEventListener("resize", handleCheckClamp);
    window.addEventListener("gbs-panel-resize", handleCheckClamp);
    return () => {
      window.removeEventListener("resize", handleCheckClamp);
      window.removeEventListener("gbs-panel-resize", handleCheckClamp);
    };
  }, [applyWidth]);

  // Pointer drag event handlers
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const target = e.currentTarget;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {}

      isDraggingRef.current = true;
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current = widthRef.current;

      document.body.classList.add("gbs-resizing");
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      e.stopPropagation();

      const deltaX = e.clientX - startXRef.current;
      const delta = edge === "right" ? deltaX : -deltaX;
      updateWidth(startWidthRef.current + delta);
    },
    [edge, updateWidth],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    isDraggingRef.current = false;
    setIsDragging(false);

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    document.body.classList.remove("gbs-resizing");
  }, []);

  const handlePointerCancel = useCallback((e?: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);

    if (e) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}
    }

    document.body.classList.remove("gbs-resizing");
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 64 : 16;
      const effMax = getEffectiveMaxWidth();

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const delta = edge === "right" ? -step : step;
        updateWidth(widthRef.current + delta);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const delta = edge === "right" ? step : -step;
        updateWidth(widthRef.current + delta);
      } else if (e.key === "Home") {
        e.preventDefault();
        updateWidth(minWidth);
      } else if (e.key === "End") {
        e.preventDefault();
        updateWidth(effMax);
      } else if (e.key === "Enter") {
        e.preventDefault();
        resetToDefault();
      }
    },
    [edge, minWidth, getEffectiveMaxWidth, updateWidth, resetToDefault],
  );

  // Safety cleanup on blur or unmount
  useEffect(() => {
    const onBlur = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        setIsDragging(false);
        document.body.classList.remove("gbs-resizing");
      }
    };
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.body.classList.remove("gbs-resizing");
    };
  }, []);

  return {
    width,
    isDragging,
    effectiveMaxWidth: getEffectiveMaxWidth(),
    resetToDefault,
    setWidth: updateWidth,
    handleProps: {
      edge,
      width,
      minWidth,
      maxWidth: getEffectiveMaxWidth(),
      label,
      isDragging,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onLostPointerCapture: handlePointerCancel,
      onDoubleClick: resetToDefault,
      onKeyDown: handleKeyDown,
    },
  };
}
