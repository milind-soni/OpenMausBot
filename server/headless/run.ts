// Exit codes: 0 done, 1 failed or stopped, 3 needs you, 4 timed out, 130 Ctrl-C (the work keeps running).
import { messageFileTargets } from "../message-file.ts";
import { EXIT, flag, HeadlessError, oneOf, parseCount, usageError } from "./args.ts";
import { readJob, type HeadlessClient } from "./client.ts";
import { conversationFor, conversationTitle, newSendId, readMessage, resolveTarget, waitPolicy, type Target, type VerbContext,
  type VerbOutcome } from "./context.ts";
import { exportFolder, exportJob } from "./export.ts";
import { oneLine } from "./output.ts";

type Rec = Record<string, any>;
const MCP_WAIT_MAX_S = 120;
const enc = encodeURIComponent;

const STOPPABLE = new Set(["running", "waiting", "needs_input", "resume"]);

/** The teammate tasks a Stop ended: each one still at work after the conversation's Stop is stopped in its own
 * conversation, and one that was at work before it (`working`, node ids) and is cancelled now ended with it. */
export async function stopTeammates(client: HeadlessClient, threadId: string, nodes: readonly Rec[], working: ReadonlySet<string> = new Set()): Promise<Rec[]> {
  const stopped: Rec[] = [];
  const done = new Set<string>();
  for (const node of nodes) {
    if (node.threadId === threadId || done.has(node.threadId)) continue;
    const record = { id: node.id, botId: node.botId, botName: node.botName, threadId: node.threadId };
    if (node.status === "cancelled" && working.has(node.id)) {
      done.add(node.threadId);
      stopped.push(record);
      continue;
    }
    if (!STOPPABLE.has(node.status)) continue;
    done.add(node.threadId);
    const route = node.groupId ? `/api/groups/${enc(node.groupId)}/interrupt` : `/api/bots/${enc(node.botId)}/interrupt`;
    try {
      await client.json(route, { method: "POST", body: JSON.stringify({ threadId: node.threadId }) });
      stopped.push(record);
    } catch {
    }
  }
  return stopped;
}

/** The job is read before the Stop (for its since, which the Stop moves past, and the teammates then at work) and
 * again after it. The Stop itself ends the teammates mid-turn; any still at work after it are stopped one by one. */
export async function stopConversation(client: HeadlessClient, target: Target, tree: boolean): Promise<{ result: Rec; stopped: Rec[] }> {
  let threadId = target.taskId;
  if (tree && !threadId) {
    const fleet = await client.json<Rec>("/api/bots?messages=0");
    threadId = (target.type === "bot" ? fleet.bots : fleet.groups)?.find((record: Rec) => record.id === target.id)?.threadId;
  }
  const before = tree && threadId ? await readJob(client, threadId) : undefined;
  const result = await client.tool("interrupt_conversation", { target_type: target.type, target_id: target.id, ...(threadId ? { task_id: threadId } : {}) });
  if (!before) return { result, stopped: [] };
  const working = new Set<string>((before.nodes ?? []).filter((node: Rec) => STOPPABLE.has(node.status)).map((node: Rec) => node.id));
  const after = await readJob(client, result.taskId, { since: String(before.since) });
  return { result, stopped: await stopTeammates(client, result.taskId, after.nodes ?? [], working) };
}

/** From the job's own state: MCP's `status` keeps older words (a lead whose work failed is "settled" there). */
const exitFor = (result: Rec, strict: boolean): number => {
  if (result.state === "completed" || result.state === "idle") {
    const counts: Rec = result.job?.counts ?? {};
    const failed = Number(counts.failed ?? 0) + Number(counts.cancelled ?? 0) > 0
      || (result.job?.nodes ?? []).some((node: Rec) => node.status === "failed" || node.status === "cancelled");
    return strict && failed ? EXIT.failed : EXIT.done;
  }
  return result.state === "needs-input" ? EXIT.needsInput : result.state === "timed-out" ? EXIT.timeout : EXIT.failed;
};

interface Waited { result: Rec; exitCode: number; stopped?: Rec[]; reason?: string }

interface Watching { threadId?: string; since?: number }

function passing(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 502 || status === 503 || status === 504;
  // fetch's own failures ("fetch failed", a body cut off), never a TypeError from a bug
  const network = error instanceof TypeError && (/fetch failed|terminated/i.test(error.message) || (error as { cause?: unknown }).cause !== undefined);
  return network || (error as Error | null)?.name === "TimeoutError";
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", stop, { once: true });
});

