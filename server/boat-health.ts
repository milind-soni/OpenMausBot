/** Whether each cloud computer still answers its commands. A failed command is only a suspicion: it starts one short probe,
 * and only probes count, so a command that itself runs long, or one slow answer, never marks a computer dead. */
export const DEAD_COMPUTER = {
  /** Probes in a row that got no answer (a gateway error or no reply at all). */
  failures: 3,
  /** From the first such probe to the last: a burst of failures inside one minute is a blip, not a dead machine. */
  spanMs: 60_000,
  /** Probes are at least this far apart, however many commands fail. */
  probeGapMs: 20_000,
  /** A probe runs `true`; a live machine answers it in well under a second. */
  probeTimeoutMs: 45_000,
  /** Not responding for this long, with a restart already tried, before the computer is replaced. */
  replaceAfterMs: 10 * 60_000,
  /** A computer that answered any command this recently is never deleted. */
  answeredGraceMs: 5 * 60_000,
  /** Another computer of this installation answered this recently: the provider itself is up. */
  witnessMs: 10 * 60_000,
  /** At most this many automatic replacements per computer owner in an hour; after that it stops and says so. */
  replacementsPerHour: 1,
  /** A computer still not answering is reported again at most this often. */
  reportGapMs: 5 * 60_000,
} as const;

/** 502 and 504 are a gateway that could not reach the machine, 520–524 the same behind a CDN. 503 is left out: the Cloud's
 * relay answers it for an account-wide refusal, which says nothing about one machine. */
export const unansweredStatus = (status: number): boolean => status === 502 || status === 504 || (status >= 520 && status <= 524);

interface BoxHealth {
  /** Probes in a row that got no answer, the first and last of them. */
  failures: number;
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  lastAnsweredAt: number | null;
  probing: boolean;
  lastProbeAt: number;
  reportedAt: number | null;
}

export type NotRespondingListener = (boxId: string, since: number) => void;

export function createBoatHealth(now: () => number = Date.now) {
  const boxes = new Map<string, BoxHealth>();
  const listeners = new Set<NotRespondingListener>();
  const entry = (boxId: string): BoxHealth => {
    let found = boxes.get(boxId);
    if (!found) boxes.set(boxId, found = { failures: 0, firstFailureAt: null, lastFailureAt: null, lastAnsweredAt: null, probing: false, lastProbeAt: -Infinity, reportedAt: null });
    return found;
  };
  const notResponding = (health: BoxHealth | undefined): health is BoxHealth & { firstFailureAt: number; lastFailureAt: number } =>
    Boolean(health && health.failures >= DEAD_COMPUTER.failures && health.firstFailureAt !== null && health.lastFailureAt !== null
      && health.lastFailureAt - health.firstFailureAt >= DEAD_COMPUTER.spanMs);

  function answered(boxId: string): void {
    const health = entry(boxId);
    Object.assign(health, { failures: 0, firstFailureAt: null, lastFailureAt: null, lastAnsweredAt: now(), reportedAt: null });
  }

  function unanswered(boxId: string): void {
    const health = entry(boxId), at = now();
    health.failures += 1;
    health.firstFailureAt ??= at;
    health.lastFailureAt = at;
    if (!notResponding(health) || (health.reportedAt !== null && at - health.reportedAt < DEAD_COMPUTER.reportGapMs)) return;
    health.reportedAt = at;
    for (const listener of listeners) listener(boxId, health.firstFailureAt!);
  }

  /** A command to this computer got no answer: probe it once, unless a probe is under way or ran moments ago. */
  function suspect(boxId: string, probe: () => Promise<boolean>): void {
    const health = entry(boxId);
    if (health.probing || now() - health.lastProbeAt < DEAD_COMPUTER.probeGapMs) return;
    health.probing = true;
    health.lastProbeAt = now();
    void probe().catch(() => false).then((ok) => {
      health.probing = false;
      if (boxes.get(boxId) !== health) return;
      if (ok) answered(boxId); else unanswered(boxId);
    });
  }

  return {
    answered,
    unanswered,
    suspect,
    /** Since when this computer has not answered, once it counts as not responding; null while it answers. */
    notRespondingSince: (boxId: string): number | null => {
      const health = boxes.get(boxId);
      return notResponding(health) ? health.firstFailureAt : null;
    },
    answeredWithin: (boxId: string, ms: number): boolean => {
      const at = boxes.get(boxId)?.lastAnsweredAt;
      return at !== null && at !== undefined && now() - at <= ms;
    },
    /** Some other computer answered recently, so the provider and the path to it work. */
    otherAnsweredWithin: (boxId: string, ms: number): boolean =>
      [...boxes].some(([id, health]) => id !== boxId && health.lastAnsweredAt !== null && now() - health.lastAnsweredAt <= ms),
    onNotResponding(listener: NotRespondingListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forget: (boxId: string) => { boxes.delete(boxId); },
    clear: () => boxes.clear(),
  };
}

export type BoatHealth = ReturnType<typeof createBoatHealth>;

export const boatHealth = createBoatHealth();
