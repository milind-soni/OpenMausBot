import type { createBrowserInputQueue } from "./browser-input-queue";

type Body = Record<string, unknown>;
/** Page input goes through the input queue; toolbar actions run as commands.
 * Both wait, in order, behind an automatic take. */
export type BrowserInteraction = { input: Body } | { command: Body };
/** "pending" once a take is sent, "slow" when it outlasts the notice delay. */
export type BrowserTakeStatus = "" | "pending" | "slow";

/** Idle time, with nothing held down, before control goes back to the bot. */
export const BROWSER_HAND_BACK_MS = 8_000;
/** A take shorter than this shows no waiting status, so a click does not flicker. */
export const BROWSER_TAKE_NOTICE_MS = 300;
// The input queue halts beyond 32 unsent inputs, and a slow take can buffer more.
const FLUSH_BATCH = 16;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

/** Hover, a lone modifier, or the release of a press the page never received
 * is not an interaction with the page, so it never takes control. */
function startsInteraction(item: BrowserInteraction): boolean {
  if ("command" in item) return true;
  const { eventType, key } = item.input;
  return eventType === "mousePressed" || eventType === "mouseWheel" || eventType === "char"
    || (eventType === "keyDown" && !MODIFIER_KEYS.has(String(key)));
}

/** Control without a button, for one live-view connection. The first real
 * interaction takes the browser from the bot and waits, with everything after
 * it, until the server grants the lease; then it all goes through in order.
 * Idle hands it back. The server lease still never lets person and bot input
 * interleave, and nothing is handed back while a key or button is held down:
 * the server would then require a browser restart. */
export function createBrowserControl(options: {
  queue: Pick<ReturnType<typeof createBrowserInputQueue>, "enqueue" | "drain" | "settle" | "size" | "stopped">;
  take: () => Promise<unknown>;
  release: () => Promise<unknown>;
  /** Runs a toolbar action and reports its own errors; never rejects. */
  command: (body: Body) => Promise<unknown>;
  /** A toolbar action or restart is running. */
  busy: () => boolean;
  /** The server lists this viewer as the holder; a refused take can leave it so. */
  owned: () => boolean;
  onTakeStatus: (status: BrowserTakeStatus) => void;
  onError: (message: string) => void;
  /** Page input arrived after the input queue halted; show why it is ignored. */
  onHalted: () => void;
}) {
  let state: "bot" | "taking" | "held" | "releasing" = "bot";
  let buffer: BrowserInteraction[] = [];
  let flushing = false;
  let closed = false;
  let activity = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let notice: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<string>();

  const track = ({ type, eventType, code, key, button }: Body) => {
    const id = type === "input_keyboard" ? `key:${code || key}` : `mouse:${button}`;
    if (eventType === "keyDown" || eventType === "mousePressed") held.add(id);
    else if (eventType === "keyUp" || eventType === "mouseReleased") held.delete(id);
  };
  const quiet = () => !closed && !flushing && !held.size && !options.busy()
    && (state === "held" || (state === "bot" && options.owned()));
  const arm = () => {
    clearTimeout(idle);
    idle = closed ? undefined : setTimeout(() => { idle = undefined; void idleHandBack(); }, BROWSER_HAND_BACK_MS);
  };
  const release = () => {
    state = "releasing";
    chain = chain.then(() => closed ? undefined : options.release()).catch(() => {})
      .then(() => { if (state === "releasing") state = "bot"; });
  };
  const idleHandBack = async () => {
    if (!quiet()) return; // whatever blocks it re-arms the timer when it ends
    const seen = activity;
    await options.queue.drain(); // every key-up and button-up lands first
    if (seen === activity && quiet()) release();
  };
  const flush = async () => {
    flushing = true;
    try {
      for (let item = buffer.shift(); item && !closed; item = buffer.shift()) {
        if ("command" in item) await options.command(item.command);
        else {
          options.queue.enqueue(item.input);
          if (options.queue.size() >= FLUSH_BATCH) await options.queue.settle();
        }
      }
    } finally { flushing = false; buffer = []; }
  };
  const take = () => {
    state = "taking";
    options.onError("");
    options.onTakeStatus("pending");
    clearTimeout(notice);
    notice = setTimeout(() => { if (!closed && state === "taking") options.onTakeStatus("slow"); }, BROWSER_TAKE_NOTICE_MS);
    chain = chain.then(async () => {
      if (closed) return;
      const granted = await options.take().then(() => true, (cause: unknown) => {
        if (!closed) options.onError(cause instanceof Error ? cause.message : String(cause));
        return false;
      });
      clearTimeout(notice);
      if (closed) return;
      options.onTakeStatus("");
      if (granted) { state = "held"; await flush(); }
      else { state = "bot"; buffer = []; held.clear(); }
      arm(); // a refused take can still leave this viewer holding the browser
    }).catch(() => {});
  };

  return {
    interact(item: BrowserInteraction) {
      if (closed) return;
      const waiting = state === "taking" || flushing;
      if (state !== "held" && !waiting) {
        if (!startsInteraction(item)) return;
        // Halted input is dropped; taking control for it would only pause the bot.
        if ("input" in item && options.queue.stopped()) { options.onHalted(); return; }
      }
      if ("input" in item) track(item.input);
      activity++;
      arm();
      if (state === "held" && !waiting) {
        if ("input" in item) options.queue.enqueue(item.input);
        else void options.command(item.command).then(arm);
        return;
      }
      buffer.push(item);
      if (!waiting) take();
    },
    /** The server's control state changed: a hold nobody uses still goes back. */
    observe() { if (!closed && idle === undefined && options.owned()) arm(); },
    /** The panel is closing: hand back now, unless input is held or unsent.
     * The server's own disconnect cleanup handles those. */
    leave() {
      if (!quiet() || options.queue.size()) return;
      state = "releasing";
      void options.release().catch(() => {});
    },
    close() { closed = true; clearTimeout(idle); clearTimeout(notice); buffer = []; held.clear(); },
  };
}
