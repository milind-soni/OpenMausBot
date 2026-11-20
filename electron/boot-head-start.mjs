/** Launch work that waits on nothing before it, begun early and handed over when its turn in the boot order comes. A result is taken once: a later take runs the work afresh. */
export function createBootHeadStart(work) {
  const begun = new Map();
  const run = (name) => new Promise((resolve) => resolve(work[name]()));
  const quietUntilTaken = (pending) => { pending.catch(() => {}); return pending; };
  return {
    start() {
      for (const name of Object.keys(work)) if (!begun.has(name)) begun.set(name, quietUntilTaken(run(name)));
    },
    take(name) {
      const pending = begun.get(name);
      begun.delete(name);
      return pending ?? run(name);
    },
  };
}
