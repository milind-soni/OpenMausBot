/**
 * Launch work that waits on nothing before it (reading the saved keys, asking the system for its proxy), begun as soon
 * as Electron is ready and handed over when its turn in the boot order comes. A result is taken once: a later take runs
 * the work afresh, so a server restart never reuses a launch-time answer.
 */
export function createBootHeadStart(work) {
  const begun = new Map();
  const run = (name) => new Promise((resolve) => resolve(work[name]()));
  return {
    start() {
      for (const name of Object.keys(work)) {
        if (begun.has(name)) continue;
        const pending = run(name);
        // The taker hears a failure; until then it must not count as unhandled.
        pending.catch(() => {});
        begun.set(name, pending);
      }
    },
    take(name) {
      const pending = begun.get(name);
      begun.delete(name);
      return pending ?? run(name);
    },
  };
}
