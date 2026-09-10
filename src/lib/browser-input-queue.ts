type Input = Record<string, unknown>;
const movement = (body: Input) => body.type === "input_mouse" && ["mouseMoved", "mouseWheel"].includes(String(body.eventType));
const release = (body: Input) => (body.type === "input_mouse" && body.eventType === "mouseReleased") || (body.type === "input_keyboard" && body.eventType === "keyUp");
const delta = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const clamp = (value: number) => Math.max(-10_000, Math.min(10_000, value));

/** One request at a time, with replaceable movement coalesced behind it.
 * Keyboard/button order is preserved; reconnect never replays old input. */
export function createBrowserInputQueue(send: (body: Input) => Promise<void>, onError: (cause: unknown) => void) {
  let queue: Input[] = [];
  let active: Promise<void> | null = null;
  let generation = 0;
  let stopped = false;
  const halt = (cause: unknown) => {
    queue = queue.filter(release);
    if (!stopped) { stopped = true; onError(cause); }
  };
  const run = () => {
    if (active || !queue.length) return;
    const current = generation;
    active = (async () => {
      while (current === generation && queue.length) {
        const body = queue.shift()!;
        try { await send(body); }
        catch (cause) { if (current === generation) halt(cause); }
      }
    })().finally(() => { active = null; run(); });
  };
  return {
    enqueue(body: Input) {
      if (stopped && !release(body)) return;
      const last = queue.at(-1);
      if (last && movement(body) && last.type === body.type && last.eventType === body.eventType && last.modifiers === body.modifiers && last.button === body.button) {
        queue[queue.length - 1] = body.eventType === "mouseWheel"
          ? { ...body, deltaX: clamp(delta(last.deltaX) + delta(body.deltaX)), deltaY: clamp(delta(last.deltaY) + delta(body.deltaY)) }
          : { ...body };
        return;
      }
      // ponytail: fixed 32-item ceiling; do not let a slow VPS accumulate
      // minutes of input. Overload halts new presses until the view reconnects.
      if (queue.length >= 32) {
        if (movement(body)) return;
        const replaceable = queue.findIndex(movement);
        if (replaceable >= 0) queue.splice(replaceable, 1);
        else {
          halt(new Error("Browser input stopped because the connection is too slow. Release control and reconnect before typing again."));
          if (!release(body) || queue.length >= 32) return;
        }
      }
      queue.push({ ...body });
      run();
    },
    async drain() {
      // Hand-back waits for keys/buttons, not stale cursor/scroll movement.
      queue = queue.filter((body) => !movement(body));
      while (active || queue.length) { run(); await active; }
    },
    clear() { generation++; queue = []; stopped = false; },
  };
}
