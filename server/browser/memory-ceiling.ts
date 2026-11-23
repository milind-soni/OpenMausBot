// One bot browser never takes a Linux server's memory. Each running browser (agent-browser's daemon and its Chrome) is
// measured by proportional set size, shared pages counted once: a sum of RSS over Chrome's 10 to 30 processes counts
// the browser binary's pages in every one of them. Over its soft line, between calls, its background tabs close and the
// bot hears which on its next call. Over its hard line it is closed through memory relief's own close, which keeps a
// browser a turn holds, one a call runs in, and one attached to the person's own Chrome. Two cases close it anyway, turn
// or not: over its hard line while memory available is under relief's floor, and a quarter or more over its hard line.
// A 2 GB Cloud with no swap went from a 1.3 GB browser kept open to 30 minutes frozen in under two minutes (Nov 2026):
// the machine thrashed on its page cache and the server, which holds every guard, could no longer run.

const MB = 1_048_576;
export const CEILING_TICK_MS = 15_000;
/** While a browser is over its soft line it is looked at this often instead: no browser that large, no faster look. */
export const CEILING_FAST_TICK_MS = 3_000;
/** This far over its hard line, a browser is closed whatever holds it, with memory short or not. */
export const FORCE_OVER = 1.25;
/** A browser's tabs are closed at most this often, and a refused close is logged at most this often. */
const ACT_EVERY_MS = 60_000;

export interface CeilingLines { softBytes: number; hardBytes: number }

/** A third of the memory (at least 600 MB) and half of it (at least 900 MB): a 2 GB home's are 683 and 1024 MB. */
export function ceilingLines(memoryBytes: number): CeilingLines {
  return { softBytes: Math.max(600 * MB, Math.round(memoryBytes / 3)), hardBytes: Math.max(900 * MB, Math.round(memoryBytes / 2)) };
}

/** `daemon`: agent-browser's own process, the root of `pids`; the rest are its Chrome's. */
export interface CeilingBrowser { session: string; pids: readonly number[]; daemon?: number }

/** Whether a browser this size is closed even while a turn holds it or a call runs in it: over its hard line with memory
 * available (not counting swap) under relief's floor, or a quarter or more over its hard line. Never on size alone below
 * that, however large it is next to the machine. */
export function mustForceClose(usedBytes: number, lines: CeilingLines, memoryShort: boolean): boolean {
  return usedBytes >= lines.hardBytes && (memoryShort || usedBytes >= lines.hardBytes * FORCE_OVER);
}
export interface CeilingTab { tabId: string; title: string; url: string; active: boolean }

export interface BrowserCeilingDeps {
  lines: CeilingLines;
  /** Running browsers this server started, never one attached to the person's own Chrome, each with its process tree. */
  browsers(): Promise<CeilingBrowser[]>;
  pss(pid: number): number | null;
  /** No call runs in it and no person holds it, so its tabs may change now. */
  quiet(session: string): boolean;
  tabs(session: string): Promise<CeilingTab[] | null>;
  closeTab(session: string, tabId: string): Promise<boolean>;
  /** Memory relief's close; false when its rules keep the browser open. */
  close(session: string): Promise<boolean>;
  /** Memory available, not counting swap, is under relief's floor now. */
  memoryShort?(): boolean;
  /** Closes the browser now whatever holds it: the turn holding it ends with the line that the browser was closed for
   * memory, and its Chrome's processes are stopped at once. False when it could not. */
  forceClose?(browser: CeilingBrowser, usedBytes: number): Promise<boolean>;
  log?(line: string): void;
  now?(): number;
}

const mb = (bytes: number) => Math.round(bytes / MB);

function page(tab: CeilingTab): string {
  const title = tab.title.trim().slice(0, 80);
  return title ? `${title} (${tab.url})` : tab.url;
}

export function tabsClosedNote(usedBytes: number, closed: readonly CeilingTab[]): string {
  return `This browser was using ${mb(usedBytes)} MB of this computer's memory, so its other tabs were closed to keep everything else running: ${closed.map(page).join("; ")}. Open one again if you still need it. Earlier @eN refs are gone: take a new snapshot before acting.`;
}

