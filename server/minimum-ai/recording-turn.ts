import { createBrowserRecording, type BrowserRecording, type RecordedBrowserStep } from "./browser-replay.ts";

type Active = { bot: string; generation?: string; calls: number; started: number; pending: Set<string>; incomplete: boolean; recorder: ReturnType<typeof createBrowserRecording> };

/** Tracks a single first run per thread and rejects traces with missing, foreign or failed tools. */
export function createRecordingTurns() {
  const active = new Map<string, Active>();
  return {
    begin(thread: string, bot: string) {
      if (!thread || !bot || active.has(thread)) throw new Error("A recording is already active or has no owner");
      const run: Active = { bot, calls: 0, started: 0, pending: new Set(), incomplete: false, recorder: createBrowserRecording() };
      active.set(thread, run);
      return {
        cancel() { if (active.get(thread) === run) active.delete(thread); run.recorder.unsupported("cancelled"); },
        finish(ok: boolean): RecordedBrowserStep[] {
          if (active.get(thread) !== run) throw new Error("The recording is no longer active");
          active.delete(thread);
          if (!ok || run.incomplete || !run.generation || run.pending.size || run.calls !== run.started) run.recorder.unsupported("incomplete run");
          return run.recorder.finish();
        },
      };
    },
    browserCall(thread: string, bot: string, generation: string): BrowserRecording | undefined {
      const run = active.get(thread);
      if (!run) return undefined;
      if (run.bot !== bot) { run.incomplete = true; return undefined; }
      if (!generation || (run.generation && run.generation !== generation)) { run.incomplete = true; return undefined; }
      run.generation = generation;
      run.calls++;
      return run.recorder;
    },
    started(thread: string, itemId: string | undefined, title: string) {
      const run = active.get(thread);
      if (!run) return;
      if (!itemId || run.pending.has(itemId) || !/^(?:mcp__browser__|browser__|agent_browser_)/i.test(title)) { run.incomplete = true; return; }
      run.started++;
      run.pending.add(itemId);
    },
    completed(thread: string, itemId: string | undefined, ok: boolean) {
      const run = active.get(thread);
      if (!run) return;
      if (!itemId || !run.pending.delete(itemId) || !ok) run.incomplete = true;
    },
  };
}
