/**
 * Runs `callback` in a task after the next paint: a frame callback runs just before the paint and the task it queues runs
 * after it. A hidden window gets no frames, so `fallbackMs` stands in. Returns the cancel.
 */
export function afterPaint(callback: () => void, fallbackMs = 100): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = setTimeout(callback, 0);
  };
  const frame = requestAnimationFrame(queue);
  timer = setTimeout(queue, fallbackMs);
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}
