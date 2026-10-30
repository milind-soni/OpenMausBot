// How long a person's hold on a bot's browser lasts without a hand-back, the same on both engines. The hold is the
// person's, not one view's: any of their views may hand it back or take it over, and their next view carries on with
// it when the one they used went. It ends `graceMs` after the last of their views went (a dropped stream or a phone in
// the background gets that long to come back), and `idleMs` after they last took control or sent input, kept or not,
// so a held browser never outlives the person. Every key they type starts the idle time again: the bots stay paused
// while they really type.
export interface HoldLimits {
  readonly graceMs: number;
  readonly idleMs: number;
}

export const HOLD_LIMITS: HoldLimits = { graceMs: 2 * 60_000, idleMs: 5 * 60_000 };

/** One browser's two hold timers. `end` runs when either passes, and checks that the hold is still the one timed. */
export class HoldClock {
  #idle: ReturnType<typeof setTimeout> | undefined;
  #grace: ReturnType<typeof setTimeout> | undefined;
  readonly #end: () => void;
  readonly #limits: HoldLimits;

  constructor(end: () => void, limits: HoldLimits = HOLD_LIMITS) {
    this.#end = end;
    this.#limits = limits;
  }

  /** The person took control or sent input. */
  used(): void {
    clearTimeout(this.#idle);
    this.#idle = this.#after(this.#limits.idleMs);
  }

  /** Whether one of the person's views of the browser is open; with none, the grace runs. */
  watched(open: boolean): void {
    if (open) {
      clearTimeout(this.#grace);
      this.#grace = undefined;
    } else {
      this.#grace ??= this.#after(this.#limits.graceMs);
    }
  }

  stop(): void {
    clearTimeout(this.#idle);
    clearTimeout(this.#grace);
    this.#idle = undefined;
    this.#grace = undefined;
  }

  #after(ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.stop();
      this.#end();
    }, ms);
    timer.unref?.();
    return timer;
  }
}
