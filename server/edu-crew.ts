// Edu crew (https://github.com/EduardoMoraga/edu) for bots that have it on: Edu plans, builds, runs checks and reviews
// with other coding CLIs. Edu 6.0.0 has no MCP profile that keeps its approval gates for a person (`edu_crew_approve`
// is "the host LLM's decision"), so bots never get Edu's crew tools: the server starts jobs with the `edu` CLI, never
// with `--yes`, and a person passes each gate on a card here. Jobs run in the conversation's working folder with the
// bot's brain as Edu's home, so neither the person's global brain nor Edu Bot's data folder hosts their work.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

import { EDU_CREW_REVIEWERS, type EduCrewDetails, type EduCrewGate, type EduCrewLine, type EduCrewReviewer, type EduCrewStatus, type EduCrewView } from "../shared/edu-brain.ts";
import type { OptionCardData } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { DecisionRow } from "./decision-log.ts";
import type { EduBot, EduBrains, EduRuntime } from "./edu-brain.ts";
import { eduDecisionRefusal } from "./edu-proposals.ts";
import { eduStoreRefusal, storeFile } from "./edu-store.ts";
import { augmentedPath, findCliCandidates, userHome } from "./env-path.ts";
import { AGENTS_NODE_FLAG } from "./proxy-paths.ts";
import type { RequestAuth } from "./request-auth.ts";
import { recordsText } from "./records-block.ts";
import { PASS } from "./routes/table.ts";
import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "./server-lines.ts";
import { redactSecretsInText } from "../shared/redact.ts";

export const EDU_CREW_PATH = "/api/internal/edu/crew";
export const EDU_CREW_GATE_TOOL = "edu_crew_gate";
export const EDU_CREW_FILE = "edu-crew.json";
const JOB_ID = /^[a-f0-9-]{36}$/i;
const GATE_ID = JOB_ID;
const PLAYBOOK = /^[A-Za-z0-9][\w-]{0,63}$/;
const START_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 20_000;
const DECIDE_TIMEOUT_MS = 30_000;
const POLL_MS = 2_000;
const MAX_WAIT_S = 300;
const KEPT_JOBS = 200;
const MAX_READ_FAILURES = 15;
const TITLE_CHARS = 120;
const WHY_CHARS = 300;
const SPEC_CHARS = 4_000;
const SUMMARY_CHARS = 12_000;
const DIFF_CHARS = 12_000;
const NEW_FILES = 50;
const SHUTDOWN_CANCEL_MS = 6_000;
export const MAX_ACTIVE_PER_CHAT = 2;
export const MAX_ACTIVE = 4;

