import type { PreviewStreamClient, PreviewStreamControl, PreviewStreamInput } from "./browser-stream-client";

export type BrowserTakeStatus = "" | "pending" | "slow" | "stale";

/** How a viewer's input reaches the browser: v2 sends at once, v1 one request at a time. */
export interface ControlTransport {
  send(input: PreviewStreamInput): void;
  /** Drops queued movement and waits for the rest. */
  drain(): Promise<void>;
  settle(): Promise<void>;
  size(): number;
  /** v1 stops taking input once the browser falls behind it. */
  stopped(): boolean;
  /** Resolves once this viewer holds the browser; `waited` when bot work was running then. */
  take(): Promise<{ waited: boolean } | void>;
  release(): Promise<void>;
}

export const BROWSER_HAND_BACK_MS = 8_000;
export const BROWSER_TAKE_NOTICE_MS = 300;
/** The server drains bot work for up to 15 s before a person's takeover. */
const TAKE_TIMEOUT_MS = 20_000;
// The v1 queue halts beyond 32 unsent inputs, and a slow take can buffer more.
const FLUSH_BATCH = 16;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
const DISCRETE_KEYS = new Set(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const COMMANDS = new Set<PreviewStreamInput["type"]>(["navigate", "history", "reload", "tabSelect", "tabNew", "tabClose"]);
const ABSOLUTE_COMMANDS = new Set<PreviewStreamInput["type"]>(["navigate", "tabNew"]);

function startsInteraction(input: PreviewStreamInput): boolean {
  if (COMMANDS.has(input.type)) return true;
  if (input.type === "mouse") return input.action === "down";
  if (input.type === "key") return input.action === "down" && !MODIFIER_KEYS.has(input.key);
  return input.type === "wheel" || input.type === "text";
}

const inputId = (input: PreviewStreamInput) => input.type === "key" ? `key:${input.code || input.key}` : input.type === "mouse" ? `mouse:${input.button}` : input.type;
const isPress = (input: PreviewStreamInput) => (input.type === "key" || input.type === "mouse") && input.action === "down";
const isRelease = (input: PreviewStreamInput) => (input.type === "key" || input.type === "mouse") && input.action === "up";

/** macOS sends no key-up for a key let go while Cmd is down, so those never count as held. */
function heldUntilReleased(input: PreviewStreamInput): boolean {
  if (input.type !== "key") return true;
  if (MODIFIER_KEYS.has(input.key)) return true;
  if (DISCRETE_KEYS.has(input.key)) return false;
  return !input.modifiers || (input.modifiers === 8 && [...input.key].length === 1);
}

/**
 * A person's input takes the browser on its first press and hands it back after a few idle seconds, unless they keep
 * it. Never hands back while a key or button is held down: the server would then need a browser restart.
 */
export function createBrowserControl(options: {
  transport: ControlTransport;
  /** This view's input runs now. */
  owned: () => boolean;
  /** The person holds the browser, from this view or another of theirs. */
  mine?: () => boolean;
  onTakeStatus: (status: BrowserTakeStatus) => void;
  onError: (message: string) => void;
  onHalted: () => void;
}) {
  const transport = options.transport;
  let state: "bot" | "taking" | "held" | "releasing" = "bot";
  let status: BrowserTakeStatus = "";
  let buffer: PreviewStreamInput[] = [];
  let flushing = false;
  let closed = false;
  let pinned = false;
  let kept = false;
  let soon = false;
  let ownedBefore = false;
  let activity = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let notice: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<string>();
  const dropped = new Set<string>();

  const report = (next: BrowserTakeStatus) => { status = next; options.onTakeStatus(next); };
  const track = (input: PreviewStreamInput) => {
    if (isPress(input) && heldUntilReleased(input)) held.add(inputId(input));
    else if (isRelease(input)) held.delete(inputId(input));
  };
  const quiet = () => !closed && !pinned && (soon || !kept) && !flushing && !held.size
    && (state === "held" || (state === "bot" && options.owned()));
  const arm = () => {
    clearTimeout(idle);
    idle = closed ? undefined : setTimeout(() => { idle = undefined; void idleHandBack(); }, soon ? 0 : BROWSER_HAND_BACK_MS);
  };
  const release = () => {
    state = "releasing";
    if (status === "stale") report("");
    chain = chain.then(() => closed ? undefined : transport.release()).catch(() => {})
      .then(() => { if (state === "releasing") state = "bot"; });
  };
  const idleHandBack = async () => {
    if (!quiet()) return;
    const seen = activity;
    await transport.drain();
    if (seen === activity && quiet()) release();
  };
  /** The bot was busy when the person asked: what they did meanwhile aimed at a page that may have changed. */
  const dropStale = () => {
    const keep = buffer.filter((input) => ABSOLUTE_COMMANDS.has(input.type));
    const lost = buffer.some((input) => !keep.includes(input) && startsInteraction(input));
    buffer = keep;
    for (const id of held) dropped.add(id);
    held.clear();
    return lost;
  };
  const flush = async () => {
    flushing = true;
    try {
      for (let input = buffer.shift(); input && !closed; input = buffer.shift()) {
        transport.send(input);
        if (transport.size() >= FLUSH_BATCH) await transport.settle();
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
      const grant = await transport.take().then((reply) => ({ reply }), (cause: unknown) => {
        if (!closed) options.onError(cause instanceof Error ? cause.message : String(cause));
        return null;
      });
      clearTimeout(notice);
      if (closed) return;
      if (grant) {
        state = "held";
        report(grant.reply?.waited === true && dropStale() ? "stale" : "");
        await flush();
      } else { report(""); state = "bot"; buffer = []; held.clear(); }
      arm();
    }).catch(() => {});
  };

  return {
    interact(input: PreviewStreamInput) {
      if (closed) return;
      const id = inputId(input);
      if (isRelease(input) && dropped.delete(id)) return;
      if (isPress(input)) dropped.delete(id);
      const waiting = state === "taking" || flushing;
      if (state !== "held" && !waiting) {
        if (!startsInteraction(input)) return;
        if (transport.stopped() && !COMMANDS.has(input.type)) { options.onHalted(); return; }
      }
      if (COMMANDS.has(input.type) && waiting && buffer.some((queued) => COMMANDS.has(queued.type))) return;
      if (startsInteraction(input)) {
        soon = false;
        if (status === "stale") report("");
      }
      track(input);
      activity++;
      arm();
      if (state === "held" && !waiting) {
        transport.send(input);
        return;
      }
      buffer.push(input);
      if (!waiting) take();
    },
    observe() {
      if (closed) return;
      const owned = options.owned();
      if (ownedBefore && !owned && state === "held" && !flushing) {
        state = "bot"; held.clear(); dropped.clear(); clearTimeout(idle); idle = undefined;
      }
      ownedBefore = owned;
      if (idle === undefined && owned) arm();
    },
    takeControl() {
      if (closed || state === "held" || state === "taking" || flushing) return;
      soon = false;
      take();
    },
    keep(on: boolean) {
      if (closed || kept === on) return;
      kept = on;
      if (!on) arm();
    },
    handBack() {
      if (closed) return;
      // Their hold is used from another view of theirs: this one has nothing of its own to send first.
      if (state === "bot" && !options.owned() && options.mine?.()) { release(); return; }
      soon = true;
      arm();
    },
    hold(on: boolean) {
      if (closed || pinned === on) return;
      pinned = on;
      if (!on) arm();
    },
    leave() {
      if (!quiet() || transport.size()) return;
      state = "releasing";
      void transport.release().catch(() => {});
    },
    close() { closed = true; clearTimeout(idle); clearTimeout(notice); buffer = []; held.clear(); dropped.clear(); },
  };
}

export type BrowserControl = ReturnType<typeof createBrowserControl>;

/**
 * The v2 stream as a control transport: input goes out at once, and a take resolves when the server says this viewer
 * controls the browser, which happens only once any running bot work has drained.
 */
export function streamTransport(client: PreviewStreamClient, control: {
  current(): PreviewStreamControl | null;
  /** Calls `listener` with every control message until the returned function is called. */
  watch(listener: (control: PreviewStreamControl | null) => void): () => void;
}, heldElsewhere: string): ControlTransport {
  return {
    send: (input) => { client.send(input); },
    drain: async () => {},
    settle: async () => {},
    size: () => 0,
    stopped: () => false,
    take: () => new Promise((resolve, reject) => {
      const before = control.current();
      if (before?.controller === "you") { resolve({ waited: false }); return; }
      if (!client.send({ type: "takeControl" })) { reject(new Error("The browser view is not connected. Reconnect it, then try again.")); return; }
      const waited = before?.controller === "agent";
      const done = (outcome: () => void) => { clearTimeout(timer); unwatch(); outcome(); };
      const timer = setTimeout(() => done(() => reject(new Error("Could not take control of the browser. Try again shortly."))), TAKE_TIMEOUT_MS);
      const unwatch = control.watch((next) => {
        if (next?.controller === "you") done(() => resolve({ waited }));
        else if (next?.controller === "another-viewer") done(() => reject(new Error(heldElsewhere)));
        else if (next === null) done(() => reject(new Error("The browser view disconnected.")));
      });
    }),
    release: async () => { client.send({ type: "releaseControl" }); },
  };
}
