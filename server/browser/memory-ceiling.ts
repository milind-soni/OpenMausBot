// One bot browser never takes a Linux server's memory. Each running browser (agent-browser's daemon and its Chrome) is
// measured by proportional set size, shared pages counted once: a sum of RSS over Chrome's 10 to 30 processes counts
// the browser binary's pages in every one of them. Over its soft line, between calls, its background tabs close and the
// bot hears which on its next call. Over its hard line it is closed only through memory relief's own close, which keeps
// a browser a turn holds, one a call runs in, and one attached to the person's own Chrome.

const MB = 1_048_576;
export const CEILING_TICK_MS = 15_000;
/** A browser's tabs are closed at most this often, and a refused close is logged at most this often. */
const ACT_EVERY_MS = 60_000;

export interface CeilingLines { softBytes: number; hardBytes: number }

/** A third of the memory (at least 600 MB) and half of it (at least 900 MB): a 2 GB home's are 683 and 1024 MB. */
export function ceilingLines(memoryBytes: number): CeilingLines {
  return { softBytes: Math.max(600 * MB, Math.round(memoryBytes / 3)), hardBytes: Math.max(900 * MB, Math.round(memoryBytes / 2)) };
}

export interface CeilingBrowser { session: string; pids: readonly number[] }
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

  async function check(browser: CeilingBrowser): Promise<void> {
    const used = size(browser);
    const { session } = browser;
    if (used === null || used < deps.lines.softBytes) return;
    const at = now();
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
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        const browsers = await deps.browsers();
        const live = new Set(browsers.map((browser) => browser.session));
        for (const session of acted.keys()) if (!live.has(session)) acted.delete(session);
        for (const browser of browsers) await check(browser).catch(() => undefined);
      } finally { running = false; }
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
