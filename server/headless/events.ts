// Resumes from its cursor after a drop: the server's hello line says whether it could (resumed: false means "read the
// state again"). --until-settled ends when the job does, with the job's exit code.
import { FINAL_JOB_STATES } from "../../shared/job-state.ts";
import { EXIT, flag, usageError } from "./args.ts";
import { readJob } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import { redactDeep } from "./output.ts";

type Frame = Record<string, any>;

export const DEFAULT_EVENT_KINDS = ["message", "message.patch", "thread", "bot", "group"];

export function frameThreads(frame: Frame): string[] {
  const own = (record: Frame | undefined) => [record?.threadId, ...(Array.isArray(record?.tasks) ? record.tasks.map((task: Frame) => task.threadId) : [])];
  switch (frame.kind) {
    case "message": case "message.patch": case "thread": return [frame.threadId];
    case "runtime": return [frame.event?.threadId];
    case "bot": return own(frame.bot);
    case "group": return own(frame.group);
    default: return [];
  }
}

export function wantFrame(frame: Frame, kinds: ReadonlySet<string>, threads: ReadonlySet<string> | null): boolean {
  if (frame.kind === "hello") return true;
  if (frame.kind === "ping" || !kinds.has(frame.kind)) return false;
  return !threads || frameThreads(frame).some((thread) => typeof thread === "string" && threads.has(thread));
}

export async function* sseFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ id?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { ...(id ? { id } : {}), data: data.join("\n") };
    }
  }
}

const jobExit = (state: string) => state === "needs-input" || state === "blocked" ? EXIT.needsInput
  : state === "cancelled" ? EXIT.interrupted : state === "failed" || state === "stalled" ? EXIT.failed : EXIT.done;

export async function eventsVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const job = flag(ctx.flags, "job")?.trim();
  const untilSettled = ctx.flags["until-settled"] === true;
  if (untilSettled && !job) throw usageError("--until-settled needs --job THREAD_ID");
  const screens = ctx.flags.screens === true;
  const kinds = new Set(flag(ctx.flags, "kind") ? flag(ctx.flags, "kind")!.split(",").map((kind) => kind.trim()).filter(Boolean) : DEFAULT_EVENT_KINDS);
  if (screens) kinds.add("screen");
  const named = (ctx.flags.thread as string[] | undefined) ?? [];
  const threads = named.length || job ? new Set([...named, ...(job ? [job] : [])]) : null;
  let cursor = flag(ctx.flags, "since")?.trim();
  const client = await ctx.client();

  let since: number | undefined;
  let settled: string | undefined;
  let refreshing: Promise<void> | undefined;
  let again = false;
  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.signal, stop.signal]);
  const refresh = async () => {
    const view = await readJob(client, job!, since === undefined ? {} : { since: String(since) });
    since ??= Number(view.since);
    for (const node of view.nodes ?? []) threads!.add(node.threadId);
    if (untilSettled && FINAL_JOB_STATES.has(view.state)) {
      settled = view.state;
      ctx.io.out(JSON.stringify(redactDeep({ kind: "job", threadId: job, state: view.state, reason: view.reason, counts: view.counts })));
      stop.abort();
    }
  };
  if (job) await refresh();
  // The last change of a job can land without a frame of its own, or while a read is already under way.
  const schedule = () => {
    if (refreshing) { again = true; return; }
    refreshing = new Promise<void>((done) => setTimeout(done, 300)).then(refresh).catch(() => undefined).finally(() => {
      refreshing = undefined;
      if (again && !signal.aborted) { again = false; schedule(); }
    });
  };

  for (let attempt = 0; !signal.aborted; attempt++) {
    let response: Response;
    try {
      const query = new URLSearchParams({ screens: screens ? "on" : "off", ...(cursor ? { since: cursor } : {}) });
      response = await client.raw(`/api/events?${query.toString()}`, { stream: true, headers: { accept: "text/event-stream" }, signal });
      // A refusal (an expired token, a missing scope) does not go away by asking again.
      if (response.status >= 400 && response.status < 500) {
        const said = ((await response.json().catch(() => ({}))) as Frame).error;
        throw Object.assign(new Error(`the event stream was refused${typeof said === "string" ? `: ${said}` : ` (${response.status})`}`), { status: response.status });
      }
      if (!response.ok || !response.body) throw new Error(`the event stream answered ${response.status}`);
      attempt = 0;
      for await (const { id, data } of sseFrames(response.body as unknown as AsyncIterable<Uint8Array>)) {
        if (id) cursor = id;
        let frame: Frame;
        try { frame = JSON.parse(data); } catch { continue; }
        if (wantFrame(frame, kinds, threads)) ctx.io.out(JSON.stringify(redactDeep(frame)));
        if (job && ["bot", "group", "message", "hello", "ping"].includes(frame.kind)) schedule();
      }
    } catch (error) {
      if (signal.aborted) break;
      const status = (error as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) throw error;
    }
    if (signal.aborted) break;
    const delay = Math.min(10_000, 1_000 * 2 ** Math.min(attempt, 4));
    ctx.output.progress({ event: "reconnecting", inMs: delay, ...(cursor ? { cursor } : {}) });
    await new Promise((resolve) => { const timer = setTimeout(resolve, delay); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true }); });
  }
  await refreshing;
  if (!settled && ctx.signal.aborted) return { result: { ok: true, cursor }, exitCode: EXIT.interrupted, human: [], printed: true };
  return { result: { ok: true, cursor, ...(settled ? { state: settled } : {}) }, exitCode: settled ? jobExit(settled) : EXIT.done, human: [], printed: true };
}
