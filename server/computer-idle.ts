const MAX_RETRY_MS = 60 * 60_000;
const BUSY_CHECKS_PER_WINDOW = 10;

/** Stops a computer this server started once it has had a full quiet window and is not busy; activity renews the window.
 * While busy it looks again ten times a window, and the first look that finds it quiet starts a full window. */
export class ComputerIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt = 0;
  private failures = 0;
  private busySeen = false;
  /** Bumped by every cancel, so a stop still in flight from an earlier window neither re-arms nor reports. */
  private generation = 0;
  private idleMs: number;
  private readonly isBusy: () => boolean;
  private readonly suspend: () => Promise<void | "busy">;
  private readonly onFailure?: (error: unknown, retryInMs: number) => void;

  /** `suspend` answers "busy" when work arrived after `isBusy` said no; a throw is retried one window later, then two, four, at most an hour apart. */
  constructor(
    idleMs: number,
    isBusy: () => boolean,
    suspend: () => Promise<void | "busy">,
    onFailure?: (error: unknown, retryInMs: number) => void,
  ) {
    this.idleMs = checkedIdleMs(idleMs);
    this.isBusy = isBusy;
    this.suspend = suspend;
    this.onFailure = onFailure;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
    this.failures = 0;
    this.busySeen = false;
    this.arm(this.idleMs);
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setIdleMs(idleMs: number): void {
    this.idleMs = checkedIdleMs(idleMs);
    if (!this.timer) return;
    this.arm(Math.max(0, this.lastActivityAt + this.idleMs - Date.now()));
  }

  private arm(delayMs: number): void {
    this.cancel();
    this.timer = setTimeout(() => void this.expire(), delayMs);
    this.timer.unref?.();
  }

  private async expire(): Promise<void> {
    this.timer = null;
    if (this.isBusy()) {
      this.busySeen = true;
      this.arm(this.idleMs / BUSY_CHECKS_PER_WINDOW);
      return;
    }
    if (this.busySeen) {
      this.touch();
      return;
    }
    const generation = this.generation;
    try {
      const outcome = await this.suspend();
      if (generation === this.generation && outcome === "busy") this.touch();
    } catch (error) {
      if (generation !== this.generation) return;
      this.failures += 1;
      const retryInMs = Math.min(this.idleMs * 2 ** (this.failures - 1), Math.max(this.idleMs, MAX_RETRY_MS));
      this.onFailure?.(error, retryInMs);
      this.arm(retryInMs);
    }
  }
}

function checkedIdleMs(idleMs: number): number {
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("A computer idle window must be positive");
  return idleMs;
}