async function waitOnJob(ctx: VerbContext, client: HeadlessClient, target: Target,
  options: { scope: "job" | "turn" }, watching: Watching): Promise<Waited> {
  const policy = waitPolicy(ctx);
  const deadline = Date.now() + policy.timeoutMs;
  let after: string | undefined;
  let result: Rec;
  let drops = 0;
  for (;;) {
    const seconds = Math.min(MCP_WAIT_MAX_S, Math.max(1, Math.ceil((deadline - Date.now()) / 1_000)));
    const { threadId, since } = watching;
    try {
      result = await client.tool("wait_for_conversation", {
        target_type: target.type, target_id: target.id, ...(threadId ? { task_id: threadId } : {}), timeout_seconds: seconds, scope: options.scope,
        ...(since !== undefined ? { since_ms: since } : {}), ...(after !== undefined ? { after_version: after } : {}),
      }, {
        onProgress: (job) => {
          if (typeof job.threadId === "string") watching.threadId ??= job.threadId;
          if (typeof job.since === "number") watching.since = job.since;
          ctx.output.progress({ event: "job", threadId: job.threadId, state: job.state, reason: job.reason, counts: job.counts,
            ...(job.needsInput?.length ? { needsInput: job.needsInput } : {}) });
        },
      }, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted || !passing(error) || Date.now() >= deadline) throw error;
      const inMs = Math.min(10_000, 1_000 * 2 ** Math.min(drops++, 4), Math.max(0, deadline - Date.now()));
      ctx.output.progress({ event: "reconnecting", inMs, ...(watching.threadId ? { threadId: watching.threadId } : {}) });
      await pause(inMs, ctx.signal);
      continue;
    }
    drops = 0;
    watching.threadId ??= result.taskId;
    if (typeof result.job?.since === "number") watching.since = result.job.since;
    const more = Date.now() < deadline && (result.status === "timed-out" || (result.status === "needs-user" && policy.onInput === "wait"));
    if (!more) break;
    after = result.job?.version;
  }
  let exitCode = exitFor(result, policy.strict);
  if (exitCode === EXIT.needsInput && policy.onInput === "wait") exitCode = EXIT.timeout;
  const stop = (exitCode === EXIT.needsInput && policy.onInput === "stop") || (exitCode === EXIT.timeout && policy.onTimeout === "stop");
  if (!stop) return { result, exitCode };
  const { stopped } = await stopConversation(client, { ...target, taskId: result.taskId }, true);
  return { result, exitCode, stopped };
}

const HEADLINE: Record<number, string> = {
  [EXIT.done]: "Done", [EXIT.failed]: "Did not finish", [EXIT.needsInput]: "Needs you", [EXIT.timeout]: "Still running",
};

