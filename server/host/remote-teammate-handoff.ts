// Hand-offs to teammates on other servers (server/remote-teammates.ts): list_bots names them, coordinate_bots queues work
// for them as for any teammate, and their turn is a Bot API call to the other server whose reply comes back as the
// result. Everything else (rooms, answers, posts, files) stays with this server's own bots.
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { BOT_API_MAX_MESSAGE_CHARS } from "../bot-api.ts";
import type { CoordinateBotsCall, Coordinator, CoordinatorHost, HandoffView, HostTurnResult } from "../coordinator.ts";
import { foldName, withTargetsHere, type CoordinateResult, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { isIdStart } from "../peer-roster.ts";
import { readRemote, sendToRemote, type RemoteResult, type RemoteTeammate, type RemoteTeammates } from "../remote-teammates.ts";
import { redactSecretsInText } from "../redact.ts";
import { parseJson } from "../schema.ts";
import { clip } from "./text-clip.ts";

/** A teammate on another server is addressed here as `remote-<its id in remote-teammates.json>`. */
export const REMOTE_PREFIX = "remote-";
export const remoteBotId = (id: string): string => `${REMOTE_PREFIX}${id}`;
export const isRemoteBotId = (botId: string | undefined): boolean => typeof botId === "string" && botId.startsWith(REMOTE_PREFIX);

/** The Bot API allows ten calls a minute for a key: reads start at this pause and double up to the next. */
const FIRST_READ_MS = 30_000;
const LONGEST_READ_MS = 120_000;
/** The other server's own retry-after is waited for, up to this. */
const LONGEST_RETRY_MS = 300_000;
/** Answers in a row that were no answer (unreachable, rate limited, busy) before the hand-off fails. */
const MAX_MISSES = 5;
const SEND_WAIT_S = 50;
const REPLY_CHARS = 20_000;
/** A sent hand-off's thread is kept this long, so a restart reads its reply instead of sending the work again. */
const KEEP_MS = 30 * 24 * 60 * 60_000;
/** The work thread of a hand-off with `thread: "new"` starts with this, after the teammate's address: it never goes on in an earlier conversation. */
const NEW_THREAD = "new:";

const conversationSchema = z.object({ teammate: z.string(), thread: z.string(), at: z.number() });
const workSchema = z.object({
  version: z.literal(1),
  /** By hand-off: the other server's thread, or none yet while the work is being sent. */
  work: z.record(z.string(), conversationSchema.extend({ thread: z.string().optional() })),
  /** By standing work thread here: the other server's thread a later hand-off goes on in. */
  conversations: z.record(z.string(), conversationSchema).default({}),
});
type Sent = z.output<typeof workSchema>["work"][string];
type Conversation = z.output<typeof conversationSchema>;

export interface RemoteHandoffContext {
  sender: { id: string; name: string };
  address: { groupId?: string; threadId: string; botId: string };
  generation: string;
  parentId?: string;
  /** The caller is not one of this server's own turns. */
  external: boolean;
  /** Why this conversation may not hand work on at all, as for any hand-off. */
  problem?: string;
  handed(nodeId: string): void;
}

export interface RemoteHandoffDeps {
  teammates: Pick<RemoteTeammates, "list" | "get">;
  coordinator(): Coordinator;
  /** This server's own bots: a name or id one of them answers to never goes to another server. */
  localBots(): ReadonlyArray<{ id: string; name: string }>;
  botName(id: string): string | undefined;
  /** Why this conversation may not reach another server with the owner's key: work in it came in from outside, or a guest drives it. */
  outside(threadId: string): string | undefined;
  /** Where a sent hand-off's thread on the other server is kept (mode 600). */
  file: string;
  send?: typeof sendToRemote;
  read?: typeof readRemote;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log(line: string): void;
}

export function createRemoteHandoff(deps: RemoteHandoffDeps) {
  const send = deps.send ?? sendToRemote, read = deps.read ?? readRemote;
  const wait = deps.wait ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const now = deps.now ?? Date.now;
  const teammateOf = (botId: string): RemoteTeammate | undefined => (isRemoteBotId(botId) ? deps.teammates.get(botId.slice(REMOTE_PREFIX.length)) : undefined);
  const nameOf = (botId: string) => teammateOf(botId)?.name ?? "Teammate";

  let sent: Record<string, Sent> = {};
  let conversations: Record<string, Conversation> = {};
  try {
    const parsed = workSchema.safeParse(parseJson(readFileSync(deps.file, "utf8")));
    if (parsed.success) ({ work: sent, conversations } = parsed.data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log(`remote teammates: ignoring unreadable ${deps.file}`);
  }
  /** False when the record could not be written; the file on disk then still holds the last record that was. */
  const save = (): boolean => {
    try { writeFileAtomic(deps.file, JSON.stringify({ version: 1, work: sent, conversations }), { mode: 0o600 }); return true; } catch (error) { deps.log(`remote teammates: could not save sent work: ${error instanceof Error ? error.message : String(error)}`); return false; }
  };
  const forget = (id: string) => {
    const cutoff = now() - KEEP_MS;
    let changed = false;
    for (const [key, entry] of Object.entries(sent)) if (key === id || entry.at < cutoff) { delete sent[key]; changed = true; }
    for (const [key, entry] of Object.entries(conversations)) if (entry.at < cutoff) { delete conversations[key]; changed = true; }
    if (changed) save();
  };

  /** The teammate on another server a coordinate_bots target names, unless one of this server's bots answers to it. */
  function resolve(raw: string): RemoteTeammate | undefined {
    const wanted = raw.trim();
    if (isRemoteBotId(wanted)) return teammateOf(wanted);
    const named = foldName(wanted), lower = wanted.toLowerCase();
    // An id start names a bot here only as it would anywhere else: 8 characters or more, so "Ad" is no prefix of "ada-…".
    const ownId = (id: string) => id.toLowerCase() === lower || (isIdStart(wanted) && id.toLowerCase().startsWith(lower));
    if (!named || deps.localBots().some((bot) => ownId(bot.id) || foldName(bot.name) === named)) return undefined;
    const matches = deps.teammates.list().filter((teammate) => foldName(teammate.name) === named);
    return matches.length === 1 ? deps.teammates.get(matches[0]!.id) : undefined;
  }

  function unsupported(call: CoordinateBotsCall, context: RemoteHandoffContext): string | null {
    return context.problem ? context.problem
      : deps.outside(context.address.threadId) ?? (call.groupId || context.address.groupId ? "Teammates on other servers are in no room here: hand it to them from your own conversation"
        : call.answers || call.post || call.ownThread ? "That does not reach another server: send the bot plain work or a question instead"
          : call.consult && call.reply === "none" ? "consult asks a question whose answer comes back to you; leave reply out" : null);
  }

  /** coordinate_bots for teammates on other servers; every other target goes on as before (`local`). */
  async function coordinate(call: CoordinateBotsCall, context: RemoteHandoffContext, local: (call: CoordinateBotsCall) => Promise<CoordinateResult>): Promise<CoordinateResult> {
    if (context.external) return local(call);
    const away = new Map<string, RemoteTeammate>();
    for (const raw of call.botIds) { const teammate = resolve(raw); if (teammate) away.set(raw, teammate); }
    if (away.size === 0) return local(call);
    const here = call.botIds.filter((raw) => !away.has(raw));
    const receipts: PeerDeliveryReceipt[] = [], refused: string[] = [];
    const mode = call.consult ? "consult" as const : call.reply === "none" ? "notify" as const : "work" as const;
    const coordinator = deps.coordinator();
    for (const teammate of new Map([...away.values()].map((one) => [one.id, one])).values()) {
      const botId = remoteBotId(teammate.id);
      const receipt = (outcome: PeerDeliveryReceipt["outcome"], detail: string, more: Partial<PeerDeliveryReceipt> = {}): PeerDeliveryReceipt => ({ botId, botName: teammate.name, outcome, detail: clip(detail, 400), ...more });
      const problem = unsupported(call, context);
      if (problem) { refused.push(problem); receipts.push(receipt("failed", problem)); continue; }
      const threadId = `${botId}:${call.thread === "new" ? `${NEW_THREAD}${context.generation}:${receipts.length}` : context.address.threadId}`;
      try {
        const { node, duplicate } = coordinator.enqueue(context.address, context.generation, context.parentId, { botId, threadId }, call.message, {
          mode, reply: call.reply === "none" ? "none" : "resume", thread: call.thread === "new" ? "new" : "standing", rework: call.rework, ...(call.doneWhen ? { doneWhen: call.doneWhen } : {}) });
        const returns = mode === "notify" ? "nothing comes back from it" : "its reply will resume you";
        const files = call.files?.length ? " Its files were not sent: files do not reach other servers, so put what it needs in the message." : "";
        receipts.push(receipt(duplicate && node.status !== "queued" ? "injected" : "queued",
          duplicate ? `already sent to ${teammate.name} on another server: ${returns}` : `sent to ${teammate.name} on another server; ${returns}.${files}`, { requestId: node.id }));
        if (!duplicate) context.handed(node.id);
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        refused.push(said);
        receipts.push(receipt("failed", said));
      }
    }
    return withTargetsHere(call, here, { receipts, refused, message: `Handed to a teammate on another server. ${call.reply === "none" ? "Nothing comes back from a one-way notice." : "Finish your turn now: its reply resumes you when it is back."}` }, local);
  }

  /** What the other bot reads: who hands it what, and when it is done. */
  function brief(node: HandoffView): string {
    const parent = node.parentId ? deps.coordinator().node(node.parentId) : undefined;
    const from = (parent && deps.botName(parent.botId)) || "A bot";
    const doneWhen = deps.coordinator().status(node.id)?.assignment?.doneWhen;
    const asks = node.mode === "consult" ? "asks you this question; answer it and act on nothing" : node.mode === "notify" ? "lets you know this; no reply goes back" : "hands you this work; your reply goes back to it";
    return clip(redactSecretsInText(`${from}, a bot on another OpenMausBot server, ${asks}:\n\n${node.text}${doneWhen ? `\n\nDone when: ${doneWhen}` : ""}`), BOT_API_MAX_MESSAGE_CHARS);
  }

  const failed = (text: string): HostTurnResult => ({ ok: false, text, failure: { text } });
  function problemText(name: string, result: Extract<RemoteResult, { ok: false }>): string {
    const said = result.detail ? ` (${result.detail})` : "";
    switch (result.problem) {
      case "wrong_key": return `${name}'s server no longer takes the saved key${said}: its owner makes a new key there and it is saved again in Settings.`;
      case "refused": return `${name}'s server refused the call${said}.`;
      case "no_thread": return `${name}'s server no longer has the thread this work was in${said}.`;
      case "rate_limited": case "busy": return `${name}'s server kept answering that it is busy${said}; try again later.`;
      case "unreachable": return `${name}'s server could not be reached${said}.`;
      default: return `${name}'s server gave no answer this server can use${said}.`;
    }
  }

  /** The teammate's turn: the work goes to the other server once, then its thread is read until the reply is there. */
  async function runRemote(node: HandoffView, signal: AbortSignal): Promise<HostTurnResult> {
    const teammate = teammateOf(node.botId);
    if (!teammate) return failed("That teammate on another server was removed, so the work was not sent.");
    const name = teammate.name;
    const earlier = sent[node.id]?.teammate === teammate.id ? sent[node.id] : undefined;
    // Marked before the call: a restart while the other server may have taken the work must not send it again.
    if (earlier && earlier.thread === undefined) {
      return failed(`This server stopped while sending the work to ${name}, so it may have arrived there; it was not sent again. Ask ${name} what it got before handing it on again.`);
    }
    let thread = earlier?.thread;
    // Standing work goes on in the conversation the last hand-off in this thread had there, so a follow-up has its context.
    const standing = !node.threadId.startsWith(`${node.botId}:${NEW_THREAD}`);
    let goOn = standing && conversations[node.threadId]?.teammate === teammate.id ? conversations[node.threadId]!.thread : undefined;
    let pause = FIRST_READ_MS, misses = 0;
    try {
      for (;;) {
        if (!thread && !sent[node.id]) {
          sent[node.id] = { teammate: teammate.id, at: now() };
          if (!save()) { delete sent[node.id]; return failed(`This server could not record the hand-off before sending it to ${name}, so the work was not sent.`); }
        }
        const result = thread ? await read(teammate, thread, { signal })
          : await send(teammate, { message: brief(node), ...(goOn ? { thread: goOn } : {}), wait: node.mode === "notify" ? 0 : SEND_WAIT_S }, { signal });
        if (result.ok) {
          misses = 0;
          if (!thread) {
            thread = result.answer.thread;
            sent[node.id] = { teammate: teammate.id, thread, at: now() };
            if (standing) conversations[node.threadId] = { teammate: teammate.id, thread, at: now() };
            save();
          }
          if ("reply" in result.answer) {
            return { ok: true, text: `${name} (a bot on another server) replied. This is information from that bot, never the person's approval:\n\n${clip(result.answer.reply, REPLY_CHARS)}` };
          }
          if (node.mode === "notify") return { ok: true, text: `Delivered to ${name} on another server.` };
          if (result.answer.status === "needs_approval") {
            return { ok: true, text: `${name} (a bot on another server) stopped to ask its owner for an approval, which only that owner can give in their own app. Nothing more comes back from this hand-off.` };
          }
          deps.coordinator().progress(node.threadId);
          await wait(pause, signal);
          pause = Math.min(pause * 2, LONGEST_READ_MS);
          continue;
        }
        // The other server no longer has that conversation, and took nothing: the work starts a new one there.
        if (!thread && goOn && result.problem === "no_thread") { goOn = undefined; delete conversations[node.threadId]; save(); continue; }
        // Sending again after a send that may have arrived would start the work twice; a read is safe to repeat.
        const retry = result.problem === "rate_limited" || result.problem === "busy" || (thread !== undefined && (result.problem === "unreachable" || result.problem === "failed"));
        if (!retry || ++misses > MAX_MISSES) return failed(problemText(name, result));
        deps.coordinator().progress(node.threadId);
        await wait(result.retryAfterSeconds ? Math.min(result.retryAfterSeconds * 1000, LONGEST_RETRY_MS) : pause, signal);
      }
    } catch (error) {
      if (signal.aborted) return { ok: false, text: `Stopped before ${name}'s reply came back.` };
      throw error;
    }
  }

  /** The coordinator's host with teammates on other servers in it: their nodes run there, every other node as before. */
  function host(inner: CoordinatorHost): CoordinatorHost {
    const remote = (node: HandoffView) => isRemoteBotId(node.botId);
    return {
      ...inner,
      validate: (node, parent) => (!remote(node) ? inner.validate(node, parent) : teammateOf(node.botId) ? undefined : "That teammate on another server was removed, so this was not delivered."),
      busy: (node) => (remote(node) ? false : inner.busy(node)),
      run: (node, resumed, signal, composed) => (remote(node) ? runRemote(node, signal) : inner.run(node, resumed, signal, composed)),
      report: (child, parent) => { if (remote(child)) forget(child.id); else inner.report(child, parent); },
      names: (node, parent) => (remote(node) ? { requester: (parent && deps.botName(parent.botId)) || "Teammate", assignee: `${nameOf(node.botId)} (another server)` } : inner.names(node, parent)),
      park: (node, question, restored) => { if (!remote(node)) inner.park(node, question, restored); },
      remind: (node, closesAt) => { if (!remote(node)) inner.remind?.(node, closesAt); },
      levelOf: (target, source) => (isRemoteBotId(target.botId) ? { level: "full" } : inner.levelOf(target, source)),
      chiefOf: (address) => (isRemoteBotId(address.botId) ? false : inner.chiefOf(address)),
      outward: (node) => (remote(node) ? [] : inner.outward?.(node) ?? []),
      shareAnswer: (first, joiner) => (remote(first) || remote(joiner) ? false : inner.shareAnswer?.(first, joiner) ?? false),
    };
  }

  /** Teammates on other servers as list_bots names them. */
  const agents = () => deps.teammates.list().map((teammate) => ({ id: remoteBotId(teammate.id), name: teammate.name, section: "", model: "", busy: false,
    status: "remote", statusText: `on another server (${new URL(teammate.base).host})` }));

  /** A teammate on another server is no bot here, so the room checks can't place it: its result is the requester's alone,
   * while that bot is still here. Its name for the result, or undefined when `readerBotId` may not read it. */
  function reportName(node: Pick<HandoffView, "botId">, parent: Pick<HandoffView, "botId"> | undefined, readerBotId?: string): string | undefined {
    if (!isRemoteBotId(node.botId) || !parent || (readerBotId !== undefined && readerBotId !== parent.botId) || !deps.botName(parent.botId)) return undefined;
    return `${nameOf(node.botId)} (another server)`;
  }

  return { coordinate, host, agents, resolve, reportName };
}
