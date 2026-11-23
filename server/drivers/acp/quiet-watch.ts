// The watch on a prompt that has gone quiet: reads the agent's own log and samples its process tree, tells the person what
// it is doing, and stops a turn that waits out a usage limit or shows no sign of life for minutes. Moved out of core.ts.
import {
  classifyQuiet, describeQuiet, quietNoticeText, LogTail, promptIdleTimeoutMs, quietKey, quietNoticeMs, quietTickMs, quietVerdict, sampleProcessTree,
  type LogSignal, type ProcessSample, type QuietState,
} from "./quiet-status.ts";
import type { ServerText } from "../../../shared/server-text.ts";
import { HOST_SLEEP_TOLERANCE_MS } from "./host.ts";
import type { AcpSupport } from "./core.ts";
import type { AcpSession, AcpTurn } from "./turn-state.ts";

export function startAcpQuietWatch(input: {
  support: Pick<AcpSupport, "statusLog" | "displayName">;
  session: AcpSession;
  current: AcpTurn;
  stuckAfterMs: number;
  notice: (message: string, text: ServerText | undefined) => void;
}): { lastState: () => QuietState | null } {
  const { support, session, current } = input;
  const noticeAfterMs = quietNoticeMs();
  const tickMs = quietTickMs();
  const { sessionId } = session;
  const logPath = support.statusLog && sessionId ? support.statusLog.path(session.env, sessionId) : null;
  const tail = logPath ? new LogTail(logPath) : null;
  tail?.read();
  let logged: { signal: LogSignal; at: number } | null = null;
  let context: { tokens: number; threshold: number } | null = null;
  let previous: ProcessSample | null = null;
  let previousAt = 0;
  let shownKey: string | null = null;
  let noSignsSince: number | null = null;
  let notices = 0;
  let probing = false;
  let state: QuietState | null = null;
  const promptStartedAt = Date.now();
  let readAt = promptStartedAt, tickedAt = promptStartedAt, wokeAt = 0;
  const tick = async () => {
    const now = Date.now();
    // A tick this late means the computer slept: that time is not the agent's silence (pingdotgg/t3code@990f31cac25).
    if (now - tickedAt > tickMs + HOST_SLEEP_TOLERANCE_MS) { wokeAt = now; previous = null; noSignsSince = null; }
    tickedAt = now;
    if (probing || current.state.settled || session.current !== current) return;
    for (const line of tail?.read() ?? []) {
      if (!support.statusLog!.shared) session.acp.touch();
      const signal = support.statusLog!.parse(line, sessionId!);
      if (signal?.kind === "context") context = { tokens: signal.tokens, threshold: signal.threshold };
      // A shared row was written some time after the last read; date it then, so a reply since clears it.
      else if (signal) logged = { signal, at: support.statusLog!.shared ? readAt : now };
    }
    readAt = now;
    const quietMs = now - Math.max(promptStartedAt, session.acp.lastInboundAt, wokeAt);
    if (quietMs < noticeAfterMs || current.asks.size || current.runningTools.size) {
      if (quietMs < noticeAfterMs && (!support.statusLog?.shared || session.acp.lastInboundAt > (logged?.at ?? 0))) logged = null;
      previous = null;
      shownKey = null;
      noSignsSince = null;
      state = null;
      return;
    }
    // Qwen's SDK retries on its own for about a minute before the next logged attempt.
    if (logged?.signal.kind === "retry"
        && now - logged.at > (logged.signal.delayMs ?? 60_000) + 120_000) logged = null;
    probing = true;
    const sample = session.child.pid ? await sampleProcessTree(session.child.pid) : { cpuMs: null, connections: null };
    probing = false;
    if (current.state.settled || session.current !== current) return;
    let next = classifyQuiet({
      logged: logged?.signal ?? null, context, sample, previous, sinceMs: previous ? now - previousAt : 0,
    });
    const first = previous === null;
    previous = sample;
    previousAt = now;
    if (first && next.kind === "unknown") return;
    // An SDK sleeping between retries holds no socket and burns no CPU (Qwen against a 429ing endpoint); waiting out a
    // usage limit, or no sign of life for minutes, ends the turn now rather than after the full silence guard.
    const verdict = quietVerdict({ next, logged, noSignsSince, now, quietMs, name: support.displayName, stuckAfterMs: input.stuckAfterMs });
    next = verdict.next; noSignsSince = verdict.noSignsSince;
    if (verdict.stop) return void session.acp.failAll(verdict.stop);
    state = next;
    const key = quietKey(next);
    if (key === shownKey || notices >= 12) return;
    shownKey = key;
    notices += 1;
    input.notice(describeQuiet(support.displayName, next, quietMs, promptIdleTimeoutMs()), quietNoticeText(support.displayName, next, quietMs));
  };
  const timer = setInterval(() => { void tick(); }, tickMs);
  timer.unref?.();
  current.stopQuietWatch = () => clearInterval(timer);
  return { lastState: () => state };
}
