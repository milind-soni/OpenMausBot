import type { DragEvent } from "react";

const MIME = "application/x-openmaus-workspace-thread";
type DraggedThread = { ownerId: string; threadId: string };
let dragged: DraggedThread | null = null;

export function startPaneDrag(event: DragEvent, ownerId: string, threadId: string) {
  dragged = { ownerId, threadId };
  event.dataTransfer.setData(MIME, threadId);
  const end = () => { dragged = null; };
  window.addEventListener("dragend", end, { capture: true, once: true });
}

export function draggedThread(event: DragEvent) {
  return event.dataTransfer.types.includes(MIME) ? dragged : null;
}