export type EduCrewRun = (args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

interface CrewBot extends EduBot { name: string; color: string; eduCrew?: boolean; threadId?: string }
type CardMessage = { id: string; card?: OptionCardData };

export interface EduCrewDeps {
  dataDir: string;
  brains: Pick<EduBrains, "brain" | "detect" | "readyNow">;
  store: {
    bot(id: string): CrewBot | null | undefined;
    messagesFor(threadId: string): CardMessage[];
    appendMessage(threadId: string, message: Record<string, unknown> & { role: "bot"; kind: "options" | "activity" }): { id: string };
    patchMessage(threadId: string, messageId: string, patch: Record<string, unknown>): unknown;
  };
  /** The folder this conversation works in: its pinned folder, else the bot's; null when it has none of its own. */
  folder(botId: string, threadId: string): string | null | undefined;
  /** The `driverKind` of the engine this conversation's turns run on, so a review goes to another vendor. */
  engine(botId: string, threadId: string): string | undefined;
  /** Where this conversation's turns run. */
  turn(botId: string, threadId: string): CrewTurn;
  decide(row: Omit<DecisionRow, "at">): void;
  /** The packaged desktop app, whose loopback mutations carry its own token. */
  desktop: boolean;
  env?: NodeJS.ProcessEnv;
  /** Runs `edu` with Node: args start with the CLI script. */
  run?: EduCrewRun;
  /** Runs git in the work folder, for a review's diff. */
  git?(args: string[], cwd: string): Promise<string>;
  /** The PATH crew jobs find their CLIs on; defaults to the app's. */
  path?(): string;
  now?(): number;
  pollMs?: number;
}

interface JobRecord {
  jobId: string;
  kind: EduCrewLine["kind"];
  botId: string;
  threadId: string;
  messageId: string;
  folder: string;
  brain: string;
  title: string;
  goal: string;
  status: EduCrewStatus;
  at: number;
  cli?: string;
  why?: string;
  gateId?: string;
  gateMessageId?: string;
  specPath?: string;
  failures?: number;
}

const recordSchema = z.object({
  jobId: z.string().regex(JOB_ID), kind: z.enum(["plan", "review"]), botId: z.string().max(200), threadId: z.string().max(200), messageId: z.string().max(200),
  folder: z.string().max(4096), brain: z.string().max(4096), title: z.string().max(400), goal: z.string().max(8000),
  status: z.enum(["running", "waiting", "done", "failed", "cancelled"]), at: z.number(), cli: z.string().max(40).optional(), why: z.string().max(400).optional(),
  gateId: z.string().regex(GATE_ID).optional(), gateMessageId: z.string().max(200).optional(), specPath: z.string().max(4096).optional(), failures: z.number().optional(),
}).strip();

/** Edu's job record, as `edu crew status <id> --json` prints it. */
export interface EduJob {
  id: string;
  status: string;
  summary?: string;
  outcome?: string;
  specPath?: string;
  cli?: string;
  approval?: { requestId: string; title?: string; unregisteredChecks?: string[] };
}

/** The exact `edu` arguments, after the CLI script. None ever approves a gate itself (`--yes`) or lets planner checks
 * run unasked (`--allow-unregistered-checks`); a goal or task is always past `--`, so it can never read as an option. */
export const eduCrewCommands = {
  plan: (folder: string, goal: string, playbook?: string) => ["--cwd", folder, "run", "--detach", ...(playbook ? ["--playbook", playbook] : []), "--", goal],
  review: (folder: string, cli: EduCrewReviewer, task: string) => ["--cwd", folder, "crew", "dispatch", "--autonomy", "readonly", "--json", "--", cli, task],
  status: (folder: string, jobId: string) => ["--cwd", folder, "crew", "status", jobId, "--json"],
  decide: (folder: string, jobId: string, gateId: string, approve: boolean) => ["--cwd", folder, "crew", approve ? "approve" : "reject", jobId, "--request", gateId],
  cancel: (folder: string, jobId: string) => ["--cwd", folder, "crew", "cancel", jobId, "--json"],
};

export function crewStatus(status: string): EduCrewStatus {
  if (status === "awaiting-approval") return "waiting";
  if (status === "done" || status === "failed" || status === "cancelled") return status;
  return "running";
}

const ended = (status: EduCrewStatus) => status === "done" || status === "failed" || status === "cancelled";
const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** Security: where crew jobs may work. Never the person's home folder or above it, Edu Bot's data folder, or a folder
 * whose Edu store is not its own (`eduStoreRefusal`); only a real folder the conversation names as its own. */
export function crewFolderRefusal(folder: string | null | undefined, limits: { dataDir: string; home: string; globalHome: string }): string | null {
  if (!folder) return "This chat has no working folder of its own. Pick a folder in this bot's settings, then try again.";
  const real = resolveThroughLinks(folder);
  try { if (!statSync(real).isDirectory()) return "This chat's working folder isn't a folder."; } catch { return "This chat's working folder doesn't exist."; }
  if (isInside(resolveThroughLinks(limits.home), real)) return "Edu crew never works in your home folder or above it. Pick a project folder for this bot.";
  if (isInside(real, resolveThroughLinks(limits.dataDir))) return "Edu crew never works in Edu Bot's own data folder. Pick a project folder for this bot.";
  const store = eduStoreRefusal(real, limits.globalHome);
  return store ? `Edu crew can't work in this chat's folder. ${store}.` : null;
}

/** The Edu crew CLI each engine driver is, for every `driverKind` Edu Bot ships; null where Edu runs no such CLI. */
export const EDU_CLI_BY_DRIVER: Readonly<Record<string, EduCrewReviewer | null>> = {
  claudeAgent: "claude", codex: "codex", piAgent: "pi",
  antigravityAgent: null, cerebras: null, clineAgent: null, commandCodeAgent: null, copilotAgent: null, cursorAgent: null, customAcp: null,
  deepseekAgent: null, devinAgent: null, droidAgent: null, geminiAgent: null, greenference: null, grok: null, grokAgent: null, groq: null,
  hermesAgent: null, kimiAgent: null, kiroAgent: null, meta: null, minimax: null, mistral: null, mistralVibeAgent: null, modelgo: null,
  museCode: null, ompAgent: null, "openai-compat": null, opencodeGo: null, qwenAgent: null,
};

export function eduCliOf(driverKind: string | undefined): EduCrewReviewer | null {
  return (driverKind !== undefined && Object.hasOwn(EDU_CLI_BY_DRIVER, driverKind) ? EDU_CLI_BY_DRIVER[driverKind] : null) ?? null;
}

/** The reviewer for a bot whose engine is the Edu CLI `engine`: the one asked for, else the first installed of codex,
 * claude and pi; never the bot's own CLI, and none at all when only that one is installed. */
export function pickReviewer(engine: EduCrewReviewer | null, asked: string | undefined, installed: (cli: string) => boolean): { ok: true; cli: EduCrewReviewer } | { ok: false; error: string } {
  const others = EDU_CREW_REVIEWERS.filter((cli) => cli !== engine);
  if (asked !== undefined) {
    if (!EDU_CREW_REVIEWERS.includes(asked as EduCrewReviewer)) return { ok: false, error: `reviewer must be one of ${EDU_CREW_REVIEWERS.join(", ")}.` };
    if (asked === engine) return { ok: false, error: `You run on ${engine}; a review needs another vendor: ${others.join(", ")}.` };
    return installed(asked) ? { ok: true, cli: asked as EduCrewReviewer } : { ok: false, error: `${asked} isn't installed on this computer.` };
  }
  const cli = others.find(installed);
  return cli ? { ok: true, cli } : { ok: false, error: `No other vendor's CLI is installed for a read-only review (Edu supports ${others.join(", ")}${engine ? `; you run on ${engine}, so it can't review your work` : ""}). Tell the person no cross-vendor review is possible on this computer.` };
}

/** Where a conversation's turns run, for `crewTurnRefusal`. */
export interface CrewTurn {
  room: boolean;
  /** Edu Bot itself runs on the person's computer: not a cloud home, not inside the bot box. */
  hostLocal: boolean;
  /** Fenced from the person's own data: a proactive fence or a Bot API thread. */
  confined: boolean;
  /** The turn's computer: `cloud`, `box` and `vps` are not this computer, `off` is none. */
  computer?: string | null;
}

/** Security: Edu crew runs coding CLIs on this computer, so only a person's own chat with a bot that works here may use it. */
export function crewTurnRefusal(turn: CrewTurn): string | null {
  if (turn.room) return "Edu crew works only in a bot's own chats, never in a room.";
  if (!turn.hostLocal) return "Edu crew works only when Edu Bot runs on this computer, not on a cloud home or in the bot box.";
  if (turn.confined) return "This chat is fenced from the person's own files, so Edu crew can't work in it.";
  if (turn.computer === "off") return "This bot's Works on setting is Off, so Edu crew, which runs on this computer, is off for it.";
  if (turn.computer === "cloud" || turn.computer === "box" || turn.computer === "vps") return "This bot works on a cloud computer, so Edu crew, which runs on this computer, is off for it.";
  return null;
}

export function reviewTask(input: { question?: string; paths?: string[]; base?: string; diff?: string; newFiles?: string[] }): string {
  return redactSecretsInText([
    "You are an independent, read-only reviewer for another agent's work in this folder. Do not modify files.",
    ...(input.question ? [`Question: ${input.question}`] : []),
    ...(input.paths?.length ? [`Read these paths: ${input.paths.join(", ")}`] : []),
    ...(input.diff !== undefined ? [`Changes since ${input.base ?? "HEAD"}:\n\`\`\`diff\n${input.diff || "(no changes)"}\n\`\`\``] : []),
    ...(input.newFiles?.length ? [`New files git doesn't track yet (read them too): ${input.newFiles.join(", ")}`] : []),
    "Return concrete findings first, then residual risks.",
  ].join("\n\n"));
}

/** Why `path` may not be given to a reviewer of `folder` (the real work folder), or null. */
export function reviewPathRefusal(folder: string, path: string): string | null {
  if (path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
    return `paths must be relative to the working folder, with no "..": ${JSON.stringify(path)}`;
  }
  return isInside(resolveThroughLinks(join(folder, path)), folder) ? null : `${JSON.stringify(path)} leads outside the working folder.`;
}

function nodeRun(args: string[], { env, timeoutMs, cwd }: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr || (error && code === -1 ? error.message : "")) });
    });
  });
}

