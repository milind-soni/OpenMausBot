// How far a routine run has got (its newest reply, a question it opened or had answered, an engine error it may still
// recover from) reaches routines.json at most once per window, not once per step: each save rewrites every routine and
// up to 2,000 runs. A restart acts only on a run's status, and every status change (a start, an end, a retry) is still
// saved before the server yields, taking any waiting progress with it. A crash loses at most the last window of progress
// on a run the restart then retries or fails anyway; a stop (shutdown, backup, a move) writes it first.
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export const RUN_PROGRESS_WINDOW_MS = 5_000;

export class RunProgressSave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private immediate = false;
  private readonly file: () => string;
  private readonly write: () => void;
  private readonly windowMs: number;

  constructor(file: () => string, write: () => void, windowMs = RUN_PROGRESS_WINDOW_MS) {
    this.file = file;
    this.write = write;
    this.windowMs = windowMs;
  }

  /** Saves within the window; a later change in the same window rides along and never pushes the save back. */
  soon(): void {
    this.pending = true;
    if (this.immediate) return this.writeLogged();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A folder removed meanwhile (a test's, a wiped data folder) stays removed: progress never recreates it.
      if (existsSync(dirname(this.file()))) this.writeLogged();
      else this.written();
    }, this.windowMs);
    this.timer.unref?.();
  }

  /** A whole-file save just ran, so nothing is waiting any more. */
  written(): void {
    this.pending = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Writes what is waiting now, if anything is. */
  flush(): void {
    if (!this.pending) return;
    if (!existsSync(dirname(this.file()))) {
      this.written();
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
    this.written();
  }

  /** From shutdown on, progress is saved as it happens, as no later window may come. */
  atOnce(): void {
    this.immediate = true;
  }

  private writeLogged(): void {
    try {
      this.write();
      this.written();
    } catch (error) {
      // The progress stays in memory and the next save of the file writes it.
      console.error("routines: could not save run progress; the next save retries it", error);
    }
  }
}
