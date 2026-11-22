import type { EngineCompactResult } from "../contracts.ts";
import { codexConfigDigest, codexOutsideIdentity, type CodexConnection, type CodexLease, type CodexTurnLink, type KeptCodex, type codexWarmSessions } from "./codex-warm.ts";
import { appendNative } from "./native.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const timeoutMs = (): number => Number(process.env.FAKE_CODEX_COMPACT_TIMEOUT_MS) > 0 ? Number(process.env.FAKE_CODEX_COMPACT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
const graceMs = (): number => Math.max(1, Number(process.env.FAKE_CODEX_INTERRUPT_GRACE_MS ?? 750) || 750);
const sleep = (ms: number) => new Promise<void>((wake) => { const timer = setTimeout(wake, ms); timer.unref?.(); });

class Ended extends Error {
  readonly stopped: boolean;
  constructor(why: string, stopped = false) {
    super(why);
    this.stopped = stopped;
  }
}

class Refused extends Error {}

interface ActiveCompaction {
  stop: () => Promise<boolean>;
  turnId: string;
  asks: Map<string, unknown>;
  pid?: number;
}

export interface CodexCompactDeps<Carried> {
  instanceId: string;
  warm: ReturnType<typeof codexWarmSessions<Carried>>;
  active: Map<string, ActiveCompaction>;
  turnId: () => string;
  refusal: () => string | null;
  providerOf: (model: string | null | undefined) => string | null;
}

function changedOutside<Carried>(session: KeptCodex<Carried>): string | null {
  let was: Record<string, unknown>;
  try { was = JSON.parse(session.contract); } catch { return "contract"; }
  const now = codexOutsideIdentity(session.identity);
  return (["config", "cli", "login"] as const).find((field) => was[field] !== now[field]) ?? null;
}

/** The engine's own compaction of a thread on the app-server a completed turn left running, in place: `thread/compact/start`
 * (codex-cli 0.171.0: the request returns `{}` at once, then the thread runs a turn of its own with a `contextCompaction` item
 * that reports no token usage). Nothing here starts a process: with no kept one on this session, or any doubt that the next
 * turn would resume it, the compaction does not run. */
