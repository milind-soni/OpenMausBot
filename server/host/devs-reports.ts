// @devs: a person's message that tags it sends exactly one bug report to the MausBot team. The bot answering it is
// asked (a note on its turn, and report_bug) to add a summary; when none comes, because its engine has no tools, its
// turn failed, it never called report_bug or no bot answered, the server sends the report with its own facts once
// nothing runs in the conversation any more. The person's message and that summary are the only words that go, never
// the conversation. A report that cannot go yet waits in devs-reports.json and is sent again on its own.
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { tagsDevs, withoutDevsTags } from "../../shared/devs-mention.ts";
import { failedTurnCause } from "../../shared/failed-turn.ts";
import type { ResolvedSender } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { ProviderSnapshot } from "../contracts.ts";
import { buildDevsReport, contactAddress, environmentSecrets, redactReportText, type BotSummary, type DevsReportPayload, type ReportedBot } from "../devs-report.ts";
import type { SendOutcome } from "../devs-report-send.ts";
import { DEVS_REPORT_PATH } from "../drivers/agents-devs-tools.ts";
import type { json as sendJson } from "../harness/http.ts";
import { personKey } from "../person-key.ts";
import type { RecentLog } from "../recent-log.ts";
import { PASS } from "../routes/table.ts";
import type { PublicSession } from "../sessions.ts";
import type { BotRecord, Message, Store, StoreChange } from "../store.ts";
import { clip } from "./text-clip.ts";

export const DEVS_REPORTS_FILE = "devs-reports.json";
const TICK_MS = 2_000;
/** No turn began this long after the message: no bot will write a summary. */
export const NO_ANSWER_MS = 20_000;
/** A turn still running this long after the message: the report goes without waiting for its summary. */
export const LONGEST_WAIT_MS = 10 * 60_000;
export const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const KEPT_MS = 7 * 24 * 3_600_000;
export const MAX_OUTBOX = 20;
const MAX_WAITING = 50;
/** A line older than this is history arriving (a restore, a move), not a person writing now. */
const FRESH_MS = 10 * 60_000;
const REPEAT_MS = 30 * 60_000;
const SCANNED_LINES = 300;

const id = z.string().min(1).max(200);
const waitingSchema = z.object({ messageId: id, threadId: id, at: z.number(), text: z.string().max(20_000), words: z.string().max(20_000),
  sender: z.object({ name: z.string().max(200), id: z.string().max(200).optional() }).optional() });
const payloadSchema = z.object({ installId: z.string(), source: z.literal("bot"), description: z.string(), appVersion: z.string(), platform: z.string(),
  diagnostics: z.string(), contactEmail: z.string().optional(), contact: z.string().optional() });
const queuedSchema = z.object({ messageId: id, threadId: id, payload: payloadSchema, firstAt: z.number(), attempts: z.number().int().min(0), nextAt: z.number() });
const fileSchema = z.object({ version: z.literal(1), waiting: z.array(waitingSchema).max(MAX_WAITING), outbox: z.array(queuedSchema).max(MAX_OUTBOX) });
const bodySchema = z.object({
  went_wrong: z.string().trim().min(1).max(2_000), you_saw: z.string().trim().max(3_000).optional(), steps: z.string().trim().max(2_000).optional(),
}).strict();

type Waiting = z.infer<typeof waitingSchema> & { answered?: boolean; offered?: boolean; restored?: boolean };
type Queued = z.infer<typeof queuedSchema>;
/** What the person is told, and the words in a bot's reply that show it already told them. */
type Told = { ok: boolean; line: string; marker: string };
type Author = { bot: BotRecord; summary: BotSummary } | { why: string };

export interface DevsReportsDeps {
  dataDir: string;
  store: Pick<Store, "bots" | "bot" | "botByThread" | "groupByThread" | "projectBotForTask" | "activePath" | "appendMessage" | "onChange">;
  installId: string;
  appVersion: string;
  /** Where this server runs, as the team reads it: desktop app, My Cloud, Team Cloud… */
  runsOn: string;
  /** A turn runs, or is starting, in this conversation. */
  working(threadId: string): boolean;
  /** A routine or webhook run is writing in this conversation, so a line without a sendId is its, not a person's. */
  automated(threadId: string): boolean;
  engine(instanceId: string): { name: string; snapshot?: ProviderSnapshot } | null;
  appsReady(): boolean;
  sessions(): PublicSession[];
  /** My Cloud's owner key: the owner's lines carry it instead of their session's person key. */
  ownerKey: string | null;
  /** On a Team Cloud the server's profile is nobody's, so only a session's address counts. */
  team: boolean;
  profileEmail(): string | undefined;
  language(): string | undefined;
  recentLog: RecentLog;
  send(payload: DevsReportPayload): Promise<SendOutcome>;
  now?: () => number;
  /** Tests: drive the clock by hand. */
  timer?: false;
}

