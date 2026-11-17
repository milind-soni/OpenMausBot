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
  /** Before a silent computer is set aside, another one must have answered a command this recently: proof that the
   * provider's command path works now, which its list answering does not give. */
  freshWitnessMs: 2 * 60_000,
  /** Without such a witness, a computer is set aside only after this long without one answer, a restart included. */
  loneSilenceMs: 30 * 60_000,
  /** And never within this long of a resume while the provider does not say whether its disk is back. */
  unknownRestoreMs: 30 * 60_000,
  /** Probes after the patience that got no answer, at least this many, spread over at least this long. */
  setAsideProbes: 3,
  setAsideProbeSpanMs: 2 * 60_000,
  /** A set-aside computer is kept, stopped with its files, this long before it is deleted. */
  setAsideKeepMs: 7 * 24 * 60 * 60_000,
  /** At most this many automatic replacements per computer owner in an hour; after that it stops and says so. */
  replacementsPerHour: 1,
  /** And in a day, so a provider that keeps handing out broken computers cannot use up the plan's computers or hours. */
  replacementsPerDay: 3,
  /** And at most this many automatic deletes per installation in an hour, whoever's computers they are. */
  installationDeletesPerHour: 1,
  /** The provider's `error` must be seen on two reads at least this far apart before a computer is deleted for it. */
  deadConfirmMs: process.env.OMB_CLOUD_COMPUTER_DEAD_CONFIRM_MS?.trim() ? Math.max(0, Number(process.env.OMB_CLOUD_COMPUTER_DEAD_CONFIRM_MS) || 0) : 30 * 60_000,
  /** At most one automatic restart per installation in this long. */
  restartGapMs: 10 * 60_000,
  /** No automatic restart or replacement while a person opened or drove the desktop this recently. */
  personGraceMs: 10 * 60_000,
  /** A computer still not answering is reported again at most this often. */
  reportGapMs: 5 * 60_000,
} as const;

/** 502 and 504 are a gateway that could not reach the machine, 520–524 the same behind a CDN. 503 is left out: the Cloud's
 * relay answers it for an account-wide refusal, which says nothing about one machine. */
export const unansweredStatus = (status: number): boolean => status === 502 || status === 504 || (status >= 520 && status <= 524);

/** A probe that took this much longer than its own timeout was not timed by the computer but by this process (its event
 * loop stalled): it says nothing about the computer, so it counts neither way. */
export const stalledProbe = (sample: ProbeSample): boolean => sample.elapsedMs > sample.timeoutMs * 2 + 5_000;
export interface ProbeSample { elapsedMs: number; timeoutMs: number }

interface BoxHealth {
  /** Probes in a row that got no answer, the first and last of them. */
  failures: number;
  /** When each of those probes ended, the latest last (at most 64). */
  silences: number[];
  /** When the computer was last resumed, created or restarted, as seen by this process. */
  wokeAt: number | null;
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  lastAnsweredAt: number | null;
  probing: boolean;
  lastProbeAt: number;
  reportedAt: number | null;
  personAt: number | null;
}

export type NotRespondingListener = (boxId: string, since: number) => void;

