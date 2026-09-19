// The live-screen pollers — extracted verbatim from index.ts. Frames stream
// to clients as SSE {kind:'screen'} (the "Bot's screen" panel); the final
// frame is folded into the transcript on turn end. index.ts wires
// createScreenPollers just before its first consumer (turnCleanup); the
// poller functions were hoisted declarations there, so the factory is
// available from the same point in module evaluation. The lateBound family
// holds thunks for consts index.ts declares after the wiring site.
import { screenFrameHash, settledFrameIsNews } from "./screen-frame-gate.ts";
import { createScreenFrameSource, type ScreenCapture } from "./screen-frame-source.ts";
import { store, teamComputerTurns } from "./runtime.ts";
import { botForThread, turnComputerResources, turnResourceOwners, turnResources } from "./turn-admission.ts";

export type Frame = { png: string; mime: string };

/** Everything the pollers read from their host. The lateBound family holds
 * thunks for consts index.ts declares after the factory is wired. */
export interface ScreenPollersDeps {
  lateBound: {
    broadcast(): (payload: Record<string, unknown>) => void;
    computerControlRevision(): Map<string, number>;
  };
  helpers: {
    currentBrowserSession(botId: string, profile: string | undefined): string;
    botComputerControlSnapshot(botId: string, pinnedComputerId?: string): { held: boolean };
  };
}

