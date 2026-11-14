// Imports nothing, so a preference's own module can say it changed without loading every other preference module.
let listener: (() => void) | null = null;
let missed = false;

export function windowPrefChanged(): void {
  if (listener) listener();
  else missed = true;
}

/** A change said before the listener came is heard once it comes. */
export function onWindowPrefChanged(next: () => void): void {
  listener = next;
  if (missed) {
    missed = false;
    next();
  }
}
