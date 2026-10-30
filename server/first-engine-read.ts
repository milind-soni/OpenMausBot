// On a cold start the engines' and the browser's binaries are read from a slow disk; work that reads them in the
// background (model catalogs, the browser's version) waits until the engine a first turn most likely needs is probed.
let held: Promise<void> = Promise.resolve();

/** Until the returned release runs, `afterFirstEngineRead()` waits. */
export function holdUntilFirstEngineRead(): () => void {
  let release!: () => void;
  held = new Promise<void>((resolve) => (release = resolve));
  return release;
}

export function afterFirstEngineRead(): Promise<void> {
  return held;
}