export function createScreenPollers(deps: ScreenPollersDeps) {
  const { broadcast, computerControlRevision } = deps.lateBound;
  const { currentBrowserSession, botComputerControlSnapshot } = deps.helpers;

  const screenPollers = new Map<
    string,
    {
      botId: string;
      timer: ReturnType<typeof setInterval> | null;
      capture: (fresh?: boolean) => Promise<void>;
      /** Which surface the last screen-touching tool acted on. A bot with both
       * a computer and a browser must be pictured on the one it just used. */
      surface: "browser" | "computer";
      last: Frame | null;
      /** Did this turn actually reach for the screen? A bot that merely HAS
       * a computer would otherwise end every reply — a one-word "yes"
       * included — with the same picture of an idle desktop. The flag lives
       * on the poller entry, which is created and dropped per turn, so it
       * cannot leak into a later one. */
      touched: boolean;
    }
  >();

  /** The preview shares the box's single command endpoint with the agent's
   * own actions, so every frame we take is latency stolen from the work the
   * user is waiting on. Hence: a slow interval, a floor between captures,
   * and never two in flight. */
  const SCREEN_POLL_MS = 6000;
  const SCREEN_MIN_GAP_MS = 3000;
  const SCREEN_SETTLE_TIMEOUT_MS = 10_000;

  /** `screenIsTheWork` starts the turn already counting as screen usage: a
   * boxAgent's whole session runs ON the box, so every tool it calls acts on
   * that screen even though none of them is named like a computer tool. Its
   * shell-only turns are kept honest by the settle-time hash gate instead. */
  function startScreenPoller(
    botId: string,
    threadId: string,
    captures: { computer?: ScreenCapture; browser?: ScreenCapture },
    { screenIsTheWork = false } = {},
  ) {
    if (!captures.computer && !captures.browser) return;
    if (screenPollers.has(threadId)) return;
    const owner = turnResourceOwners.get(threadId);
    const computer = turnComputerResources.get(threadId);
    const browserSession = currentBrowserSession(botId, botForThread(botId, threadId)?.browserProfile);
    const guarded = (capture: ScreenCapture | undefined, resource: string | undefined): ScreenCapture | undefined =>
      capture && owner && resource ? async () => {
        const isCurrent = () => turnResourceOwners.get(threadId)?.generation === owner.generation &&
          turnResources.owns(resource, owner) && Boolean(store.taskByThread(botId, threadId) || store.groupByThread(threadId));
        if (!isCurrent()) throw new Error("this thread does not own that screen");
        const frame = await capture();
        if (!isCurrent()) throw new Error("this thread no longer owns that screen");
        return frame;
      } : undefined;
    // Assign rather than spread: the source's last-frame getter deliberately
    // hides a stale frame as soon as the selected surface changes.
    const entry = Object.assign(createScreenFrameSource({
      captures: {
        computer: guarded(captures.computer, computer?.resource),
        browser: guarded(captures.browser, browserSession ? `browser:${browserSession}` : undefined),
      },
      control: () => ({
        held: botComputerControlSnapshot(botId, teamComputerTurns.get(threadId)?.computerId).held,
        revision: computerControlRevision().get(botId) ?? 0,
      }),
      onFrame: (frame) => broadcast()({ kind: "screen", botId, threadId, ...frame }),
      minGapMs: SCREEN_MIN_GAP_MS,
    }), {
      timer: null as ReturnType<typeof setInterval> | null,
      botId,
      touched: screenIsTheWork,
    });
    entry.timer = setInterval(() => void entry.capture(), SCREEN_POLL_MS);
    screenPollers.set(threadId, entry);
  }

  /** Event-driven refresh: capture NOW (the bot just acted on its screen)
   * instead of waiting for the next interval tick. Rate-limited inside
   * capture() — a tool-heavy turn used to fire one full REST chain per
   * completed tool, competing with the agent for the same endpoint. */
  function pokeScreenPoller(threadId: string, touches: boolean, surface?: "browser" | "computer") {
    const entry = screenPollers.get(threadId);
    if (!entry) return;
    // the same signal, read twice: a completed computer tool is both the
    // reason to refresh the preview NOW and — when it acted on or looked at
    // the screen — the proof that this turn's final frame is worth settling
    // into the transcript. A shell command or a status read earns only the
    // refresh: under the Claude driver every tool of the computer server is
    // named mcp__computer__*, and matching that alone used to append an
    // untouched desktop to every curl-and-answer reply.
    if (touches) entry.touched = true;
    // Picture the surface the tool acted on. Only a touching tool moves this:
    // a status read on the computer must not redirect the picture away from a
    // page the browser is still showing.
    if (touches && surface) entry.surface = surface;
    void entry.capture();
  }

  function stopScreenPoller(botId: string, threadId?: string) {
    for (const [id, entry] of screenPollers) {
      if (entry.botId !== botId || (threadId && id !== threadId)) continue;
      if (entry.timer) clearInterval(entry.timer);
      screenPollers.delete(id);
    }
  }

  /** sha256 of the frame each bot last settled into a transcript — the
   * comparison the hash gate needs is "this turn's end state against what
   * the reader can already see". Keyed per bot (one physical screen, however
   * many threads it reports into); a cold entry is seeded from the thread's
   * newest screen message so a restart does not re-picture the same idle
   * desktop either. */
  const settledScreenHashes = new Map<string, string>();

  function shownScreenHash(threadId: string): string | undefined {
    const known = settledScreenHashes.get(threadId);
    if (known) return known;
    const shown = store.messagesFor(threadId).findLast((m) => m.kind === "screen" && Boolean(m.png));
    return shown?.png ? screenFrameHash(shown.png) : undefined;
  }

  /** Turn end: stop polling, then take ONE last fresh frame (awaiting any
   * in-flight poke first) so the settled screenshot shows the screen's actual
   * end state, not the previous action's. A turn that never touched the
   * screen settles nothing — and skips the capture, which is one less
   * command on the box's single endpoint. A frame the reader can already see
   * settles nothing either: the boxAgent pre-touch counts every turn as
   * screen work, so without this its shell-only replies would all end in
   * the same idle desktop. Either way the poller is torn down here, so no
   * per-turn state survives the turn. */
  async function finalScreenFrame(_botId: string, threadId: string): Promise<Frame | null> {
    const entry = screenPollers.get(threadId);
    const owner = turnResourceOwners.get(threadId);
    if (!entry) return null;
    if (entry.timer) clearInterval(entry.timer);
    screenPollers.delete(threadId);
    if (!entry.touched) return null;
    await entry.capture(true);
    if (!owner || turnResourceOwners.get(threadId)?.generation !== owner.generation ||
        !store.taskByThread(_botId, threadId)) return null;
    const frame = entry.last;
    if (!frame || !settledFrameIsNews(shownScreenHash(threadId), frame.png)) return null;
    settledScreenHashes.set(threadId, screenFrameHash(frame.png));
    return frame;
  }

  return {
    screenPollers,
    SCREEN_SETTLE_TIMEOUT_MS,
    startScreenPoller,
    pokeScreenPoller,
    stopScreenPoller,
    finalScreenFrame,
  };
}
