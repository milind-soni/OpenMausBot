// One bot browser never takes a Linux server's memory. Each running browser (agent-browser's daemon and its Chrome) is
// measured by proportional set size, shared pages counted once: a sum of RSS over Chrome's 10 to 30 processes counts
// the browser binary's pages in every one of them. Over its soft line, between calls, its background tabs close and the
// bot hears which on its next call. Over its hard line it is closed through memory relief's own close, which keeps a
// browser a turn holds, one a call runs in, and one attached to the person's own Chrome, except while memory available is
// under relief's floor: then it is closed whatever holds it, and the turn holding it ends saying so. A large browser on a
// machine with memory to spare is never closed for its size alone. A 2 GB Cloud with no swap went from a 1.3 GB browser
// kept open to frozen in under two minutes (Nov 2026): the machine thrashed on its page cache and the server, which holds
// every guard, could no longer run.
import { readFileSync } from "node:fs";

const MB = 1_048_576;
export const CEILING_TICK_MS = 15_000;
/** While a browser is over its soft line and memory available is under twice relief's floor, the next look comes this
 * soon instead: a Starter with an ordinary 700–900 MB browser and memory to spare is looked at no more often. */
export const CEILING_FAST_TICK_MS = 3_000;
/** Linux's page size on the machines a Cloud runs on (x86-64): /proc/<pid>/statm counts pages. */
const PAGE_BYTES = 4096;
/** A browser's tabs are closed at most this often, and a refused close is logged at most this often. */
const ACT_EVERY_MS = 60_000;
/** A process lost since the last look smaller than this was not the kernel's victim at the browsers' limit: Chrome swaps
 * small renderers on every navigation. */
const VICTIM_MIN_BYTES = 50 * MB;

export interface CeilingLines { softBytes: number; hardBytes: number }

/** A third of the memory (at least 600 MB) and half of it (at least 900 MB): a 2 GB home's are 683 and 1024 MB. */
export function ceilingLines(memoryBytes: number): CeilingLines {
  return { softBytes: Math.max(600 * MB, Math.round(memoryBytes / 3)), hardBytes: Math.max(900 * MB, Math.round(memoryBytes / 2)) };
}

/** `daemon`: agent-browser's own process, the root of `pids`; the rest are its Chrome's. `started`: each pid's start time
 * when it was listed (browser-processes.ts), so a pid the system has since given to another program is never signalled. */
export interface CeilingBrowser { session: string; pids: readonly number[]; daemon?: number; started?: ReadonlyMap<number, string> }

/** Whether a browser this size is closed even while a turn holds it or a call runs in it: over its hard line with memory
 * available (not counting swap) under relief's floor. Never for its size alone, however large next to the machine. */
export function mustForceClose(usedBytes: number, lines: CeilingLines, memoryShort: boolean): boolean {
  return memoryShort && usedBytes >= lines.hardBytes;
}

type Read = (path: string) => string;
const readText: Read = (path) => readFileSync(path, "utf8");

/** A browser's size from /proc/<pid>/statm, which takes no lock on the process's memory map (smaps_rollup does, and under
 * memory pressure a read of it can wait as long as the process does): each process's own pages, and the largest share
 * of file and shared pages once, as they are mostly Chrome's one binary. Null where none could be read. */
export function statmBytes(pids: readonly number[], read: Read = readText): number | null {
  let own = 0, shared = 0, counted = 0;
  for (const pid of pids) {
    let fields: number[];
    try { fields = read(`/proc/${pid}/statm`).trim().split(/\s+/).map(Number); } catch { continue; }
    const [, resident, file] = fields;
    if (!Number.isFinite(resident) || !Number.isFinite(file)) continue;
    own += Math.max(0, resident! - file!); shared = Math.max(shared, file!); counted += 1;
  }
  return counted ? (own + shared) * PAGE_BYTES : null;
}

/** SIGKILLs a browser's Chrome processes (never its daemon), each only while its pid still runs the process that was
 * listed: its start time (field 22 of /proc/<pid>/stat) is read again just before. How many were signalled. */
export function killChrome(browser: CeilingBrowser, read: Read = readText, kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => { process.kill(pid, signal); }): number {
  let killed = 0;
  for (const pid of browser.pids) {
    if (pid === browser.daemon || pid <= 1 || pid === process.pid) continue;
    let stat: string;
    try { stat = read(`/proc/${pid}/stat`); } catch { continue; }
    // pid (comm) state ppid … starttime: comm may hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") continue;
    const listed = browser.started?.get(pid);
    if (listed === undefined || listed === "" || fields[19] !== listed) continue;
    try { kill(pid, "SIGKILL"); killed += 1; } catch {}
  }
  return killed;
}