export interface DevsReportContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

export const sentLine = (reportId: string, contact?: string) =>
  `Sent to the MausBot team (report ${reportId}). Milind and Omkar get it by email${contact ? ` and will reply to ${contact}` : ""}.`;
const laterLine = (reportId: string, contact?: string) =>
  `Sent to the MausBot team (report ${reportId}) after an earlier try did not go through. Milind and Omkar get it by email${contact ? ` and will reply to ${contact}` : ""}.`;
function notYetLine(outcome: Extract<SendOutcome, { retry: true }>): string {
  const minutes = outcome.retryAfterMs ? Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000)) : 0;
  const why = outcome.why === "limited" ? "the MausBot team takes only a few reports an hour from each app"
    : outcome.why === "offline" ? "the MausBot team's server could not be reached" : "the MausBot team's server could not take it right now";
  return `Not sent yet: ${why}. The report is saved and goes on its own${minutes ? ` in about ${minutes} minute${minutes === 1 ? "" : "s"}` : " as soon as it can"}, so there is no need to send it again.`;
}
const refusedLine = (detail: string) => `The MausBot team's server refused this bug report, so nothing was sent: ${detail.replace(/[.\s]+$/, "")}.`;
const fullLine = `Not sent: ${MAX_OUTBOX} bug reports are already waiting to go to the MausBot team. Type @devs again once they have gone.`;
const droppedLine = "A bug report from this conversation could not reach the MausBot team for a week, so it was dropped. Type @devs again to send a new one.";

/** Rides on the turn that answers a @devs message. */
const TURN_NOTE = "\n\n[From OpenMausBot, not the person: this message tags @devs, so it is a bug report for the MausBot team, OpenMausBot's developers. Call report_bug once, first: what the person says went wrong; what you saw yourself in this conversation (errors, failed tools, stuck steps), or that you saw nothing unusual; and steps to reproduce. Leave out passwords, keys, tokens and file contents; OpenMausBot adds the app's own diagnostics. Then tell the person, word for word, the line report_bug returns, and help with the problem if you can.]";