function finalReply(messages: readonly Rec[] | undefined): { text: string; from?: string; files: string[] } | undefined {
  const reply = [...(messages ?? [])].reverse().find((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
  return reply ? { text: reply.text, ...(reply.from?.name ? { from: reply.from.name } : {}), files: messageFileTargets(reply.text) } : undefined;
}

const waitAgain = (watching: Watching): string => `openmausbot wait --thread ${watching.threadId}${watching.since !== undefined ? ` --since ${watching.since}` : ""}`;

function report(waited: Waited, threadId: string, extra: Rec = {}): { result: Rec; human: string[] } {
  const { result, exitCode } = waited;
  const reply = finalReply(result.messages);
  const job = result.job ?? {};
  const human = [
    `${HEADLINE[exitCode] ?? "Ended"}: ${waited.reason ?? job.reason ?? result.status}${exitCode === EXIT.timeout ? " (it keeps running)" : ""}`,
    ...(reply ? ["", reply.text, ""] : []),
    ...(reply?.files.length ? [`Files: ${reply.files.join(", ")}`] : []),
    ...(job.needsInput?.length ? job.needsInput.map((item: Rec) => `${item.botName} asks: ${oneLine(item.question, 300)}`) : []),
    ...(waited.stopped ? [`Stopped the conversation${waited.stopped.length ? ` and ${waited.stopped.length} teammate task${waited.stopped.length === 1 ? "" : "s"}` : ""}.`] : []),
    `Thread: ${threadId}${exitCode === EXIT.done ? "" : ` (wait again: ${waitAgain({ threadId, ...(typeof job.since === "number" ? { since: job.since } : {}) })})`}`,
  ];
  return {
    result: { ...result, ok: exitCode === EXIT.done, exitCode, threadId, ...(waited.reason ? { reason: waited.reason } : {}), ...(reply ? { reply } : {}),
      ...(waited.stopped ? { stopped: waited.stopped } : {}), ...extra },
    human,
  };
}

const interrupted = (watching: Watching): HeadlessError =>
  new HeadlessError("stopped waiting; the work keeps running", EXIT.interrupted,
    watching.threadId ? `wait again: ${waitAgain(watching)}` : "openmausbot wait TARGET picks it up again");

export async function runVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const named = Boolean(flag(ctx.flags, "bot") ?? flag(ctx.flags, "channel") ?? flag(ctx.flags, "thread"));
  const [first, second] = ctx.positionals;
  const text = await readMessage(ctx, named ? first : second);
  const mode = oneOf(flag(ctx.flags, "wait"), "--wait", ["job", "turn", "none"] as const, "job");
  waitPolicy(ctx);
  const out = flag(ctx.flags, "export")?.trim();
  // --wait none returns before the job ends, so nothing would ever be exported: refuse it before sending.
  if (out && mode === "none") throw usageError("--export needs --wait job or --wait turn", "run openmausbot help run");
  if (out) exportFolder(out, ctx.flags.force === true);
  const task = flag(ctx.flags, "task")?.trim() || (flag(ctx.flags, "thread") ? undefined : "new");
  const target = await resolveTarget({ ...ctx, flags: { ...ctx.flags, task: undefined } }, named ? undefined : first);
  const client = await ctx.client();
  const threadId = target.taskId ?? await conversationFor(client, target, task!, conversationTitle(ctx, text));
  const since = Number((await readJob(client, threadId)).now);
  const sendId = flag(ctx.flags, "send-id") ?? newSendId();
  const tool = target.type === "bot" ? "send_bot_message" : "send_channel_message";
  const args = { [`${target.type}_id`]: target.id, task_id: threadId, text, send_id: sendId };
  let sent: Rec | undefined;
  for (let attempt = 1; !sent; attempt++) {
    try {
      sent = await client.tool(tool, args);
    } catch (error) {
      // The same send id makes a retry land on the first send, never beside it.
      if (!passing(error) || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  ctx.output.progress({ event: "started", threadId, target: { type: target.type, id: target.id, ...(target.name ? { name: target.name } : {}) },
    sendId, ...(sent.messageId ? { messageId: sent.messageId } : {}), ...(sent.queued ? { queued: true } : {}), since });
  if (mode === "none") {
    return {
      result: { ok: true, exitCode: EXIT.done, threadId, sendId, since, ...sent },
      exitCode: EXIT.done,
      human: [`Sent. Thread: ${threadId}`, `Wait for it with: openmausbot wait --thread ${threadId} --since ${since}`],
    };
  }
  let waited: Waited;
  const watching: Watching = { threadId, since };
  try {
    waited = await waitOnJob(ctx, client, target, { scope: mode }, watching);
  } catch (error) {
    if (ctx.signal.aborted) throw interrupted(watching);
    throw error;
  }
  if (waited.result.state === "idle") {
    waited = { ...waited, exitCode: EXIT.failed, reason: "no turn ran for the message: nobody took it up (a room set to answer mentions answers only the bots a message names)" };
  }
  let exported: Rec | undefined;
  if (out) {
    try {
      exported = await exportJob(client, { threadId, out, since, force: true }, ctx.output);
    } catch (error) {
      exported = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const { result, human } = report(waited, threadId, { sendId, since, ...(exported ? { export: exported } : {}) });
  if (exported) human.push(exported.ok === false ? `Export failed: ${exported.error}` : `Exported to ${exported.out} (${exported.files?.length ?? 0} files, ${exported.transcripts?.length ?? 0} transcripts).`);
  return { result, exitCode: exported?.ok === false && waited.exitCode === EXIT.done ? EXIT.failed : waited.exitCode, human };
}

export async function waitVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const scope = oneOf(flag(ctx.flags, "for"), "--for", ["job", "turn"] as const, "job");
  const rawSince = flag(ctx.flags, "since");
  const since = rawSince === undefined ? undefined : parseCount(rawSince, "--since", 0, Number.MAX_SAFE_INTEGER, 0);
  waitPolicy(ctx);
  const target = await resolveTarget(ctx, ctx.positionals[0]);
  const client = await ctx.client();
  let waited: Waited;
  const watching: Watching = { ...(target.taskId ? { threadId: target.taskId } : {}), ...(since !== undefined ? { since } : {}) };
  try {
    waited = await waitOnJob(ctx, client, target, { scope }, watching);
  } catch (error) {
    if (ctx.signal.aborted) throw interrupted(watching);
    throw error;
  }
  const { human } = report(waited, waited.result.taskId);
  // control-omb and MCP read the tool's own result: keep it as it came.
  return { result: waited.stopped ? { ...waited.result, stopped: waited.stopped } : waited.result, exitCode: waited.exitCode, human };
}
