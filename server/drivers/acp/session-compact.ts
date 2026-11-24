import type { EngineCompactResult } from "../../contracts.ts";
import { deletePromptSplitReceipt } from "../prompt-split.ts";
import { promptTokenUsage } from "./prompt-usage.ts";
import { stopIdleClose } from "../session-idle.ts";
import type { AcpAskFinish, AcpSession } from "./turn-state.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const CANCEL_GRACE_MS = 5_000;
const timeoutMs = (): number => Number(process.env.FAKE_ACP_COMPACT_TIMEOUT_MS) > 0 ? Number(process.env.FAKE_ACP_COMPACT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
const REPLY_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

interface ActiveEntry {
  stop: () => void;
  interrupt: () => void | Promise<void>;
  turnId: string;
  asks: Map<string, AcpAskFinish>;
}

export interface AcpCompactDeps {
  driverKind: string;
  instanceId: string;
  sessions: Map<string, AcpSession>;
  active: Map<string, ActiveEntry>;
  turnId: () => string;
  refusal: () => string | null;
  promptOutcome?: (instanceId: string, sessionId: string) => Promise<(result: unknown) => Promise<Error | undefined>>;
  closeSession: (threadId: string, why: string) => void;
  endUncancelled: (threadId: string, session: AcpSession) => Promise<boolean>;
  armIdle: (threadId: string) => void;
}

type Ending = { kind: "answered"; result: any } | { kind: "failed"; reason: string } | { kind: "stopped" } | { kind: "timeout" };

/** The agent's own compaction of a thread's session, in place, by the slash command the process advertised when it was
 * launched (Antigravity CLI 1.5.14: `/compact` as a prompt's only block answers `end_turn` with the summary call's usage
 * after one `usage_update` and no reply; on a session with nothing to compact it is sent to the model as a message, and
 * answers with a reply). Nothing here starts a process or loads a session: only the live session the last turn left,
 * still on `session`, takes it. */
export function acpCompactSession(deps: AcpCompactDeps) {
  return async (threadId: string, options: { session: string; selectionNow?: () => { instanceId: string; model: string | null } | undefined; signal?: AbortSignal }): Promise<EngineCompactResult> => {
    const fail = (reason: string): EngineCompactResult => ({ ok: false, reason });
    const refusal = deps.refusal();
    if (refusal) return fail(refusal);
    if (deps.active.has(threadId)) return fail("a turn is running on this thread");
    if (options.signal?.aborted) return fail("stopped");
    const session = deps.sessions.get(threadId);
    const live = (): boolean => deps.sessions.get(threadId) === session && session !== undefined && !session.dead && !session.closing
      && session.current === null && session.child.exitCode === null && session.child.signalCode === null && session.sessionId === options.session;
    if (!session || !live()) return fail("no live session holds this conversation");
    const command = session.compactCommand;
    if (!command) return fail("this runtime has no in-place compaction");
    if (session.commandsSession !== options.session || !session.commands?.has(command)) return fail(`the session does not offer /${command}`);
    const selectionMoved = (): boolean => {
      const now = options.selectionNow?.();
      return options.selectionNow !== undefined && now?.instanceId !== deps.instanceId;
    };

    let end!: (ending: Ending) => void;
    const ended = new Promise<Ending>((resolve) => { end = resolve; });
    let stopRequested = false;
    let onInterrupt: ((why: "stopped" | "gone" | "timeout") => void) | null = null;
    const interrupt = (why: "stopped" | "gone" | "timeout") => onInterrupt?.(why);
    const stop = () => { stopRequested = true; interrupt("stopped"); end({ kind: "stopped" }); };
    let finished!: () => void;
    const settled = new Promise<void>((resolve) => { finished = resolve; });
    const entry: ActiveEntry = { stop, interrupt: async () => { stop(); await settled; }, turnId: deps.turnId(), asks: new Map() };
    deps.active.set(threadId, entry);
    stopIdleClose(`${deps.instanceId}\0${threadId}`, session.idleTimer);
    session.idleTimer = null;
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let markGone!: () => void;
    const gone = new Promise<null>((resolve) => { markGone = () => resolve(null); });
    const exited = () => { markGone(); interrupt("gone"); end({ kind: "failed", reason: "the agent exited during compaction" }); };
    for (const event of ["exit", "close", "error"]) session.child.once(event, exited);
    const counted = { open: false, replied: false, usageReported: false };
    const heard = (params: any) => {
      if (!counted.open || params?._meta?.isReplay === true || params?.sessionId !== options.session) return;
      const kind = params?.update?.sessionUpdate;
      if (REPLY_UPDATES.has(kind)) counted.replied = true;
      else if (kind === "usage_update") counted.usageReported = true;
    };
    const previousHeard = session.acp.onUpdate;
    session.acp.onUpdate = heard;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let keep = true, sent = false;
    try {
      const checked = deps.promptOutcome ? deps.promptOutcome(deps.instanceId, options.session).catch(() => undefined) : Promise.resolve(undefined);
      const before = await Promise.race([checked.then((check) => ({ kind: "checked" as const, check })), ended]);
      if (before.kind !== "checked") return before.kind === "failed" ? (keep = false, fail(before.reason)) : fail("stopped");
      const { check } = before;
      if (stopRequested || options.signal?.aborted) return fail("stopped");
      if (!live() || selectionMoved()) return fail("the conversation moved on before the compaction was sent");
      let timedOut = false;
      timer = setTimeout(() => { timedOut = true; interrupt("timeout"); end({ kind: "timeout" }); }, timeoutMs());
      timer.unref?.();
      counted.open = true; sent = true;
      const answer = session.acp.request("session/prompt", { sessionId: options.session, prompt: [{ type: "text", text: `/${command}` }] },
        undefined, () => { counted.open = false; });
      answer.then((result) => end({ kind: "answered", result }), (error: Error) => end({ kind: "failed", reason: `compaction failed: ${error.message}` }));
      const failSent = (reason: string, result?: unknown): EngineCompactResult => {
        const reported = promptTokenUsage(result);
        return { ok: false, reason, ...(reported ? { usage: { input: reported.input, output: reported.output, cachedInput: reported.cachedInput ?? 0 }, model: session.lastModel ?? null } : {}),
          ...(counted.replied ? { sessionChanged: true as const } : {}) };
      };
      let ending = await ended;
      if (ending.kind === "stopped" || ending.kind === "timeout") {
        const after = await answerAfterCancel(session, options.session, answer, gone);
        const cancelled = after?.stopReason === "cancelled";
        if (ending.kind === "stopped" && after !== null && !cancelled) ending = { kind: "answered", result: after };
        else {
          keep = ending.kind === "stopped" && cancelled && !counted.replied;
          if (after === null && !await deps.endUncancelled(threadId, session)) return failSent("the agent could not be stopped");
          return failSent(ending.kind === "stopped" ? "stopped" : "timed out", after);
        }
      }
      if (ending.kind === "failed") {
        keep = false;
        return failSent(ending.reason);
      }
      if (ending.kind !== "answered") return fail("stopped");
      const { result } = ending;
      const usage = promptTokenUsage(result);
      let stopGrace: ReturnType<typeof setTimeout> | undefined;
      const interruptedAfter = new Promise<"stopped" | "gone" | "timeout">((resolve) => {
        onInterrupt = resolve;
        if (timedOut) resolve("timeout");
        else if (stopRequested) { stopGrace = setTimeout(() => resolve("stopped"), CANCEL_GRACE_MS); stopGrace.unref?.(); }
      });
      const reported = await Promise.race([Promise.resolve(check?.(result)).catch(() => undefined), interruptedAfter]).finally(() => clearTimeout(stopGrace));
      if (reported === "stopped" || reported === "gone" || reported === "timeout") {
        keep = reported === "stopped" && !counted.replied;
        return failSent(reported === "stopped" ? "stopped" : reported === "gone" ? "the agent exited during compaction" : "timed out", result);
      }
      const why = result?.stopReason !== "end_turn" ? `the compaction ended ${String(result?.stopReason ?? "without a stop reason")}`
        : reported ? `the agent reported a failure: ${reported.message}`
          : counted.replied ? `the agent answered /${command} as a message`
            : !usage || !counted.usageReported ? "the agent reported no compaction"
              : null;
      if (why) {
        keep = false;
        return failSent(why, result);
      }
      return { ok: true, usage: { input: usage!.input, output: usage!.output, cachedInput: usage!.cachedInput ?? 0 }, model: session.lastModel ?? null };
    } finally {
      clearTimeout(timer);
      if (sent) deletePromptSplitReceipt(deps.driverKind, JSON.stringify([threadId, options.session]));
      options.signal?.removeEventListener("abort", onAbort);
      for (const event of ["exit", "close", "error"]) session.child.removeListener(event, exited);
      if (session.acp.onUpdate === heard) session.acp.onUpdate = previousHeard;
      if (!keep && deps.sessions.get(threadId) === session && !session.closing) deps.closeSession(threadId, "compact-failed");
      else if (deps.sessions.get(threadId) === session && !session.closing && !session.dead) deps.armIdle(threadId);
      if (deps.active.get(threadId) === entry) deps.active.delete(threadId);
      finished();
    }
  };
}

async function answerAfterCancel(session: AcpSession, sessionId: string, answer: Promise<any>, gone: Promise<null>): Promise<any> {
  session.acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CANCEL_GRACE_MS); timer.unref?.(); });
  const outcome = await Promise.race([answer.then((result) => result, () => null), grace, gone]);
  clearTimeout(timer);
  return outcome;
}
