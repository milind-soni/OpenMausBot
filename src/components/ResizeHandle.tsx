import React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface ResizeHandleProps {
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
  className?: string;
}

export function ResizeHandle({
  edge,
  width,
  minWidth,
  maxWidth,
  label,
  isDragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onDoubleClick,
  onKeyDown,
  className,
}: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      aria-valuemin={minWidth}
      aria-valuemax={Math.round(maxWidth)}
      aria-label={label}
      tabIndex={0}
      data-testid="resize-handle"
      data-edge={edge}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-y-0 z-40 flex items-center justify-center cursor-col-resize select-none touch-none outline-none group",
        edge === "right" ? "-right-[4px] w-[9px]" : "-left-[4px] w-[9px]",
        isDragging && "is-resizing",
        className,
      )}
    >
      {/* Visual hairline highlight: 2px wide, transitions smoothly from transparent to accent */}
      <div
        className={cn(
          "h-full w-[2px] transition-colors duration-150 pointer-events-none",
          isDragging
            ? "bg-accent shadow-[0_0_6px_rgba(16,132,254,0.6)]"
            : "bg-transparent group-hover:bg-accent/80 group-focus-visible:bg-accent group-active:bg-accent",
        )}
      />

      {/* Global drag overlay to prevent pointer loss over any guest iframe / webview */}
      {isDragging &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] cursor-col-resize select-none pointer-events-none"
            style={{ cursor: "col-resize" }}
          />,
          document.body,
        )}
    </div>
  );
}
