import type { createBrowserInputQueue } from "./browser-input-queue";

type Body = Record<string, unknown>;
/** Page input goes through the input queue; toolbar actions run as commands.
 * Both wait, in order, behind an automatic take. */
export type BrowserInteraction = { input: Body } | { command: Body };
/** "pending" once a take is sent, "slow" when it outlasts the notice delay,
 * "stale" when the grant came after the bot's own action and what the person
 * did while waiting was dropped (until their next interaction). */
export type BrowserTakeStatus = "" | "pending" | "slow" | "stale";

/** Idle time, with nothing held down, before control goes back to the bot. */
export const BROWSER_HAND_BACK_MS = 8_000;
/** A take shorter than this shows no waiting status, so a click does not flicker. */
export const BROWSER_TAKE_NOTICE_MS = 300;
// The input queue halts beyond 32 unsent inputs, and a slow take can buffer more.
const FLUSH_BATCH = 16;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
// input() in server/browser-live.ts sends these, like shortcuts, as one whole press.
const DISCRETE_KEYS = new Set(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
// Toolbar actions that mean the same whatever the page shows by then.
const ABSOLUTE_COMMANDS = new Set(["navigate", "tab-new"]);

/** Hover, a lone modifier, or the release of a press the page never received
 * is not an interaction with the page, so it never takes control. */
function startsInteraction(item: BrowserInteraction): boolean {
  if ("command" in item) return true;
  const { eventType, key } = item.input;
  return eventType === "mousePressed" || eventType === "mouseWheel" || eventType === "char"
    || (eventType === "keyDown" && !MODIFIER_KEYS.has(String(key)));
}

const inputId = ({ type, code, key, button }: Body) => type === "input_keyboard" ? `key:${code || key}` : `mouse:${button}`;
const isPress = ({ eventType }: Body) => eventType === "keyDown" || eventType === "mousePressed";
const isRelease = ({ eventType }: Body) => eventType === "keyUp" || eventType === "mouseReleased";

/** Whether the page holds this press down until its release. The server sends
 * shortcuts and discrete keys as one whole press instead, and macOS sends no
 * key-up for a key let go while Cmd is down: counting those as held would
 * block the hand-back until the window loses focus. */
function heldUntilReleased(input: Body): boolean {
  if (input.type !== "input_keyboard") return true;
  const key = String(input.key);
  if (MODIFIER_KEYS.has(key)) return true;
  if (DISCRETE_KEYS.has(key)) return false;
  return !input.modifiers || (input.modifiers === 8 && [...key].length === 1);
}

/** The server's take reply says whether the grant waited for the bot's action. */
const waitedForBot = (reply: unknown) => (reply as { waited?: unknown } | null | undefined)?.waited === true;

/** Control without a button, for one live-view connection. The first real
 * interaction takes the browser from the bot and waits, with everything after
 * it, until the server grants the lease; then it all goes through in order,
 * unless the bot's own action finished first: the page may have moved, so
 * clicks and keys aimed at it are dropped instead. Idle hands it back. The
 * server lease still never lets person and bot input interleave, and nothing
 * is handed back while a key or button is held down: the server would then
 * require a browser restart. */
export function createBrowserControl(options: {
  queue: Pick<ReturnType<typeof createBrowserInputQueue>, "enqueue" | "drain" | "settle" | "size" | "stopped">;
  /** Resolves with the server's reply; `waited: true` means the bot's own
   * browser action finished before the grant. */
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
  let status: BrowserTakeStatus = "";
  let buffer: BrowserInteraction[] = [];
  let flushing = false;
  let closed = false;
  // The typing dialog is open: its text is for the field the person picked.
  let pinned = false;
  // Hand back as soon as nothing blocks it, not after the idle wait.
  let soon = false;
  let activity = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let notice: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<string>();
  // Presses dropped as stale: the page never got them, so it gets no release.
  const dropped = new Set<string>();

  const report = (next: BrowserTakeStatus) => { status = next; options.onTakeStatus(next); };
  const track = (input: Body) => {
    if (isPress(input) && heldUntilReleased(input)) held.add(inputId(input));
    else if (isRelease(input)) held.delete(inputId(input));
  };
  const quiet = () => !closed && !pinned && !flushing && !held.size && !options.busy()
    && (state === "held" || (state === "bot" && options.owned()));
  const arm = () => {
    clearTimeout(idle);
    idle = closed ? undefined : setTimeout(() => { idle = undefined; void idleHandBack(); }, soon ? 0 : BROWSER_HAND_BACK_MS);
  };
  const release = () => {
    state = "releasing";
    if (status === "stale") report("");
    chain = chain.then(() => closed ? undefined : options.release()).catch(() => {})
      .then(() => { if (state === "releasing") state = "bot"; });
  };
  const idleHandBack = async () => {
    if (!quiet()) return; // whatever blocks it re-arms the timer when it ends
    const seen = activity;
    await options.queue.drain(); // every key-up and button-up lands first
    if (seen === activity && quiet()) release();
  };
  /** The grant waited for the bot's own action, so the page may have changed
   * since the person aimed: drop their page input and the toolbar actions that
   * depend on the page, rather than land them somewhere else. Returns whether
   * anything the person meant was lost. */
  const dropStale = () => {
    const kept = buffer.filter((item) => "command" in item && ABSOLUTE_COMMANDS.has(String(item.command.type)));
    const lost = buffer.some((item) => !kept.includes(item) && startsInteraction(item));
    buffer = kept;
    for (const id of held) dropped.add(id);
    held.clear();
    return lost;
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
    report("pending");
    clearTimeout(notice);
    notice = setTimeout(() => { if (!closed && state === "taking") report("slow"); }, BROWSER_TAKE_NOTICE_MS);
    chain = chain.then(async () => {
      if (closed) return;
      const grant = await options.take().then((reply) => ({ reply }), (cause: unknown) => {
        if (!closed) options.onError(cause instanceof Error ? cause.message : String(cause));
        return null;
      });
      clearTimeout(notice);
      if (closed) return;
      if (grant) {
        state = "held";
        report(waitedForBot(grant.reply) && dropStale() ? "stale" : "");
        await flush();
      } else { report(""); state = "bot"; buffer = []; held.clear(); }
      arm(); // a refused take can still leave this viewer holding the browser
    }).catch(() => {});
  };

  return {
    interact(item: BrowserInteraction) {
      if (closed) return;
      if ("input" in item) {
        const id = inputId(item.input);
        if (isRelease(item.input) && dropped.delete(id)) return;
        if (isPress(item.input)) dropped.delete(id); // a new press is the page's again
      }
      const waiting = state === "taking" || flushing;
      if (state !== "held" && !waiting) {
        if (!startsInteraction(item)) return;
        // Halted input is dropped; taking control for it would only pause the bot.
        if ("input" in item && options.queue.stopped()) { options.onHalted(); return; }
      }
      // One toolbar action at a time, as while an action runs: clicking Back
      // again during a slow take must not go back two pages.
      if ("command" in item && waiting && buffer.some((queued) => "command" in queued)) return;
      if (startsInteraction(item)) {
        soon = false;
        if (status === "stale") report("");
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
    /** Hand back without the idle wait (the person is switching profiles), as
     * soon as nothing is held down, unsent or running. */
    handBack() { if (!closed) { soon = true; arm(); } },
    /** While the typing dialog is open, keep control: its text is meant for
     * the field the person picked. Closing it starts the idle wait again. */
    hold(on: boolean) {
      if (closed || pinned === on) return;
      pinned = on;
      if (!on) arm();
    },
    /** The panel is closing: hand back now, unless input is held or unsent.
     * The server's own disconnect cleanup handles those. */
    leave() {
      if (!quiet() || options.queue.size()) return;
      state = "releasing";
      void options.release().catch(() => {});
    },
    close() { closed = true; clearTimeout(idle); clearTimeout(notice); buffer = []; held.clear(); dropped.clear(); },
  };
}