/** Looks with `tick` every `slowMs`, and after a look that asks for a sooner one, `fastMs` later. */
export function startCeilingLoop(tick: () => Promise<boolean>, options: { fastMs?: number; slowMs?: number } = {}): { stop(): void } {
  const fastMs = options.fastMs ?? CEILING_FAST_TICK_MS, slowMs = options.slowMs ?? CEILING_TICK_MS;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const next = (soon: boolean) => {
    if (stopped) return;
    timer = setTimeout(() => void tick().then(next, () => next(false)), soon ? fastMs : slowMs);
    timer.unref?.();
  };
  next(false);
  return { stop() { stopped = true; clearTimeout(timer); } };
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
  /** Memory available, not counting swap, is under relief's floor now (`times` the floor, where given). */
  memoryShort?(times?: number): boolean;
  /** A browser's size read without taking its memory map's lock (statmBytes): used while memory is short. */
  quickSize?(pids: readonly number[]): number | null;
  /** Closes the browser now whatever holds it: the turn holding it ends with the line that the browser was closed for
   * memory, and its Chrome's processes are stopped at once. False when it could not. */
  forceClose?(browser: CeilingBrowser, usedBytes: number): Promise<boolean>;
  /** The kernel's count of processes it killed at the browsers' memory limit (memory-cgroup.ts); null where there is none. */
  kernelKills?(): number | null;
  /** Puts this browser's Chrome under the browsers' memory limit where it is not yet (one started outside the launcher). */
  contain?(browser: CeilingBrowser): void;
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

type Seen = { browser: CeilingBrowser; used: number; each: Map<number, number> };

export function createBrowserCeiling(deps: BrowserCeilingDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const notes = new Map<string, string>();
  const acted = new Map<string, number>();
  let running = false;
  /** Each browser as the last look found it, with each process's size, and the kernel's kill count then. */
  let seen = new Map<string, Seen>();
  let kills: number | null = null, unexplained = false;

  /** A browser's size, and each of its processes' where a kernel kill may need to be explained (kernelKills). With memory
   * short, from statm (quickSize), which takes no lock. */
  function measure(browser: CeilingBrowser, short: boolean): { used: number | null; each: Map<number, number> } {
    const each = new Map<number, number>();
    const quick = short && deps.quickSize ? deps.quickSize : null;
    if (quick) {
      if (deps.kernelKills) for (const pid of browser.pids) { const bytes = quick([pid]); if (bytes !== null) each.set(pid, bytes); }
      return { used: quick(browser.pids), each };
    }
    for (const pid of browser.pids) {
      const bytes = deps.pss(pid);
      if (bytes !== null) each.set(pid, bytes);
    }
    return { used: each.size ? [...each.values()].reduce((sum, bytes) => sum + bytes, 0) : null, each };
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

  /** Whether the browser is over its soft line. `short`: memory available is under relief's floor. */
  async function check(browser: CeilingBrowser, short: boolean, looked: Map<string, Seen>): Promise<boolean> {
    const { used, each } = measure(browser, short);
    const { session } = browser;
    if (used !== null) looked.set(session, { browser, used, each });
    if (used === null || used < deps.lines.softBytes) return false;
    const at = now();
    // Ahead of the minute between actions: a refused close must not keep a growing browser from this for a minute.
    if (deps.forceClose && mustForceClose(used, deps.lines, short) && await deps.forceClose(browser, used).catch(() => false)) {
      acted.set(session, at);
      log(`browser ${session}: ${mb(used)} MB, over its hard line of ${mb(deps.lines.hardBytes)} MB with memory short; closed it at once, with the turn that held it, if any`);
      return true;
    }
    await act(browser, used, at);
    return true;
  }

  /** The kernel killed at the browsers' limit since the last look. Its victim is about the largest process in the group, and
   * Chrome loses small renderers all the time (a navigation, a closed tab): the browser whose largest lost process was the
   * largest is closed, and the turn that held it ends with the line that the browser was closed for memory. Nothing is
   * closed when no process lost since was large enough to be the victim; the next look tries again. */
  async function afterKernelKill(browsers: readonly CeilingBrowser[]): Promise<boolean> {
    const found = new Map(browsers.map((browser) => [browser.session, browser]));
    let hit: Seen | null = null, victim = 0;
    for (const before of seen.values()) {
      const pids = new Set(found.get(before.browser.session)?.pids ?? []);
      for (const [pid, bytes] of before.each) {
        if (pid === before.browser.daemon || pids.has(pid) || bytes <= victim) continue;
        hit = before; victim = bytes;
      }
    }
    if (!hit || victim < VICTIM_MIN_BYTES || !deps.forceClose) return false;
    const { session } = hit.browser;
    const current = found.get(session) ?? { session, pids: [], ...(hit.browser.daemon === undefined ? {} : { daemon: hit.browser.daemon }) };
    if (await deps.forceClose(current, hit.used).catch(() => false)) {
      acted.set(session, now());
      log(`browser ${session}: the kernel stopped a ${mb(victim)} MB process of it at the browsers' memory limit (${mb(hit.used)} MB at the last look); closed it, with the turn that held it, if any`);
    }
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
    /** One look at every browser; true when the next should come sooner (CEILING_FAST_TICK_MS): a browser is over its soft
     * line and memory available is under twice relief's floor. */
    async tick(): Promise<boolean> {
      if (running) return false;
      running = true;
      let large = false;
      try {
        const browsers = await deps.browsers();
        const live = new Set(browsers.map((browser) => browser.session));
        for (const session of acted.keys()) if (!live.has(session)) acted.delete(session);
        const killed = deps.kernelKills?.() ?? null;
        // A kill no lost process explains yet (its victim not reaped at this look) is looked for once more, then let go.
        if (killed !== null && kills !== null && killed > kills && !await afterKernelKill(browsers).catch(() => false) && !unexplained) unexplained = true;
        else { kills = killed ?? kills; unexplained = false; }
        const short = deps.memoryShort?.() ?? false;
        const looked = new Map<string, Seen>();
        for (const browser of browsers) {
          try { deps.contain?.(browser); } catch {}
          if (await check(browser, short, looked).catch(() => false)) large = true;
        }
        // The look before the kill is kept while one is unexplained: its sizes are what the victim is found by.
        if (!unexplained) seen = looked;
      } finally { running = false; }
      return large && (deps.memoryShort?.(2) ?? false);
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
