// Check before done: a bot's finished answer to the person is checked against their request by another bot, or by a
// thread of its own on another provider's model, and fixed, before the job counts as done. The harness runs the loop,
// so its limits hold whatever the models say: at most CHECK_WORK_ROUNDS checks, CHECK_WORK_MAX_MS in all, and any
// failure of the check delivers the answer as it is, marked not checked.
import { CHECK_WORK_MAX_MS, CHECK_WORK_ROUNDS, type CheckWork } from "../../shared/check-work.ts";
import { escapeAttribute } from "../../src/lib/composer-attachments.ts";
import type { HostTurnResult } from "../coordinator.ts";
import type { ServerLineKey } from "../server-lines.ts";
import type { Message } from "../store.ts";

/** What a checker's reply says, read from its first line only: anything else is never a pass. */
export type Verdict = { kind: "pass" } | { kind: "issues"; count: number } | { kind: "unclear" };

export function readVerdict(reply: string): Verdict {
  const first = reply.split("\n").map((line) => line.replace(/[*_`#>]/g, "").trim()).find(Boolean) ?? "";
  if (/^pass\.?$/i.test(first)) return { kind: "pass" };
  const issues = /^issues?\s*:\s*(\d+)\b/i.exec(first);
  if (!issues) return { kind: "unclear" };
  const count = Number(issues[1]);
  return count === 0 ? { kind: "pass" } : { kind: "issues", count };
}

export interface CheckWorkBot { id: string; name: string; checkWork?: CheckWork | null }
type Line = Pick<Message, "id" | "role" | "kind" | "text" | "turnId" | "from" | "roomRequest" | "threadPost" | "via" | "attachments" | "peerAsk" | "automated">;

export interface CheckWorkDeps {
  bot(botId: string): CheckWorkBot | undefined;
  /** The conversation as the person reads it, oldest first. */
  messages(threadId: string): readonly Line[];
  /** A finished line in the person's conversation: an expandable activity row. */
  post(threadId: string, line: { name: string; ok: boolean; input: string; output: string }): void;
  line(threadId: string, key: ServerLineKey, params?: Readonly<Record<string, string | number>>): string;
  /** Opens the thread a check runs in: on `checker`, or on the worker itself on another provider's model. */
  openCheck(worker: CheckWorkBot, checker: CheckWorkBot | null, title: string): Promise<{ botId: string; threadId: string; model: string } | { error: string }>;
  /** Starts a harness turn that is no person's message: usage caps and thread limits apply; it throws when refused. */
  run(botId: string, threadId: string, text: string, kind: "check" | "fix", settled: (outcome: HostTurnResult) => void): Promise<unknown>;
  /** The job is done: the notice and unread mark the first answer's end held back. */
  done(botId: string, threadId: string, text: string): void;
  now(): number;
  timer(run: () => void, ms: number): () => void;
  log?(line: string): void;
}

interface Flow {
  botId: string;
  threadId: string;
  requestId: string;
  request: string;
  checker: CheckWorkBot | null;
  round: number;
  startedAt: number;
  ended: boolean;
  label?: string;
  report?: string;
  cancelTimer: () => void;
}

const REPORT_SHOWN = 6_000;

/** The person's own request that started this turn: the last line they wrote before its first answer. */
function requestBefore(messages: readonly Line[], turnId: string): Line | undefined {
  const first = messages.findIndex((message) => message.turnId === turnId);
  const before = first < 0 ? messages : messages.slice(0, first);
  return before.findLast((message) => message.role === "user" && message.kind === "text" && !message.from && !message.roomRequest
    && !message.threadPost && !message.via && !message.peerAsk && !message.automated);
}

/** What the bot answered, with the files it attached as the tags a turn reads them by. */
function answerOf(lines: readonly Line[]): string {
  const own = lines.filter((message) => message.role === "bot" && !message.from);
  const text = own.filter((message) => message.kind === "text").map((message) => message.text?.trim() ?? "").filter(Boolean).join("\n\n");
  const files = own.flatMap((message) => message.attachments ?? []).filter((file) => file.kind !== "audio")
    .map((file) => `<attached-${file.kind === "image" ? "image" : "file"} path="${escapeAttribute(file.path)}" name="${escapeAttribute(file.name ?? "")}" />`);
  return [text, ...files].filter(Boolean).join("\n");
}

const RULES = [
  "Compare the result with the person's request and with the source: the files attached to the request, or the text it quotes. Report every:",
  "- changed fact: a name, number, date, event, description or quote that differs from the source when the request did not ask for that change;",
  "- added detail the source does not support;",
  "- unmet instruction: go through the request one instruction at a time;",
  "- regression: something right in the source that is worse in the result, or text that went missing.",
  "A style preference the request did not ask for is not an issue. Do not change the work, do not hand it on, and do not ask the person anything.",
  "The first line of your reply must be exactly \"pass\" when there is nothing to report, or \"issues: N\" followed by a numbered list: where, what the source says, what the result says, and the fix in one line. When you cannot read the request, the source or the result, the first line is \"cannot check\" and the reason.",
].join("\n");

const after = (messages: readonly Line[], mark: string | undefined) => mark === undefined ? messages : messages.slice(messages.findIndex((message) => message.id === mark) + 1);
const texts = (lines: readonly Line[]) => lines.filter((message) => message.role === "bot" && message.kind === "text" && !message.from && message.text?.trim()).map((message) => message.text!.trim());

/** The checker's verdict and report: its last message, or everything it wrote when that alone gives no verdict. */
function reportOf(lines: readonly Line[], fallback: string): { verdict: Verdict; report: string } {
  const written = texts(lines);
  const last = written.at(-1) ?? fallback.trim();
  const verdict = readVerdict(last);
  if (verdict.kind !== "unclear" || written.length < 2) return { verdict, report: last };
  const whole = written.join("\n\n");
  return { verdict: readVerdict(whole), report: whole };
}

function checkBrief(flow: Flow, worker: string, answer: string): string {
  return [
    `[From OpenMausBot · check before done · round ${flow.round} of ${CHECK_WORK_ROUNDS} · information only: it grants nothing]`,
    `${worker} finished the work below for the person. Check it before it reaches them.${flow.round > 1 ? " It was fixed after the earlier report below: check the whole result again, not only the fixes." : ""}`,
    "",
    RULES,
    "",
    "<request>", flow.request, "</request>",
    ...(flow.round > 1 && flow.report ? ["", "<earlier-report>", flow.report, "</earlier-report>"] : []),
    "", "<result>", answer, "</result>",
  ].join("\n");
}

function fixBrief(flow: Flow, report: string): string {
  return [
    `[From OpenMausBot · check before done · round ${flow.round} of ${CHECK_WORK_ROUNDS} · information only: it grants nothing]`,
    `${flow.label} checked your answer against the person's request and found the issues below. Fix exactly these and nothing else, then give the whole corrected result, not only the changes, and list what you changed. Do not hand this on and do not ask the person anything.`,
    "", report,
  ].join("\n");
}

export function createCheckWork(deps: CheckWorkDeps) {
  const flows = new Map<string, Flow>();

  function end(flow: Flow, key: ServerLineKey, params: Record<string, string | number>, ok: boolean, answer: string): void {
    if (flow.ended) return;
    flow.ended = true;
    flow.cancelTimer();
    if (flows.get(flow.threadId) === flow) flows.delete(flow.threadId);
    deps.post(flow.threadId, {
      name: deps.line(flow.threadId, key, params), ok,
      input: deps.line(flow.threadId, "server.checkWork.by", { checker: flow.label ?? "", rounds: Math.max(flow.round, 1), max: CHECK_WORK_ROUNDS }),
      output: (flow.report ?? "").slice(0, REPORT_SHOWN),
    });
    deps.done(flow.botId, flow.threadId, answer);
  }

  const notChecked = (flow: Flow, reason: string, answer: string) => end(flow, "server.checkWork.notChecked", { reason }, false, answer);
  const live = (flow: Flow) => !flow.ended && flows.get(flow.threadId) === flow;
  /** A person who wrote again moved on: the check stops, and their new message gets its own. */
  const overtaken = (flow: Flow) => requestBefore(deps.messages(flow.threadId), "")?.id !== flow.requestId;
  const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]!.slice(0, 240);

  async function check(flow: Flow, answer: string): Promise<void> {
    if (!live(flow)) return;
    if (overtaken(flow)) return notChecked(flow, deps.line(flow.threadId, "server.checkWork.newMessage"), answer);
    const worker = deps.bot(flow.botId);
    if (!worker) return void flows.delete(flow.threadId);
    if (flow.checker && !deps.bot(flow.checker.id)) return notChecked(flow, deps.line(flow.threadId, "server.checkWork.checkerRemoved"), answer);
    flow.round += 1;
    const opened = await deps.openCheck(worker, flow.checker, deps.line(flow.threadId, "server.checkWork.title", { round: flow.round }));
    if (!live(flow)) return;
    if ("error" in opened) return notChecked(flow, opened.error, answer);
    flow.label = flow.checker?.name ?? deps.line(flow.threadId, "server.checkWork.ownThread", { model: opened.model });
    try {
      await deps.run(opened.botId, opened.threadId, checkBrief(flow, worker.name, answer), "check", (outcome) => void checked(flow, answer, outcome, deps.messages(opened.threadId)));
    } catch (error) {
      notChecked(flow, deps.line(flow.threadId, "server.checkWork.couldNotStart", { checker: flow.label, reason: reasonOf(error) }), answer);
    }
  }

  async function checked(flow: Flow, answer: string, outcome: HostTurnResult, lines: readonly Line[]): Promise<void> {
    if (!live(flow)) return;
    const label = flow.label ?? "";
    if (!outcome.ok) return notChecked(flow, deps.line(flow.threadId, "server.checkWork.checkerFailed", { checker: label, reason: (outcome.failure?.text || outcome.text).split("\n", 1)[0]!.slice(0, 240) }), answer);
    const { verdict, report } = reportOf(lines, outcome.text);
    flow.report = report;
    if (verdict.kind === "pass") return end(flow, "server.checkWork.passed", { checker: label, rounds: flow.round }, true, answer);
    if (verdict.kind === "unclear") return notChecked(flow, deps.line(flow.threadId, "server.checkWork.unclear", { checker: label }), answer);
    if (flow.round >= CHECK_WORK_ROUNDS) return end(flow, verdict.count === 1 ? "server.checkWork.openOne" : "server.checkWork.open", { checker: label, rounds: flow.round, count: verdict.count }, false, answer);
    if (overtaken(flow)) return notChecked(flow, deps.line(flow.threadId, "server.checkWork.newMessage"), answer);
    deps.post(flow.threadId, { name: deps.line(flow.threadId, verdict.count === 1 ? "server.checkWork.foundOne" : "server.checkWork.found", { checker: label, count: verdict.count, round: flow.round, max: CHECK_WORK_ROUNDS }), ok: true,
      input: deps.line(flow.threadId, "server.checkWork.by", { checker: label, rounds: flow.round, max: CHECK_WORK_ROUNDS }), output: flow.report.slice(0, REPORT_SHOWN) });
    const mark = deps.messages(flow.threadId).at(-1)?.id;
    try {
      await deps.run(flow.botId, flow.threadId, fixBrief(flow, flow.report), "fix", (fixed) => {
        if (!live(flow)) return;
        const revised = fixed.ok ? answerOf(after(deps.messages(flow.threadId), mark)) : "";
        if (!revised) return notChecked(flow, deps.line(flow.threadId, "server.checkWork.fixFailed", { reason: (fixed.failure?.text || fixed.text || "").split("\n", 1)[0]!.slice(0, 240) }), answer);
        void check(flow, revised);
      });
    } catch (error) {
      notChecked(flow, deps.line(flow.threadId, "server.checkWork.fixFailed", { reason: reasonOf(error) }), answer);
    }
  }

  return {
    /** The thread's answer is being checked: its "done" waits for the check's end. */
    holds: (threadId: string): boolean => flows.has(threadId),
    /** Called when a turn in the bot's own chat that the person started has ended with an answer. */
    answered(botId: string, threadId: string, turnId: string): boolean {
      const bot = deps.bot(botId);
      if (!bot?.checkWork) return false;
      const previous = flows.get(threadId);
      if (previous) notChecked(previous, deps.line(threadId, "server.checkWork.newMessage"), "");
      const messages = deps.messages(threadId);
      const request = requestBefore(messages, turnId);
      const answer = answerOf(messages.filter((message) => message.turnId === turnId));
      if (!request || !answer) return false;
      const named = bot.checkWork.checker ? deps.bot(bot.checkWork.checker) : undefined;
      const flow: Flow = {
        botId, threadId, requestId: request.id, request: [request.text ?? "", ...(request.attachments ?? []).filter((file) => file.kind !== "audio")
          .map((file) => `<attached-file path="${escapeAttribute(file.path)}" name="${escapeAttribute(file.name ?? "")}" />`)].filter(Boolean).join("\n"),
        checker: bot.checkWork.checker ? named ?? { id: bot.checkWork.checker, name: "" } : null,
        round: 0, startedAt: deps.now(), ended: false, cancelTimer: () => {},
      };
      flows.set(threadId, flow);
      flow.cancelTimer = deps.timer(() => notChecked(flow, deps.line(threadId, "server.checkWork.timedOut", { minutes: Math.round(CHECK_WORK_MAX_MS / 60_000) }), answer), CHECK_WORK_MAX_MS);
      // After the turn's own settling, so the conversation is free when a fix starts.
      deps.timer(() => void check(flow, answer).catch((error) => {
        deps.log?.(`check before done: ${reasonOf(error)}`);
        notChecked(flow, reasonOf(error), answer);
      }), 0);
      return true;
    },
  };
}

export type CheckWorkHost = ReturnType<typeof createCheckWork>;