function gitRun(args: string[], cwd: string, path: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd, env: { ...process.env, PATH: path }, timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? fail(error) : done(String(stdout)));
  });
}

const missingProgram = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const GIT_MISSING = "git isn't installed or isn't on this app's PATH, so changes can't be listed. Install git, or review named paths instead.";

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.replace(/^edu:\s*/, "") ?? "";

export function createEduCrew(deps: EduCrewDeps) {
  const env = deps.env ?? process.env;
  const run = deps.run ?? nodeRun;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const searchPath = deps.path ?? augmentedPath;
  const git = deps.git ?? ((args: string[], cwd: string) => gitRun(args, cwd, searchPath()));
  const installed = (cli: string) => findCliCandidates(cli, searchPath()).length > 0;
  const file = join(deps.dataDir, EDU_CREW_FILE);
  const jobs = new Map<string, JobRecord>();
  const reads = new Map<string, Promise<EduJob | null>>();
  const deciding = new Map<string, Promise<ResolveResult | null>>();
  const starting = new Map<string, number>();
  const stops = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closing = false;

  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { jobs?: unknown[] };
    for (const raw of saved.jobs ?? []) {
      const parsed = recordSchema.safeParse(raw);
      if (parsed.success) jobs.set(parsed.data.jobId, parsed.data);
    }
  } catch {}

  function save() {
    const kept = [...jobs.values()].sort((a, b) => a.at - b.at).slice(-KEPT_JOBS);
    jobs.clear();
    for (const job of kept) jobs.set(job.jobId, job);
    try { writeFileAtomic(file, `${JSON.stringify({ version: 1, jobs: kept })}\n`, { mode: 0o600 }); } catch (error) {
      console.warn(`edu crew: jobs not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const globalHome = () => resolveThroughLinks(env.EDU_HOME?.trim() || join(userHome(env), ".edu"));
  const active = () => [...jobs.values()].filter((job) => !ended(job.status));

  /** Edu's home is the bot's brain and nothing above the work folder is searched for another, so the job, its spec and
   * its runs stay in the bot's brain (or the work folder's own `.edu`) and the crew-worker guard Edu Bot sets on engines
   * is not inherited. */
  function crewEnv(brain: string, folder: string): NodeJS.ProcessEnv {
    const clean: NodeJS.ProcessEnv = { ...env, ...AGENTS_NODE_FLAG, PATH: searchPath(), EDU_HOME: join(brain, ".edu"), EDU_CEILING_DIRECTORIES: dirname(folder) };
    for (const key of ["EDU_CREW_JOB", "ALBERT_CREW_JOB", "EDU_PROJECT", "EDU_LOCK_WORKSPACE", "EDU_MCP_PROFILE"]) delete clean[key];
    return clean;
  }

  async function runEdu(runtime: EduRuntime, args: string[], brain: string, folder: string, timeoutMs: number) {
    return run([runtime.cli!, ...args], { env: crewEnv(brain, folder), timeoutMs });
  }

  /** Security: the one gate for every crew action, the tool listing and the skill alike. */
  function accessRefusal(bot: CrewBot, threadId: string): string | null {
    if (bot.eduCrew !== true) return "Edu crew is off for this bot. The person can turn it on in this bot's Memory settings.";
    if (env.EDU_CREW_JOB?.trim()) return "Edu Bot is running inside an Edu crew job, so it can't start crew jobs of its own.";
    return crewTurnRefusal(deps.turn(bot.id, threadId));
  }

  /** Where this bot's crew may work right now, with the Edu that serves it. */
  async function place(bot: CrewBot, threadId: string): Promise<{ ok: true; runtime: EduRuntime; brain: string; folder: string } | { ok: false; error: string }> {
    const refusal = accessRefusal(bot, threadId);
    if (refusal) return { ok: false, error: refusal };
    const brain = await deps.brains.brain(bot);
    if (!brain.ok) return { ok: false, error: `Edu crew needs this bot's Edu brain: ${brain.reason}` };
    const folder = deps.folder(bot.id, threadId);
    const unsafe = crewFolderRefusal(folder, { dataDir: deps.dataDir, home: userHome(env), globalHome: globalHome() });
    if (unsafe) return { ok: false, error: unsafe };
    return { ok: true, runtime: brain.runtime, brain: brain.folder, folder: resolveThroughLinks(folder!) };
  }

  function capRefusal(threadId: string): string | null {
    const running = active();
    const here = running.filter((job) => job.threadId === threadId).length + (starting.get(threadId) ?? 0);
    const all = running.length + [...starting.values()].reduce((sum, count) => sum + count, 0);
    const ask = "Wait for one to finish, or ask the person to cancel one on its line in the chat, then try again.";
    if (here >= MAX_ACTIVE_PER_CHAT) return `This chat already has ${MAX_ACTIVE_PER_CHAT} Edu crew jobs running, the most one chat may run at once. ${ask}`;
    if (all >= MAX_ACTIVE) return `Edu Bot already runs ${MAX_ACTIVE} Edu crew jobs on this computer, the most it runs at once. ${ask}`;
    return null;
  }

  function lineOf(job: JobRecord): EduCrewLine {
    return { jobId: job.jobId, kind: job.kind, status: job.status, title: job.title, ...(job.cli ? { cli: job.cli } : {}), ...(job.why ? { why: job.why } : {}), at: job.at };
  }

  function rowWords(job: JobRecord): string {
    const language = conversationLanguage(job.threadId);
    const key: ServerLineKey = job.status === "failed" ? "server.eduCrew.failed" : job.status === "cancelled" ? "server.eduCrew.cancelled"
      : job.kind === "review" ? (job.status === "done" ? "server.eduCrew.reviewDone" : "server.eduCrew.reviewRunning")
        : job.status === "waiting" ? "server.eduCrew.planWaiting" : job.status === "done" ? "server.eduCrew.planDone" : "server.eduCrew.planRunning";
    return serverLine(language, key, { title: job.title, cli: job.cli ?? "", why: job.why ?? "" });
  }

  function row(job: JobRecord) {
    return { tool: { name: rowWords(job), ok: job.status !== "failed" }, eduCrew: lineOf(job) };
  }

  function writeRow(job: JobRecord) {
    if (deps.store.messagesFor(job.threadId).some((message) => message.id === job.messageId)) deps.store.patchMessage(job.threadId, job.messageId, row(job));
  }

  function settleGate(job: JobRecord, answered: "allow" | "deny" | "unavailable") {
    if (!job.gateMessageId) return;
    const message = deps.store.messagesFor(job.threadId).find((candidate) => candidate.id === job.gateMessageId);
    if (message?.card && !message.card.answered) {
      deps.store.patchMessage(job.threadId, message.id, { card: { ...message.card, answered, ...(answered === "unavailable" ? { dismissed: true } : {}) } });
    }
    job.gateMessageId = undefined;
  }

  /** The job's own stores: the work folder's `.edu` when it has one, and the bot's brain. */
  const stores = (job: JobRecord) => [join(job.folder, ".edu"), join(job.brain, ".edu")];

  function storeText(job: JobRecord, pick: (store: string) => string | undefined, max: number): string | undefined {
    for (const store of stores(job)) {
      const path = pick(store);
      const real = path ? storeFile(store, path) : null;
      if (!real) continue;
      try {
        const text = readFileSync(real, "utf8").trim();
        if (text) return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
      } catch {}
    }
    return undefined;
  }

  const specText = (path: string | undefined, job: JobRecord) => path ? storeText(job, () => path, SPEC_CHARS) : undefined;

  function postGate(job: JobRecord, edu: EduJob) {
    const approval = edu.approval!;
    const bot = deps.store.bot(job.botId);
    const language = conversationLanguage(job.threadId);
    const spec = specText(edu.specPath, job);
    const gate: EduCrewGate = {
      jobId: job.jobId, gateId: approval.requestId, gate: oneLine(approval.title || "Approve", 120), goal: job.goal, folder: job.folder,
      ...(spec ? { spec } : {}),
      ...(approval.unregisteredChecks?.length ? { commands: approval.unregisteredChecks.slice(0, 20).map((command) => oneLine(String(command), 400)) } : {}),
    };
    const requestId = `educrew-${randomUUID()}`;
    const subtitle = serverLine(language, "server.eduCrew.gateSummary", { gate: gate.gate, title: job.title });
    const message = deps.store.appendMessage(job.threadId, {
      role: "bot", kind: "options",
      card: {
        title: serverLine(language, "server.eduCrew.gateTitle"), subtitle, options: [serverLine(language, "server.edu.approve"), serverLine(language, "server.edu.reject")],
        fixedOptions: true, requestId, tool: EDU_CREW_GATE_TOOL, eduCrewGate: gate,
      },
    });
    job.gateId = approval.requestId;
    job.gateMessageId = message.id;
    deps.decide({ threadId: job.threadId, requestId, botId: job.botId, botName: bot?.name, tool: EDU_CREW_GATE_TOOL, summary: subtitle, decision: "card-shown", source: "edu-brain" });
  }

  function apply(job: JobRecord, edu: EduJob) {
    const gateId = edu.approval?.requestId;
    if (crewStatus(edu.status) === "waiting" && gateId && !GATE_ID.test(gateId)) {
      edu = { id: job.jobId, status: "failed", summary: "Edu opened a gate whose id Edu Bot doesn't accept, so no card was shown and nothing was approved. Cancel the job in Edu." };
    }
    const status = crewStatus(edu.status);
    const why = status === "failed" ? oneLine(edu.summary || "Edu didn't say why.", WHY_CHARS)
      : status === "done" && edu.summary ? oneLine(edu.summary, WHY_CHARS) : undefined;
    const changed = status !== job.status || why !== job.why;
    if (edu.specPath) job.specPath = edu.specPath;
    if (status === "waiting" && edu.approval?.requestId && edu.approval.requestId !== job.gateId) {
      settleGate(job, "unavailable");
      postGate(job, edu);
    } else if (status !== "waiting") {
      settleGate(job, "unavailable");
      job.gateId = undefined;
    }
    if (changed) {
      job.status = status;
      job.why = why;
      job.at = now();
      writeRow(job);
    }
    save();
  }

  async function read(job: JobRecord): Promise<EduJob | null> {
    const runtime = await deps.brains.detect();
    if (runtime.state !== "ready" || !runtime.cli) return null;
    const result = await runEdu(runtime, eduCrewCommands.status(job.folder, job.jobId), job.brain, job.folder, READ_TIMEOUT_MS);
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout) as EduJob;
        if (parsed && typeof parsed.status === "string") { job.failures = 0; return parsed; }
      } catch {}
    }
    job.failures = (job.failures ?? 0) + 1;
    if (job.failures >= MAX_READ_FAILURES || /not found/i.test(result.stderr)) {
      apply(job, { id: job.jobId, status: "failed", summary: `Edu couldn't read this job any more: ${lastLine(result.stderr) || "no answer"}` });
    }
    return null;
  }

  /** One `edu crew status` at a time per job, shared by the follower and every waiting tool call. */
  function refresh(job: JobRecord): Promise<EduJob | null> {
    if (ended(job.status)) return Promise.resolve(null);
    const pending = reads.get(job.jobId);
    if (pending) return pending;
    const next = (async () => {
      try {
        const edu = await read(job);
        if (edu && !ended(job.status)) apply(job, edu);
        return edu;
      } catch (error) {
        console.warn(`edu crew: job ${job.jobId} not read: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        reads.delete(job.jobId);
      }
    })();
    reads.set(job.jobId, next);
    return next;
  }

  function stopFollowing() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function tick(): Promise<void> {
    await Promise.all(active().map(refresh));
    if (!active().length) stopFollowing();
  }

  function follow() {
    if (timer || closing) return;
    timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
  }

  function track(job: JobRecord) {
    jobs.set(job.jobId, job);
    save();
    follow();
  }

  /** Stops the job in Edu, which ends its worker's process tree; the job counts as cancelled only once Edu says so. */
  async function cancel(job: JobRecord): Promise<{ ok: true } | { ok: false; error: string }> {
    if (ended(job.status)) return { ok: true };
    const runtime = await deps.brains.detect();
    if (runtime.state !== "ready" || !runtime.cli) return { ok: false, error: "Edu isn't available right now, so the job wasn't cancelled and may still be running." };
    const result = await runEdu(runtime, eduCrewCommands.cancel(job.folder, job.jobId), job.brain, job.folder, DECIDE_TIMEOUT_MS);
    if (result.code !== 0) return { ok: false, error: `Edu couldn't cancel the job: ${lastLine(result.stderr) || `exit ${result.code}`}` };
    let edu: (EduJob & { note?: unknown }) | null = null;
    try { edu = JSON.parse(result.stdout) as EduJob & { note?: unknown }; } catch {}
    const outcome = edu && typeof edu.status === "string" && ended(crewStatus(edu.status)) ? crewStatus(edu.status) : "cancelled";
    apply(job, outcome === "cancelled" ? { id: job.jobId, status: "cancelled" } : edu!);
    if (outcome !== "cancelled") return { ok: false, error: `The job had already ended (${outcome}) before it could be cancelled.` };
    return typeof edu?.note === "string" && edu.note ? { ok: false, error: `Edu marked the job cancelled, but: ${oneLine(edu.note, WHY_CHARS)}` } : { ok: true };
  }

  async function cancelLogged(job: JobRecord): Promise<void> {
    const result = await cancel(job).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (!result.ok) console.warn(`edu crew: job ${job.jobId} not cancelled: ${result.error}`);
  }

  async function start(bot: CrewBot, threadId: string, kind: JobRecord["kind"], input: { goal: string; title: string; args: (folder: string) => string[]; cli?: string }, signal?: AbortSignal):
    Promise<{ ok: true; job: JobRecord } | { ok: false; error: string }> {
    if (closing) return { ok: false, error: "Edu Bot is closing, so no Edu crew job can start now." };
    const where = await place(bot, threadId);
    if (!where.ok) return where;
    const full = capRefusal(threadId);
    if (full) return { ok: false, error: full };
    const stopsBefore = stops.get(threadId) ?? 0;
    starting.set(threadId, (starting.get(threadId) ?? 0) + 1);
    let result: Awaited<ReturnType<typeof runEdu>>;
    try {
      result = await runEdu(where.runtime, input.args(where.folder), where.brain, where.folder, START_TIMEOUT_MS);
    } finally {
      const left = (starting.get(threadId) ?? 1) - 1;
      if (left > 0) starting.set(threadId, left);
      else starting.delete(threadId);
    }
    let edu: EduJob | null = null;
    try { edu = JSON.parse(result.stdout) as EduJob; } catch {}
    if (result.code !== 0 || !edu || typeof edu.id !== "string" || !JOB_ID.test(edu.id)) {
      return { ok: false, error: `Edu couldn't start the job: ${lastLine(result.stderr) || "it printed no job"}` };
    }
    const job: JobRecord = { jobId: edu.id, kind, botId: bot.id, threadId, messageId: "", folder: where.folder, brain: where.brain, title: input.title, goal: input.goal,
      status: crewStatus(edu.status), at: now(), ...(input.cli ? { cli: input.cli } : {}) };
    job.messageId = deps.store.appendMessage(threadId, { role: "bot", kind: "activity", ...row(job) }).id;
    track(job);
    apply(job, edu);
    if (signal?.aborted || closing || (stops.get(threadId) ?? 0) !== stopsBefore) {
      await cancelLogged(job);
      return { ok: false, error: "The turn stopped while Edu was starting this job, so it was cancelled." };
    }
    return { ok: true, job };
  }

  async function diffFor(folder: string, base: string): Promise<{ ok: true; diff: string; newFiles: string[] } | { ok: false; error: string }> {
    if (base.startsWith("-") || base.includes("\0") || base.length > 200) return { ok: false, error: `Unknown git base: ${base}` };
    try {
      await git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], folder);
    } catch (error) {
      if (missingProgram(error)) return { ok: false, error: GIT_MISSING };
      return { ok: false, error: `The working folder has no git commit ${JSON.stringify(base)} to review changes against.` };
    }
    let diff: string;
    let untracked: string;
    try {
      diff = await git(["diff", "--no-ext-diff", "--no-textconv", base, "--"], folder);
      untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], folder);
    } catch (error) {
      if (missingProgram(error)) return { ok: false, error: GIT_MISSING };
      return { ok: false, error: `git couldn't list the changes in the working folder (${oneLine(error instanceof Error ? error.message : String(error), 200)}). Review named paths instead.` };
    }
    const newFiles = untracked.split("\0").filter(Boolean);
    return {
      ok: true,
      diff: diff.length > DIFF_CHARS ? `${diff.slice(0, DIFF_CHARS)}\n… (diff cut at ${DIFF_CHARS} characters; read the files for the rest)` : diff,
      newFiles: newFiles.length > NEW_FILES ? [...newFiles.slice(0, NEW_FILES), `… and ${newFiles.length - NEW_FILES} more`] : newFiles,
    };
  }

  const summaryOf = (job: JobRecord, edu: EduJob | null) =>
    storeText(job, (store) => join(store, "crew", "artifacts", `${job.jobId}.summary.txt`), SUMMARY_CHARS) ?? edu?.summary?.trim() ?? job.why ?? "";

  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done) => {
    if (signal?.aborted) return done();
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      done();
    };
    const timeout = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

  async function wait(job: JobRecord, seconds: number, signal?: AbortSignal): Promise<EduJob | null> {
    const deadline = now() + Math.min(Math.max(seconds, 0), MAX_WAIT_S) * 1000;
    let last: EduJob | null = null;
    for (;;) {
      last = (await refresh(job)) ?? last;
      if (ended(job.status) || job.status === "waiting" || now() >= deadline || signal?.aborted) return last;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())), signal);
    }
  }

  function statusText(job: JobRecord): string {
    const head = `Edu crew job ${job.jobId} (${job.kind === "plan" ? "plan and build" : `review by ${job.cli}`}, in ${job.folder}): `;
    switch (job.status) {
      case "waiting": return `${head}waiting for the person to approve a gate on the card in this chat. You cannot approve it, and nothing more runs until they do; do not ask them to approve it anywhere else.`;
      case "running": return `${head}running. Its line in this chat updates on its own; check again with edu_crew_result if you need its result in this turn.`;
      case "done": return `${head}done.`;
      case "cancelled": return `${head}cancelled.`;
      default: return `${head}failed. Edu's reason:\n${recordsText("Edu crew, about work other agents did", job.why ?? "Edu didn't say why.", WHY_CHARS + 10)}`;
    }
  }

  function resultText(job: JobRecord, edu: EduJob | null): string {
    if (job.status !== "done" && job.status !== "failed") return statusText(job);
    const summary = summaryOf(job, edu);
    const source = job.kind === "review" ? `the review ${job.cli ?? "another vendor's CLI"} wrote, another agent's opinion` : "Edu crew's summary, written by other agents";
    return summary ? `${statusText(job)}\n\n${recordsText(source, summary, SUMMARY_CHARS + 10)}` : statusText(job);
  }

  const bodySchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("plan"), goal: z.string().trim().min(1).max(4000), playbook: z.string().regex(PLAYBOOK).optional() }),
    z.object({ action: z.literal("review"), question: z.string().trim().max(4000).optional(), paths: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
      base: z.string().trim().min(1).max(200).optional(), reviewer: z.string().max(20).optional(), wait_seconds: z.number().min(0).max(MAX_WAIT_S).optional() }),
    z.object({ action: z.literal("status"), job_id: z.string().optional() }),
    z.object({ action: z.literal("result"), job_id: z.string(), wait_seconds: z.number().min(0).max(MAX_WAIT_S).optional() }),
  ]);

  function ownJob(botId: string, threadId: string, id: string | undefined): JobRecord | string {
    const job = id ? jobs.get(id.trim()) : undefined;
    if (!job || job.botId !== botId || job.threadId !== threadId) return `No Edu crew job ${JSON.stringify(id ?? "")} in this chat. Call edu_crew_status without job_id for this chat's jobs.`;
    return job;
  }

  async function review(bot: CrewBot, threadId: string, body: Extract<z.infer<typeof bodySchema>, { action: "review" }>, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    const where = await place(bot, threadId);
    if (!where.ok) return { status: 409, text: where.error };
    const reviewer = pickReviewer(eduCliOf(deps.engine(bot.id, threadId)), body.reviewer, installed);
    if (!reviewer.ok) return { status: 409, text: reviewer.error };
    const outside = (body.paths ?? []).map((path) => reviewPathRefusal(where.folder, path)).find(Boolean);
    if (outside) return { status: 400, text: outside };
    const changes = body.base !== undefined || (!body.question && !body.paths?.length) ? await diffFor(where.folder, body.base ?? "HEAD") : undefined;
    if (changes && !changes.ok) return { status: 409, text: changes.error };
    const task = reviewTask({ question: body.question, paths: body.paths, base: body.base, ...(changes ? { diff: changes.diff, newFiles: changes.newFiles } : {}) });
    const title = oneLine(redactSecretsInText(body.question || (body.paths?.length ? body.paths.join(", ") : serverLine(conversationLanguage(threadId), "server.eduCrew.reviewChanges", { base: body.base ?? "HEAD" }))), TITLE_CHARS);
    const started = await start(bot, threadId, "review", { goal: title, title, cli: reviewer.cli, args: (folder) => eduCrewCommands.review(folder, reviewer.cli, task) }, signal);
    if (!started.ok) return { status: 409, text: started.error };
    const edu = await wait(started.job, body.wait_seconds ?? 120, signal);
    return { status: 200, text: resultText(started.job, edu) };
  }

  async function fromBot(botId: string, threadId: string, raw: unknown, signal?: AbortSignal): Promise<{ status: number; text: string }> {
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return { status: 400, text: parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
    const body = parsed.data;
    const bot = deps.store.bot(botId);
    if (!bot) return { status: 404, text: "This bot is gone." };
    const refusal = accessRefusal(bot, threadId);
    if (refusal) return { status: 409, text: refusal };
    if (body.action === "status" || body.action === "result") {
      if (body.action === "status" && !body.job_id) {
        const mine = [...jobs.values()].filter((job) => job.botId === botId && job.threadId === threadId).slice(-10);
        return { status: 200, text: mine.length ? mine.map(statusText).join("\n") : "No Edu crew jobs in this chat." };
      }
      const job = ownJob(botId, threadId, body.job_id);
      if (typeof job === "string") return { status: 404, text: job };
      const edu = await wait(job, body.action === "result" ? body.wait_seconds ?? 60 : 0, signal);
      return { status: 200, text: body.action === "result" ? resultText(job, edu) : statusText(job) };
    }
    if (body.action === "review") return review(bot, threadId, body, signal);
    const goal = redactSecretsInText(body.goal);
    const started = await start(bot, threadId, "plan", { goal, title: oneLine(goal, TITLE_CHARS), args: (folder) => eduCrewCommands.plan(folder, goal, body.playbook) }, signal);
    if (!started.ok) return { status: 409, text: started.error };
    return { status: 200, text: `Edu crew job ${started.job.jobId} started in ${started.job.folder}. Edu writes a spec first; when it is ready the person gets an approval card in this chat, and later steps may ask again. Only the person can approve; nothing is built until they do. Follow it with edu_crew_status or edu_crew_result (job_id ${started.job.jobId}).` };
  }

  async function decide(threadId: string, requestId: string, behavior: string): Promise<ResolveResult | null> {
    const message = deps.store.messagesFor(threadId).find((candidate) => candidate.card?.requestId === requestId && candidate.card.eduCrewGate);
    const gate = message?.card?.eduCrewGate;
    if (!message?.card || !gate) return null;
    if (behavior !== "allow" && behavior !== "deny") return { ok: false, status: 400, error: "Approve or reject an Edu crew gate; it takes no other answer." };
    if (message.card.answered) return { ok: true, outcome: message.card.answered === "allow" ? "allowed-once" : message.card.answered === "deny" ? "rejected" : "unavailable", alreadySettled: true };
    const job = jobs.get(gate.jobId);
    const settle = (answered: "allow" | "deny" | "unavailable") => {
      deps.store.patchMessage(threadId, message.id, { card: { ...message.card!, answered, ...(answered === "unavailable" ? { dismissed: true } : {}) } });
      if (job?.gateMessageId === message.id) job.gateMessageId = undefined;
    };
    if (!job || ended(job.status) || job.gateId !== gate.gateId || !GATE_ID.test(gate.gateId)) { settle("unavailable"); return { ok: true, outcome: "unavailable" }; }
    if (env.EDU_CREW_JOB?.trim()) return { ok: false, status: 409, error: "Edu Bot is running inside an Edu crew job, so Edu won't let it decide gates. Decide it in Edu itself." };
    const runtime = await deps.brains.detect();
    if (runtime.state !== "ready" || !runtime.cli) return { ok: false, status: 503, error: "Edu isn't available right now. Check the Edu brain in this bot's Memory settings." };
    const result = await runEdu(runtime, eduCrewCommands.decide(job.folder, job.jobId, gate.gateId, behavior === "allow"), job.brain, job.folder, DECIDE_TIMEOUT_MS);
    if (result.code !== 0) {
      if (/not awaiting approval|is not the one|not found/i.test(result.stderr)) { settle("unavailable"); void refresh(job); return { ok: true, outcome: "unavailable" }; }
      return { ok: false, status: 502, error: `Edu couldn't take this decision: ${lastLine(result.stderr) || `exit ${result.code}`}` };
    }
    settle(behavior === "allow" ? "allow" : "deny");
    const bot = deps.store.bot(job.botId);
    deps.decide({ threadId, requestId, botId: job.botId, botName: bot?.name, tool: EDU_CREW_GATE_TOOL, summary: message.card.subtitle,
      decision: behavior === "allow" ? "user-approved" : "user-denied", source: "user" });
    save();
    follow();
    return { ok: true, outcome: behavior === "allow" ? "allowed-once" : "rejected" };
  }

  return {
    /** The agents tools' route: `POST /api/internal/edu/crew` with an action. */
    async internal(ctx: { method: string; path: string; res: unknown; json(res: unknown, status: number, body: unknown): void; botId: string; threadId: string; readBody(): Promise<unknown>; signal?: () => AbortSignal }): Promise<typeof PASS | void> {
      if (ctx.path !== EDU_CREW_PATH) return PASS;
      if (ctx.method !== "POST") return ctx.json(ctx.res, 405, { error: "method not allowed" });
      const answer = await fromBot(ctx.botId, ctx.threadId, await ctx.readBody(), ctx.signal?.()).catch((error: unknown) => ({ status: 500, text: `Edu crew failed: ${error instanceof Error ? error.message : String(error)}` }));
      return ctx.json(ctx.res, answer.status, answer.status === 200 ? { text: answer.text } : { error: answer.text });
    },

    /** Whether this conversation lists the crew tools and gets the crew skill: the bot's switch is on, Edu was found ready
     * here, and `accessRefusal` lets it through. */
    offered(botId: string, threadId: string): boolean {
      const bot = deps.store.bot(botId);
      return Boolean(bot) && deps.brains.readyNow() && accessRefusal(bot!, threadId) === null;
    },

    /** `EduBrainView.crew`. */
    async view(bot: CrewBot): Promise<EduCrewView> {
      if (bot.eduCrew !== true) return { enabled: false };
      const where = await place(bot, bot.threadId ?? "");
      return where.ok ? { enabled: true, folder: where.folder } : { enabled: true, blocked: where.error };
    },

    /** Security: a gate is a person's decision, by the rule for Edu proposals. `undefined` when the card is not a gate. */
    answerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null | undefined {
      const card = deps.store.messagesFor(threadId).find((message) => message.card?.requestId === requestId)?.card;
      if (!card?.eduCrewGate) return undefined;
      return eduDecisionRefusal(auth, deps.desktop, behavior !== "deny");
    },

    /** The person's answer on a gate card; null when the request is not one. One decision per card reaches Edu: a second
     * answer while the first is still with Edu gets the first one's outcome. */
    resolve(threadId: string, requestId: string, behavior: string): Promise<ResolveResult | null> {
      const key = `${threadId}\0${requestId}`;
      const pending = deciding.get(key);
      if (pending) return pending.then((result) => result?.ok ? { ...result, alreadySettled: true as const } : result);
      const next = decide(threadId, requestId, behavior).finally(() => deciding.delete(key));
      deciding.set(key, next);
      return next;
    },

    /** The person stopped a turn here: every crew job of this conversation stops with it, and one still starting is
     * cancelled as soon as Edu names it. */
    async stopped(threadId: string): Promise<void> {
      stops.set(threadId, (stops.get(threadId) ?? 0) + 1);
      await Promise.all(active().filter((job) => job.threadId === threadId).map(cancelLogged));
    },

    async cancelFor(jobId: string): Promise<{ ok: true; line: EduCrewLine } | { ok: false; status: number; error: string }> {
      const job = jobs.get(jobId);
      if (!job) return { ok: false, status: 404, error: "No such Edu crew job." };
      const result = await cancel(job);
      return result.ok ? { ok: true, line: lineOf(job) } : { ok: false, status: 502, error: result.error };
    },

    details(jobId: string): EduCrewDetails | null {
      const job = jobs.get(jobId);
      if (!job) return null;
      const spec = specText(job.specPath, job);
      const summary = ended(job.status) ? summaryOf(job, null) : "";
      return { line: lineOf(job), folder: job.folder, ...(spec ? { spec } : {}), ...(summary ? { summary } : {}) };
    },

    /** Follows the jobs a crash left running; a clean quit cancels them (`shutdown`). */
    resume(): void {
      if (active().length) follow();
    },

    tick,
    stop: stopFollowing,

    /** Edu Bot quits: no job starts any more, and every running job is cancelled in Edu, which ends its process tree. */
    async shutdown(): Promise<void> {
      closing = true;
      stopFollowing();
      const done = new AbortController();
      await Promise.race([Promise.all(active().map(cancelLogged)).finally(() => done.abort()), sleep(SHUTDOWN_CANCEL_MS, done.signal)]);
    },
  };
}

type ResolveResult = { ok: true; outcome: "allowed-once" | "rejected" | "unavailable"; alreadySettled?: true } | { ok: false; status: number; error: string };

export type EduCrew = ReturnType<typeof createEduCrew>;
