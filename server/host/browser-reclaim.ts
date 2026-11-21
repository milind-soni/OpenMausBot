// Which bot browsers memory relief may close before their idle time is up (engine-memory.ts `reclaimUnused`), and asking
// them. Never one a turn holds, one a call runs in, or one attached to the person's own Chrome. Under ordinary shortage
// also never one a person is watching, one of a bot with a turn running that hasn't used it yet this turn (claims are
// made on first use), or one whose close would lose its sign-ins (a guest or temporary browser). Once the machine
// thrashes those go too: the restart that otherwise follows closes every one of them.

export interface ReclaimCandidate {
  session: string;
  /** A turn holds it (its claim), or a call runs in it now. */
  held: boolean;
  working: boolean;
  running: boolean;
  /** It is attached to the person's own Chrome, or is the person's Chrome engine: never closed here. */
  attached: boolean;
  /** Someone is watching it live. */
  watched: boolean;
  /** A bot with a turn running now uses it. */
  turnRunning: boolean;
  /** Its sign-ins are saved when it closes. */
  savesSignIns: boolean;
}

export function reclaimable(candidate: ReclaimCandidate, thrashing: boolean): boolean {
  if (!candidate.running || candidate.held || candidate.working || candidate.attached) return false;
  if (thrashing) return true;
  return !candidate.watched && !candidate.turnRunning && candidate.savesSignIns;
}

/** A browser asked to close this recently is not counted again, whether its close failed or still runs. */
export const RECLAIM_ASK_MS = 60_000;

export interface BrowserReclaimDeps {
  /** Every browser this server started, given the threads with a turn running now. */
  candidates(busy: readonly string[]): ReclaimCandidate[];
  /** Closes it; true once it is gone. */
  close(session: string): Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
}

export function createBrowserReclaim(deps: BrowserReclaimDeps) {
  const asked = new Map<string, number>();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  return {
    /** Asks every browser that may go now to close; how many it asked. */
    reclaim(pressure: { thrashing: boolean; busy: readonly string[] }): number {
      const at = now();
      for (const [session, when] of asked) if (at - when >= RECLAIM_ASK_MS) asked.delete(session);
      let count = 0;
      for (const candidate of deps.candidates(pressure.busy)) {
        if (asked.has(candidate.session) || !reclaimable(candidate, pressure.thrashing)) continue;
        asked.set(candidate.session, at);
        count += 1;
        void deps.close(candidate.session).then((closed) => {
          if (closed) log(`browser ${candidate.session}: closed to free memory, no task was using it`);
        }, () => undefined);
      }
      return count;
    },
    /** Sessions asked within RECLAIM_ASK_MS: for tests. */
    asked: () => [...asked.keys()],
  };
}
