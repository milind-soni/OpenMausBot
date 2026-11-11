// The burst lane: burst threads run up to the plan's limit, apart from the plan's own turn caps, so a burst never takes a
// place from the person's chats. Queued children wait in the lane's own store, never in the runtime or the engine queue,
// so the work of one step does not grow with the size of the burst.

export interface BurstLaneDeps<Slot> {
  /** The plan's most burst threads running at once. */
  parallel(): number;
  /** Whether one more burst thread may start: nobody's own work is waiting, and the machine has a place for it. */
  hasRoom(): boolean;
  /** The next queued child, taken. */
  next(): Slot | undefined;
  /** Starts it; `release` is called when it ends. */
  begin(slot: Slot): void;
}

export class BurstLane<Slot> {
  private readonly deps: BurstLaneDeps<Slot>;
  private running = 0;
  private pumping = false;
  private again = false;

  constructor(deps: BurstLaneDeps<Slot>) {
    this.deps = deps;
  }

  /** How many burst threads the lane has running or starting. */
  runningCount(): number {
    return this.running;
  }

  /** A burst thread ended: its place is free. */
  release(): void {
    this.running = Math.max(0, this.running - 1);
    this.pump();
  }

  /** Starts children while there is a place. Never re-enters: a start that settles at once asks for one more pass. */
  pump(): void {
    if (this.pumping) { this.again = true; return; }
    this.pumping = true;
    try {
      do {
        this.again = false;
        while (this.running < this.deps.parallel() && this.deps.hasRoom()) {
          const slot = this.deps.next();
          if (slot === undefined) break;
          this.running += 1;
          this.deps.begin(slot);
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }
}