export function codexCompactSession<Carried>(deps: CodexCompactDeps<Carried>) {
  return async (threadId: string, options: { session: string; model?: string | null; selectionNow?: () => { instanceId: string; model: string | null } | undefined; signal?: AbortSignal }): Promise<EngineCompactResult> => {
    const fail = (reason: string): EngineCompactResult => ({ ok: false, reason });
    const refusal = deps.refusal();
    if (refusal) return fail(refusal);
    if (deps.active.has(threadId)) return fail("a turn is running on this thread");
    if (options.signal?.aborted) return fail("stopped");

    let end!: (error: Ended) => void;
    const ended = new Promise<never>((_, reject) => { end = reject; });
    ended.catch(() => undefined);
    const race = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, ended]);
    const timer = setTimeout(() => end(new Ended("timed out")), timeoutMs());
    timer.unref?.();
    const onAbort = () => end(new Ended("stopped", true));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let lease: CodexLease<Carried> | null = null;
    let registered: ActiveCompaction | undefined;
    let exited: (() => void) | undefined, attached: CodexConnection | undefined;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const turn = { id: null as string | null, requested: false, compacted: false };
    let completed!: (status: string) => void, started!: () => void;
    const completion = new Promise<string>((resolve) => { completed = resolve; });
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    try {
      lease = deps.warm.lend(threadId, options.session);
      if (!lease) throw new Refused("no kept Codex process holds this session");
      const { session } = lease;
      const { connection } = session;
      const nativeThreadId = session.nativeThreadId;
      const baseline = connection.usageTotal ?? { input: 0, output: 0, cachedInput: 0 };
      registered = { stop: async () => { end(new Ended("stopped", true)); await done; return true; }, turnId: deps.turnId(), asks: new Map(), pid: connection.child.pid };
      deps.active.set(threadId, registered);

      const link: CodexTurnLink = {
        message(message) {
          if (connection.absorb(message)) return;
          const params = message?.params ?? {};
          if (params.threadId !== nativeThreadId) return;
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg: { method: message.method, ...(params.item?.type ? { itemType: params.item.type } : {}) } });
          if (message.method === "turn/started" && turn.requested && !turn.id) {
            turn.id = params.turn?.id ?? null;
            started();
          } else if (message.method === "item/completed" && turn.id && params.turnId === turn.id && params.item?.type === "contextCompaction") turn.compacted = true;
          else if (message.method === "turn/completed" && turn.id && params.turn?.id === turn.id) completed(String(params.turn.status));
        },
        error: (error) => end(new Ended(`codex failed during compaction: ${error.message}`)),
        close: (code, signal) => end(new Ended(`codex exited (${code ?? signal}) during compaction`)),
      };
      connection.attach(link);
      exited = () => end(new Ended("codex exited during compaction"));
      attached = connection;
      connection.child.once("exit", exited);

      await race(lease.settled);
      const changed = changedOutside(session);
      if (changed) throw new Refused(`the Codex ${changed} changed since its last turn`);
      if (session.provider !== deps.providerOf(options.model)) throw new Refused("the model's provider changed since its last turn");
      const read = await race(connection.ask("config/read", { cwd: session.cwd, includeLayers: false })) as { config?: unknown } | undefined;
      if (read?.config === undefined) throw new Refused("Codex could not confirm its configuration");
      if (codexConfigDigest(read.config) !== session.configDigest) throw new Refused("the Codex configuration changed since its last turn");

      const changedWhileReading = changedOutside(session);
      if (changedWhileReading) throw new Refused(`the Codex ${changedWhileReading} changed since its last turn`);
      if (options.selectionNow) {
        const now = options.selectionNow();
        if (now?.instanceId !== deps.instanceId || session.provider !== deps.providerOf(now.model)) throw new Refused("the instance or the model's provider changed while the configuration was being read");
      }
      if (lease.invalidated) throw new Refused("the Codex process was closed before the compaction");
      turn.requested = true;
      appendNative(threadId, { dir: "out", source: "codex.app-server", msg: { method: "thread/compact/start", params: { threadId: nativeThreadId } } });
      if (await race(connection.ask("thread/compact/start", { threadId: nativeThreadId })) === undefined) throw new Refused("Codex refused the compaction request");
      const status = await race(completion);
      if (status !== "completed" || !turn.compacted) throw new Refused(`the compaction turn ended ${status === "completed" ? "without compacting" : status}`);
      if (lease.invalidated) throw new Refused("the Codex process was closed during compaction");

      const now = connection.usageTotal ?? baseline;
      const usage = { input: Math.max(0, now.input - baseline.input), output: Math.max(0, now.output - baseline.output), cachedInput: Math.max(0, now.cachedInput - baseline.cachedInput) };
      connection.detach();
      await lease.release();
      lease = null;
      return { ok: true, usage: usage.input || usage.output || usage.cachedInput ? usage : null, model: session.model };
    } catch (error) {
      const reason = error instanceof Ended || error instanceof Refused ? error.message : `compaction failed: ${(error as Error).message}`;
      if (lease) {
        const connection = lease.session.connection;
        if (error instanceof Ended && error.stopped && turn.requested && connection.alive) {
          if (!turn.id) await Promise.race([turnStarted, sleep(graceMs())]);
          if (turn.id) {
            await Promise.race([connection.ask("turn/interrupt", { threadId: lease.session.nativeThreadId, turnId: turn.id }), sleep(graceMs())]);
            await Promise.race([completion, sleep(graceMs())]);
          }
        }
        lease.session.connection.detach();
        await lease.discard(`compaction not completed: ${reason}`);
      }
      return fail(reason);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (exited) attached?.child.removeListener("exit", exited);
      if (registered && deps.active.get(threadId) === registered) deps.active.delete(threadId);
      finished();
    }
  };
}