export function createBoatHealth(now: () => number = Date.now) {
  const boxes = new Map<string, BoxHealth>();
  const listeners = new Set<NotRespondingListener>();
  const entry = (boxId: string): BoxHealth => {
    let found = boxes.get(boxId);
    if (!found) boxes.set(boxId, found = { failures: 0, silences: [], wokeAt: null, firstFailureAt: null, lastFailureAt: null, lastAnsweredAt: null, probing: false, lastProbeAt: -Infinity, reportedAt: null, personAt: null });
    return found;
  };
  const notResponding = (health: BoxHealth | undefined): health is BoxHealth & { firstFailureAt: number; lastFailureAt: number } =>
    Boolean(health && health.failures >= DEAD_COMPUTER.failures && health.firstFailureAt !== null && health.lastFailureAt !== null
      && health.lastFailureAt - health.firstFailureAt >= DEAD_COMPUTER.spanMs);

  function answered(boxId: string): void {
    const health = entry(boxId);
    Object.assign(health, { failures: 0, silences: [], firstFailureAt: null, lastFailureAt: null, lastAnsweredAt: now(), reportedAt: null });
  }

  /** A probe got no answer. With `sample`, one that ran far past its own timeout is dropped (stalledProbe). */
  function unanswered(boxId: string, sample?: ProbeSample): void {
    if (sample && stalledProbe(sample)) return;
    const health = entry(boxId), at = now();
    health.failures += 1;
    health.silences = [...health.silences.slice(-63), at];
    health.firstFailureAt ??= at;
    health.lastFailureAt = at;
    if (!notResponding(health) || (health.reportedAt !== null && at - health.reportedAt < DEAD_COMPUTER.reportGapMs)) return;
    health.reportedAt = at;
    for (const listener of listeners) listener(boxId, health.firstFailureAt!);
  }

  /** A command to this computer got no answer: probe it once, unless a probe is under way or ran moments ago. A probe's
   * null (refused, say, by a rate limit) counts neither way. */
  function suspect(boxId: string, probe: () => Promise<boolean | null>): void {
    const health = entry(boxId);
    if (health.probing || now() - health.lastProbeAt < DEAD_COMPUTER.probeGapMs) return;
    health.probing = true;
    const started = health.lastProbeAt = now();
    void probe().catch(() => false).then((ok) => {
      health.probing = false;
      if (boxes.get(boxId) !== health || ok === null) return;
      if (ok) answered(boxId); else unanswered(boxId, { elapsedMs: now() - started, timeoutMs: DEAD_COMPUTER.probeTimeoutMs });
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
    /** When the current run of unanswered probes began, however short it is; null while the computer answers. */
    silentSince: (boxId: string): number | null => boxes.get(boxId)?.firstFailureAt ?? null,
    /** The unanswered probes of the current run that ended at or after `since`: how many, and the first and last. */
    silencesSince(boxId: string, since: number): { count: number; first: number | null; last: number | null } {
      const list = (boxes.get(boxId)?.silences ?? []).filter((at) => at >= since);
      return { count: list.length, first: list[0] ?? null, last: list.at(-1) ?? null };
    },
    /** This computer was resumed, created or restarted now. `fresh`: a wake or create after it slept, so an earlier
     * silence says nothing about it now and its run of unanswered probes starts over. A restart keeps the run. */
    woke: (boxId: string, fresh = false) => {
      const health = entry(boxId);
      health.wokeAt = now();
      if (fresh) Object.assign(health, { failures: 0, silences: [], firstFailureAt: null, lastFailureAt: null, reportedAt: null });
    },
    wokeAt: (boxId: string): number | null => boxes.get(boxId)?.wokeAt ?? null,
    answeredWithin: (boxId: string, ms: number): boolean => {
      const at = boxes.get(boxId)?.lastAnsweredAt;
      return at !== null && at !== undefined && now() - at <= ms;
    },
    lastAnsweredAt: (boxId: string): number | null => boxes.get(boxId)?.lastAnsweredAt ?? null,
    /** Some other computer answered recently, so the provider and the path to it work. */
    otherAnsweredWithin: (boxId: string, ms: number): boolean =>
      [...boxes].some(([id, health]) => id !== boxId && health.lastAnsweredAt !== null && now() - health.lastAnsweredAt <= ms),
    /** Some other computer was probed recently and none of them answered: the trouble is on the provider's side. */
    othersSilentWithin: (boxId: string, ms: number): boolean => {
      const others = [...boxes].filter(([id]) => id !== boxId).map(([, health]) => health);
      return others.some((health) => health.lastFailureAt !== null && now() - health.lastFailureAt <= ms)
        && !others.some((health) => health.lastAnsweredAt !== null && now() - health.lastAnsweredAt <= ms);
    },
    /** A person opened this computer's desktop. */
    personUsed: (boxId: string) => { entry(boxId).personAt = now(); },
    personUsedWithin: (boxId: string, ms: number): boolean => {
      const at = boxes.get(boxId)?.personAt;
      return at !== null && at !== undefined && now() - at <= ms;
    },
    onNotResponding(listener: NotRespondingListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forget: (boxId: string) => { boxes.delete(boxId); },
    clear: () => boxes.clear(),
  };
}

export type BoatHealth = ReturnType<typeof createBoatHealth>;

export const boatHealth = createBoatHealth(() => Date.now());