export function createBrowserCeiling(deps: BrowserCeilingDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const notes = new Map<string, string>();
  const acted = new Map<string, number>();
  let running = false;

  function size(browser: CeilingBrowser): number | null {
    let total = 0, read = 0;
    for (const pid of browser.pids) {
      const bytes = deps.pss(pid);
      if (bytes === null) continue;
      total += bytes; read += 1;
    }
    return read ? total : null;
  }

  async function closeBackgroundTabs(session: string, used: number): Promise<boolean> {
    const tabs = await deps.tabs(session).catch(() => null);
    const background = tabs?.filter((tab) => !tab.active) ?? [];
    if (!tabs?.some((tab) => tab.active) || !background.length) return false;
    const closed: CeilingTab[] = [];
    for (const tab of background) {
      if (!deps.quiet(session)) break;
      if (await deps.closeTab(session, tab.tabId).catch(() => false)) closed.push(tab);
    }
    if (!closed.length) return false;
    notes.set(session, tabsClosedNote(used, closed));
    log(`browser ${session}: ${mb(used)} MB, over its soft line of ${mb(deps.lines.softBytes)} MB; closed ${closed.length} background tab(s)`);
    return true;
  }

  /** Whether the browser is over its soft line (and is looked at again soon). */
  async function check(browser: CeilingBrowser): Promise<boolean> {
    const used = size(browser);
    const { session } = browser;
    if (used === null || used < deps.lines.softBytes) return false;
    const at = now();
    // Ahead of the minute between actions: a refused close must not keep a growing browser from this for a minute.
    if (deps.forceClose && used >= deps.lines.hardBytes) {
      const short = deps.memoryShort?.() ?? false;
      if (mustForceClose(used, deps.lines, short)) {
        if (await deps.forceClose(browser, used).catch(() => false)) {
          acted.set(session, at);
          log(`browser ${session}: ${mb(used)} MB, over its hard line of ${mb(deps.lines.hardBytes)} MB ${short ? "with memory short" : `by ${Math.round((used / deps.lines.hardBytes - 1) * 100)}%`}; closed it at once, with the turn that held it, if any`);
          return true;
        }
      }
    }
    await act(browser, used, at);
    return true;
  }

  async function act(browser: CeilingBrowser, used: number, at: number): Promise<void> {
    const { session } = browser;
    if (at - (acted.get(session) ?? -Infinity) < ACT_EVERY_MS) return;
    if (used < deps.lines.hardBytes) {
      if (deps.quiet(session) && await closeBackgroundTabs(session, used)) acted.set(session, at);
      return;
    }
    acted.set(session, at);
    if (deps.quiet(session) && await closeBackgroundTabs(session, used)) return;
    if (await deps.close(session).catch(() => false)) log(`browser ${session}: ${mb(used)} MB, over its hard line of ${mb(deps.lines.hardBytes)} MB; closed it`);
    else log(`browser ${session}: ${mb(used)} MB, over its hard line of ${mb(deps.lines.hardBytes)} MB; kept open, a turn or a person is using it`);
  }

  return {
    /** One look at every browser; true when one is over its soft line, so the next look comes sooner (CEILING_FAST_TICK_MS). */
    async tick(): Promise<boolean> {
      if (running) return false;
      running = true;
      let large = false;
      try {
        const browsers = await deps.browsers();
        const live = new Set(browsers.map((browser) => browser.session));
        for (const session of acted.keys()) if (!live.has(session)) acted.delete(session);
        for (const browser of browsers) if (await check(browser).catch(() => false)) large = true;
      } finally { running = false; }
      return large;
    },
    /** What the bot is told on its next call in this browser, once. */
    takeNote(session: string): string | null {
      const note = notes.get(session) ?? null;
      notes.delete(session);
      return note;
    },
  };
}

export type BrowserCeiling = ReturnType<typeof createBrowserCeiling>;
