type Status = "idle" | "saving" | "saved" | "error";

/** Owned by the store, so section navigation cannot discard an unsaved edit. */
export function createAboutMeDraft(initial: string, save: (value: string) => Promise<void>) {
  let snapshot = { value: initial, status: "idle" as Status };
  let dirty = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const update = (value: string, status: Status) => {
    snapshot = { value, status };
    for (const listener of listeners) listener();
  };
  const flush = (): Promise<void> => {
    clearTimeout(timer);
    if (running) return running;
    if (!dirty) return Promise.resolve();
    update(snapshot.value, "saving");
    running = (async () => {
      try {
        while (dirty) {
          const sent = snapshot.value;
          await save(sent);
          dirty = snapshot.value !== sent;
        }
        update(snapshot.value, "saved");
      } catch {
        update(snapshot.value, "error");
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    confirm(value: string) {
      if (!dirty && !running && value !== snapshot.value) update(value, "idle");
    },
    edit(value: string) {
      dirty = true;
      update(value, "idle");
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 600);
    },
    flush,
  };
}