const iso = (at: number) => new Date(at).toISOString();
const firstLine = (text: string | undefined) => (text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";

/** What went wrong in this conversation lately, as rows the server wrote: failed turns, failed tools, stops, notices. */
export function conversationProblems(lines: readonly Message[]): string[] {
  const found: string[] = [];
  for (const line of lines.slice(-SCANNED_LINES)) {
    const at = iso(line.at);
    if (line.kind === "activity" && line.tool) {
      const { name } = line.tool;
      const cause = failedTurnCause(name);
      if (cause !== null) found.push(`${at} turn failed: ${cause}${line.tool.setup ? " (needs setup)" : ""}`);
      else if (/^(stopped|notice|recovery):/.test(name)) found.push(`${at} ${name}`);
      else if (line.tool.ok === false) {
        const detail = clip(firstLine(line.tool.output), 200);
        found.push(`${at} tool ${name} failed${detail ? `: ${detail}` : ""}`);
      }
    } else if (line.role === "bot" && line.kind === "text" && line.turnSucceeded === false) {
      found.push(`${at} turn ${line.turnId ?? ""} ended without success`.replace("  ", " "));
    } else if (line.role === "user" && line.requestCancelled) {
      found.push(`${at} the person's request was stopped`);
    }
  }
  return found;
}

function health(snapshot: ProviderSnapshot | undefined): string {
  if (!snapshot) return "not checked yet";
  const signedIn = snapshot.authenticated === undefined ? "" : snapshot.authenticated ? ", signed in" : ", not signed in";
  return `${snapshot.state}${snapshot.reason ? ` (${clip(snapshot.reason, 200)})` : ""}${signedIn}${snapshot.version ? `, version ${snapshot.version}` : ""}`;
}

export function createDevsReports(deps: DevsReportsDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const file = join(deps.dataDir, DEVS_REPORTS_FILE);
  let waiting: Waiting[] = [];
  let outbox: Queued[] = [];
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) {
      outbox = parsed.data.outbox;
      waiting = parsed.data.waiting.map((entry) => ({ ...entry, restored: true }));
    } else console.warn(`devs reports: ${file} is not a reports file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`devs reports: ${file} is unreadable; starting fresh`);
  }
  const inFlight = new Map<string, Promise<Told>>();
  const retrying = new Set<Queued>();
  let told: Array<{ threadId: string; messageId: string; said: Told; until: number }> = [];
  const lastSent = new Map<string, { reportId: string; at: number }>();
  const seen = new Set<string>();

  const save = () => {
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: 1, waiting: waiting.map(({ answered: _a, offered: _o, restored: _r, ...entry }) => entry), outbox })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`devs reports: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const notice = (threadId: string, said: Told) => {
    try { store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `notice: ${said.line}`, ok: said.ok } }); }
    catch { /* the conversation is gone; the report still went */ }
  };
  const botNames = () => store.bots.map((bot) => bot.name);
  const secrets = () => environmentSecrets();

  function contactFor(sender: ResolvedSender | undefined): string | undefined {
    const person = sender?.id;
    const own = person ? deps.sessions()
      .filter((session) => session.email && (personKey(session) === person || (person === deps.ownerKey && session.scopes.includes("admin"))))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]?.email : undefined;
    return contactAddress(own) ?? (deps.team ? undefined : contactAddress(deps.profileEmail()));
  }

  function reported(bot: BotRecord, threadId: string): ReportedBot {
    const effective = store.projectBotForTask(bot.id, threadId) ?? bot;
    const { instanceId, model, effort, variant } = effective.modelSelection;
    const engine = deps.engine(instanceId);
    const grants = effective.connectorTools ? Object.keys(effective.connectorTools) : null;
    const apps = !deps.appsReady() ? "not set up" : effective.composio === false ? "off for this bot"
      : grants === null ? "on, every connected app" : grants.length ? `on: ${grants.slice(0, 12).join(", ")}` : "on, no app granted";
    return { id: bot.id, name: bot.name, engine: engine?.name ?? "unknown engine", instanceId, model, ...(effort ? { effort } : {}),
      ...(variant ? { variant } : {}), health: engine ? health(engine.snapshot) : "not installed", apps };
  }

  /** After the @devs message: the bots that spoke in a group chat, else the conversation's own bot. */
  function botsFor(entry: Waiting, author: Author): { bots: BotRecord[]; where: string; groupId?: string } {
    const group = store.groupByThread(entry.threadId);
    if (group) {
      const path = store.activePath(entry.threadId);
      const after = path.slice(path.findIndex((line) => line.id === entry.messageId) + 1);
      const spoke = new Set(after.flatMap((line) => (line.from?.botId ? [line.from.botId] : [])));
      const members = group.memberIds.map((member) => store.bot(member)).filter((bot): bot is BotRecord => Boolean(bot && !bot.hidden));
      const chosen = "bot" in author ? [author.bot] : members.filter((bot) => spoke.has(bot.id));
      return { bots: (chosen.length ? chosen : members).slice(0, 6), where: `the group chat "${group.name}" with ${members.length} bot${members.length === 1 ? "" : "s"}`, groupId: group.id };
    }
    const owner = "bot" in author ? author.bot : store.botByThread(entry.threadId);
    return { bots: owner ? [owner] : [], where: owner ? `a chat with ${owner.name}` : "a conversation" };
  }

  function build(entry: Waiting, author: Author): { payload: DevsReportPayload; contact?: string } {
    const { bots, where, groupId } = botsFor(entry, author);
    const contact = contactFor(entry.sender);
    const runsOn = deps.runsOn;
    const payload = buildDevsReport({
      installId: deps.installId, appVersion: deps.appVersion, platform: `${platform()} ${arch()}, ${runsOn}`, os: `${platform()} ${release()} ${arch()}`,
      runsOn, node: process.version, uptimeSeconds: Math.round(process.uptime()), language: deps.language(), now: now(),
      threadId: entry.threadId, messageId: entry.messageId, ...(groupId ? { groupId } : {}), where, message: entry.text, words: entry.words,
      bots: bots.map((bot) => reported(bot, entry.threadId)),
      ...("bot" in author ? { summary: { by: author.bot.name, text: author.summary } } : { noSummary: author.why }),
      problems: conversationProblems(store.activePath(entry.threadId)), log: deps.recentLog(), contactEmail: contact,
    }, secrets());
    return { payload, ...(contact ? { contact } : {}) };
  }

  /** The words for the person after one attempt; a report worth trying again joins the outbox. */
  function settle(entry: { messageId: string; threadId: string }, payload: DevsReportPayload, outcome: SendOutcome, contact?: string): Told {
    if (outcome.ok) {
      lastSent.set(entry.threadId, { reportId: outcome.id, at: now() });
      return { ok: true, line: sentLine(outcome.id, contact), marker: outcome.id };
    }
    if (!outcome.retry) return { ok: false, line: refusedLine(outcome.detail), marker: "MausBot team" };
    if (outbox.length >= MAX_OUTBOX) return { ok: false, line: fullLine, marker: "MausBot team" };
    outbox.push({ messageId: entry.messageId, threadId: entry.threadId, payload, firstAt: now(), attempts: 1,
      nextAt: now() + (outcome.retryAfterMs ?? RETRY_MS[0]) });
    return { ok: false, line: notYetLine(outcome), marker: "MausBot team" };
  }

  function deliver(entry: Waiting, author: Author): Promise<Told> {
    const running = inFlight.get(entry.messageId);
    if (running) return running;
    const attempt = (async () => {
      const { payload, contact } = build(entry, author);
      const outcome = await deps.send(payload).catch((): SendOutcome => ({ ok: false, retry: true, why: "offline" }));
      waiting = waiting.filter((one) => one.messageId !== entry.messageId);
      const said = settle(entry, payload, outcome, contact);
      save();
      return said;
    })().finally(() => inFlight.delete(entry.messageId));
    inFlight.set(entry.messageId, attempt);
    return attempt;
  }

  /** Why no bot wrote the summary, read once the conversation is quiet. */
  function why(entry: Waiting): string {
    if (entry.restored) return "OpenMausBot restarted before a bot wrote one";
    if (!entry.answered) return "no bot answered the message";
    if (entry.offered === false) return "the bot's engine cannot use OpenMausBot's tools";
    const path = store.activePath(entry.threadId);
    const after = path.slice(path.findIndex((line) => line.id === entry.messageId) + 1);
    if (after.some((line) => line.kind === "activity" && line.tool && failedTurnCause(line.tool.name) !== null)) return "the bot's turn failed";
    return "the bot did not call report_bug";
  }

  async function retry(queued: Queued): Promise<void> {
    retrying.add(queued);
    const outcome = await deps.send(queued.payload).catch((): SendOutcome => ({ ok: false, retry: true, why: "offline" })).finally(() => retrying.delete(queued));
    const contact = queued.payload.contactEmail ?? queued.payload.contact;
    if (outcome.ok) {
      outbox = outbox.filter((one) => one !== queued);
      lastSent.set(queued.threadId, { reportId: outcome.id, at: now() });
      notice(queued.threadId, { ok: true, line: laterLine(outcome.id, contact), marker: outcome.id });
    } else if (!outcome.retry) {
      outbox = outbox.filter((one) => one !== queued);
      notice(queued.threadId, { ok: false, line: refusedLine(outcome.detail), marker: "" });
    } else if (now() - queued.firstAt > KEPT_MS) {
      outbox = outbox.filter((one) => one !== queued);
      notice(queued.threadId, { ok: false, line: droppedLine, marker: "" });
    } else {
      queued.attempts += 1;
      queued.nextAt = now() + (outcome.retryAfterMs ?? RETRY_MS[Math.min(queued.attempts - 1, RETRY_MS.length - 1)]!);
    }
    save();
  }

  function tick(): void {
    for (const entry of waiting) {
      if (inFlight.has(entry.messageId)) continue;
      if (deps.working(entry.threadId)) {
        entry.answered = true;
        if (now() - entry.at >= LONGEST_WAIT_MS) void deliver(entry, { why: "its turn was still running after 10 minutes" }).then((said) => notice(entry.threadId, said));
        continue;
      }
      if (!entry.answered && !entry.restored && now() - entry.at < NO_ANSWER_MS) continue;
      void deliver(entry, { why: why(entry) }).then((said) => notice(entry.threadId, said));
    }
    const quiet = told.filter((one) => !deps.working(one.threadId) || now() >= one.until);
    told = told.filter((one) => !quiet.includes(one));
    for (const one of quiet) {
      const path = store.activePath(one.threadId);
      const after = path.slice(path.findIndex((line) => line.id === one.messageId) + 1);
      const marker = one.said.marker.toLowerCase();
      if (!after.some((line) => line.role === "bot" && line.kind === "text" && (line.text ?? "").toLowerCase().includes(marker))) notice(one.threadId, one.said);
    }
    for (const queued of outbox) if (now() >= queued.nextAt && !retrying.has(queued)) void retry(queued);
  }

  /** report_bug from the bot answering a @devs message in this conversation. */
  async function fromBot(botId: string, threadId: string, summary: BotSummary): Promise<{ status: number; text: string }> {
    const bot = store.bot(botId);
    const entry = waiting.filter((one) => one.threadId === threadId).at(-1);
    if (!bot || !entry) {
      const last = lastSent.get(threadId);
      if (last && now() - last.at < REPEAT_MS) return { status: 200, text: `Already sent as report ${last.reportId}: report_bug sends once per @devs message. Do not call it again for it.` };
      return { status: 409, text: "report_bug sends only for a message that tags @devs, once per message. To report a problem to the MausBot team, the person types @devs and a few words about what went wrong." };
    }
    const fallingBack = inFlight.has(entry.messageId);
    const said = await deliver(entry, { bot, summary });
    if (!fallingBack) told.push({ threadId, messageId: entry.messageId, said, until: now() + LONGEST_WAIT_MS });
    return { status: 200, text: `${said.ok ? "Sent" : "Not sent"}. Tell the person this line in your reply, word for word: "${said.line}"` };
  }

  function personWrote(threadId: string, line: Message): void {
    if (seen.has(line.id) || !line.text || now() - line.at > FRESH_MS) return;
    if (!line.sendId && deps.automated(threadId)) return;
    if (!tagsDevs(line.text, botNames())) return;
    seen.add(line.id);
    if (seen.size > 1_000) seen.delete(seen.values().next().value!);
    if (waiting.length >= MAX_WAITING) return notice(threadId, { ok: false, line: fullLine, marker: "" });
    const redact = (text: string) => clip(redactReportText(text, secrets()), 3_000);
    waiting.push({ messageId: line.id, threadId, at: line.at, text: redact(line.text), words: redact(withoutDevsTags(line.text, botNames())),
      ...(line.sender ? { sender: { name: line.sender.name, ...(line.sender.id ? { id: line.sender.id } : {}) } } : {}) });
    save();
  }

  const unsubscribe = store.onChange((change: StoreChange) => {
    if (change.type === "message") {
      const line = change.message;
      if (line.role === "user" && line.kind === "text" && !line.peerAsk && !line.aside) personWrote(change.threadId, line);
    } else if (change.type === "thread.deleted") {
      const before = waiting.length;
      waiting = waiting.filter((entry) => entry.threadId !== change.threadId);
      if (waiting.length !== before) save();
    }
  });
  const timer = deps.timer === false ? null : setInterval(tick, TICK_MS);
  timer?.unref();

  return {
    /** The note on a turn in this conversation while a @devs message waits for its summary; empty otherwise, and for a
     * turn without OpenMausBot's tools. */
    note(threadId: string, tools: boolean): string {
      const entry = waiting.filter((one) => one.threadId === threadId && !inFlight.has(one.messageId)).at(-1);
      if (!entry) return "";
      entry.answered = true;
      entry.offered = entry.offered === true || tools;
      return tools ? TURN_NOTE : "";
    },
    /** The internal call behind report_bug, inside index.ts's /api/internal/ block: the bot and the conversation are the
     * capability's, never a body field. */
    async internal(ctx: DevsReportContext): Promise<typeof PASS | void> {
      if (ctx.path !== DEVS_REPORT_PATH) return PASS;
      if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
      const body = bodySchema.safeParse(await ctx.readBody());
      if (!body.success) return ctx.json(ctx.res, 400, { error: "report_bug needs went_wrong (up to 2,000 characters), and may add you_saw and steps." });
      const { went_wrong: wentWrong, you_saw: seenByBot, steps } = body.data;
      const answer = await fromBot(ctx.botId, ctx.threadId, { wentWrong, ...(seenByBot ? { seen: seenByBot } : {}), ...(steps ? { steps } : {}) });
      return ctx.json(ctx.res, answer.status, answer.status === 200 ? { text: answer.text } : { error: answer.text });
    },
    tick,
    /** Tests: settles every send in flight. */
    idle: async () => { while (inFlight.size || retrying.size) await Promise.allSettled(inFlight.values()).then(() => new Promise((resolve) => setImmediate(resolve))); },
    stop() { unsubscribe(); if (timer) clearInterval(timer); },
  };
}

export type DevsReports = ReturnType<typeof createDevsReports>;
