import type { Clock } from "../types.ts";

export class FakeClock implements Clock {
  #now: number;
  #monotonic: number;

  constructor(start = 1_760_000_000_000, monotonic = 10_000) {
    this.#now = start;
    this.#monotonic = monotonic;
  }

  now(): number {
    return this.#now;
  }

  monotonic(): number {
    return this.#monotonic;
  }

  advance(ms: number): void {
    this.#now += ms;
    this.#monotonic += ms;
  }

  sleep(ms: number): void {
    this.#now += ms;
  }
}
