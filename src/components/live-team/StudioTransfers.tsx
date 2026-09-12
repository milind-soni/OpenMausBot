import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { FileText } from "lucide-react";
import type { StudioMotion } from "@/lib/live-team-motion";

/** Decorative movement only when both real endpoints are on this room page. */
export function StudioTransfers({ motions }: { motions: StudioMotion[] }) {
  const layer = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<Array<{ id: string; fromX: number; fromY: number; toX: number; toY: number }>>([]);
  useLayoutEffect(() => {
    const parent = layer.current?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    // Coordinates belong to scroll content, not the clipped viewport.
    const scrollX = parent.scrollLeft;
    const scrollY = parent.scrollTop;
    if (layer.current) layer.current.style.height = `${Math.max(parent.clientHeight, ...Array.from(parent.children).filter((child) => child !== layer.current).map((child) => (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight))}px`;
    setPaths(motions.flatMap((motion) => {
      const sourceId = motion.kind === "result" ? motion.targetBotId : motion.sourceBotId;
      const source = parent.querySelector(`[data-station="${CSS.escape(sourceId ?? "")}"] .studio-task-stack`)?.getBoundingClientRect();
      const target = parent.querySelector(motion.kind === "result" ? `[data-result="${CSS.escape(motion.id.slice(7))}"]` : `[data-station="${CSS.escape(motion.targetBotId)}"] .studio-task-stack`)?.getBoundingClientRect();
      if (!source || !target) return [];
      return [{ id: motion.id, fromX: source.x + source.width / 2 - bounds.x + scrollX, fromY: source.y - bounds.y + scrollY,
        toX: target.x + target.width / 2 - bounds.x + scrollX, toY: target.y - bounds.y + scrollY }];
    }));
  }, [motions]);
  return <div className="studio-transfer-overlay" ref={layer} aria-hidden="true">{paths.map((path) => <span key={path.id} data-motion={path.id} className="studio-travel-slip" style={{
    "--from-x": `${path.fromX}px`, "--from-y": `${path.fromY}px`, "--to-x": `${path.toX}px`, "--to-y": `${path.toY}px`,
    "--mid-x": `${(path.fromX + path.toX) / 2}px`, "--mid-y": `${Math.min(path.fromY, path.toY) - 50}px`,
  } as CSSProperties}><FileText size={21} /></span>)}</div>;
}
