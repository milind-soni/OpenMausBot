import type { CSSProperties, ReactNode } from "react";

import type { Layout, StageTransform } from "./spaces-layout";

/**
 * Places cards at the boxes the layout computed and applies the one transform
 * that moves the whole canvas. Pure presentation — every decision lives in the
 * shell, and every measurement in spaces-layout.
 */
export function SpacesStage({
  layout,
  transform,
  transitioning,
  animated = true,
  children,
}: {
  layout: Layout;
  transform: StageTransform;
  /** `will-change` only while moving: leaving it on pins every card into its
   * own compositor layer and costs VRAM for nothing. */
  transitioning: boolean;
  /** False while the trackpad is driving: a transition would lag the fingers. */
  animated?: boolean;
  children: ReactNode[];
}) {
  const style: CSSProperties = {
    width: layout.stage.width,
    height: layout.stage.height,
    transformOrigin: "0 0",
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
    willChange: transitioning ? "transform" : undefined,
    transitionProperty: animated ? "transform" : "none",
    transitionDuration: "360ms",
    // Matches macOS's window-lift curve: quick to leave, gentle to arrive.
    transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)",
  };

  return (
    <div className="spaces-stage absolute left-0 top-0 motion-reduce:transition-none" style={style}>
      {children.map((child, index) => {
        const cell = layout.cells[index];
        if (!cell) return null;
        return (
          <div
            key={index}
            // Cells animate their own box only when the arrangement changes —
            // switching tile count or going to the grid. Navigating inside one
            // arrangement never touches these, it just moves the stage.
            className="absolute transition-[left,top,width,height] duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
            style={
              {
                left: cell.x,
                top: cell.y,
                width: cell.width,
                height: cell.height,
                // Off-screen cards stay mounted and interactive, but the
                // browser skips their layout and paint.
                contentVisibility: "auto",
                containIntrinsicSize: `${Math.round(cell.height)}px ${Math.round(cell.width)}px`,
              } as CSSProperties
            }
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}
