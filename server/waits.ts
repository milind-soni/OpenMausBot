import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { WAIT_HOURS, type WaitKind } from "../shared/waits.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import {
  expandHome,
  fetchPageText,
  fileChanged,
  fileStamp,
  listProcesses,
  pageSays,
  processRunning,
  type FileStamp,
  type PageResult,
  type ProcessEntry,
} from "./wait-probes.ts";

export const WAIT_LIMITS = { perBot: 10, total: 50 } as const;
export const WAIT_TICK_MS = 5_000, URL_CHECK_MS = 60_000, URL_BACKOFF_MAX_MS = 15 * 60_000;
/** A sleeping Cloud wakes this often while a wait is open, to check it; checks pause in between. */
export const WAIT_WAKE_MS = 30 * 60_000;
export const NO_PROCESS_LIST = "This computer can't list its programs, so a program wait can't work here. Wait for a file or a page instead.";

export type NewWaitCondition =
  | { kind: "url_contains" | "url_missing"; url: string; text: string }
  | { kind: "file_exists" | "file_missing" | "file_changed"; path: string }
  | { kind: "process_running" | "process_gone"; process: string }
  | { kind: "bot_idle"; botId: string; botName: string };
export type WaitCondition =
  | { kind: "url_contains"; url: string; text: string }
  /** `sawText`: a check found the text, so its going counts (a page its scripts draw reads bare from the start). */
  | { kind: "url_missing"; url: string; text: string; sawText: boolean }
  | { kind: "file_exists" | "file_missing"; path: string }
  | { kind: "file_changed"; path: string; before: FileStamp | null }
  | { kind: "process_running" | "process_gone"; process: string }
  | { kind: "bot_idle"; botId: string; botName: string; sawBusy: boolean };
export interface WaitNotice { status: "fired" | "expired" | "stopped"; text: string }
export interface WaitRecord {
  id: string; botId: string; threadId: string; label: string; condition: WaitCondition; followUp?: string;
  createdAt: number; expiresAt: number; nextCheckAt: number; errors: number; cardMessageId?: string;
  /** Decided and saved first; posted once its chat is free. */
  ending?: WaitNotice;
}
export interface NewWait { botId: string; threadId: string; label: string; condition: NewWaitCondition; followUp?: string; hours?: number }
export type CreateWaitResult =
  | { state: "created"; wait: WaitRecord; note?: string }
  | { state: "already"; text: string }
  | { state: "refused"; status: 400 | 409; error: string };
export interface WaitProbes { page(url: string): Promise<PageResult>; stamp(path: string): Promise<FileStamp | null>; processes(): Promise<ProcessEntry[]> }
export interface WaitManagerOptions {
  file?: string; now?: () => number; probes?: Partial<WaitProbes>;
  sourceAlive(botId: string, threadId: string): boolean;
  /** Undefined once that bot no longer exists. */
  botBusy(botId: string): boolean | undefined;
  /** False while a turn runs in the chat: try again next tick. */
  post(wait: WaitRecord, notice: WaitNotice): boolean;
  followUp(wait: WaitRecord & { followUp: string }): void;
  showCard(wait: WaitRecord & { followUp: string }): string | undefined;
  settleCard(wait: WaitRecord, how: "fired" | "expired" | "cancelled"): void;
}

const stampSchema = z.object({ size: z.number(), mtimeMs: z.number() });
const conditionSchema = z.union([
  z.object({ kind: z.literal("url_contains"), url: z.string(), text: z.string() }),
  z.object({ kind: z.literal("url_missing"), url: z.string(), text: z.string(), sawText: z.boolean() }),
  z.object({ kind: z.enum(["file_exists", "file_missing"]), path: z.string() }),
  z.object({ kind: z.literal("file_changed"), path: z.string(), before: stampSchema.nullable() }),
  z.object({ kind: z.enum(["process_running", "process_gone"]), process: z.string() }),
  z.object({ kind: z.literal("bot_idle"), botId: z.string(), botName: z.string(), sawBusy: z.boolean() }),
]);
const recordSchema = z.object({
  id: z.string(),
  botId: z.string(),
  threadId: z.string(),
  label: z.string(),
  condition: conditionSchema,
  followUp: z.string().optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
  nextCheckAt: z.number(),
  errors: z.number(),
  cardMessageId: z.string().optional(),
  ending: z.object({ status: z.enum(["fired", "expired", "stopped"]), text: z.string() }).optional(),
});
const fileSchema = z.object({ version: z.literal(1), waits: z.array(z.unknown()) });

export function describeCondition(condition: NewWaitCondition | WaitCondition): string {
  switch (condition.kind) {
    case "url_contains": return `${condition.url} says “${condition.text}”`;
    case "url_missing": return `${condition.url} no longer says “${condition.text}”`;
    case "file_exists": return `${condition.path} exists`;
    case "file_missing": return `${condition.path} is gone`;
    case "file_changed": return `${condition.path} changes`;
    case "process_running": return `${condition.process} is running`;
    case "process_gone": return `${condition.process} has stopped`;
    case "bot_idle": return `${condition.botName} finishes its work`;
  }
}

function firedDetail(condition: WaitCondition): string {
  switch (condition.kind) {
    case "url_contains": return `${condition.url} now says “${condition.text}”.`;
    case "url_missing": return `${condition.url} no longer says “${condition.text}”.`;
    case "file_exists": return `${condition.path} is there now.`;
    case "file_missing": return `${condition.path} is gone.`;
    case "file_changed": return `${condition.path} changed.`;
    case "process_running": return `${condition.process} is running.`;
    case "process_gone": return `${condition.process} stopped.`;
    case "bot_idle": return `${condition.botName} finished.`;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export function waitList(waits: readonly WaitRecord[]): string {
  return waits
    .map((w) => `- ${w.id} · ${w.label} · until ${describeCondition(w.condition)} · made ${iso(w.createdAt)} · stops ${iso(w.expiresAt)}${w.followUp ? ` · follow_up: ${w.followUp}` : ""}`)
    .join("\n");
}

const isPage = (condition: NewWaitCondition | WaitCondition) => condition.kind === "url_contains" || condition.kind === "url_missing";

function interval(kind: WaitKind, errors: number): number {
  if (kind !== "url_contains" && kind !== "url_missing") return WAIT_TICK_MS;
  return Math.min(URL_CHECK_MS * 2 ** errors, URL_BACKOFF_MAX_MS);
}

function cloneWait(wait: WaitRecord): WaitRecord {
  return structuredClone(wait);
}

type Verdict = { met: boolean; gone?: boolean; unlisted?: boolean; page?: { ok: true } | { ok: false; refused: boolean; error: string } };

export class WaitManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly probes: WaitProbes;
  private readonly options: WaitManagerOptions;
  private waits: WaitRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private ticking = false;
  private pageTail: Promise<unknown> = Promise.resolve();
  private pagesQueued = 0;

  constructor(options: WaitManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "waits.json");
    this.now = options.now ?? Date.now;
    this.probes = {
      page: (url) => fetchPageText(url),
      stamp: (path) => fileStamp(expandHome(path, homedir())),
      processes: () => listProcesses(),
      ...options.probes,
    };
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      this.waits = parsed.success
        ? parsed.data.waits.flatMap((candidate) => {
            const record = recordSchema.safeParse(candidate);
            return record.success ? [record.data as WaitRecord] : [];
          })
        : [];
    } catch {
      this.waits = [];
    }
  }

  async create(input: NewWait): Promise<CreateWaitResult> {
    const full = this.limitRefusal(input);
    if (full) return full;
    const condition = await this.startingCondition(input.condition);
    const verdict = await this.probe(condition, undefined);
    if (verdict.gone) return { state: "refused", status: 400, error: `${(condition as { botName: string }).botName} no longer exists. Use a name or id from list_bots.` };
    if (verdict.unlisted) return { state: "refused", status: 400, error: NO_PROCESS_LIST };
    if (verdict.page && !verdict.page.ok && verdict.page.refused) return { state: "refused", status: 400, error: verdict.page.error };
    if (verdict.met) return { state: "already", text: `${describeCondition(condition)} already. Nothing was set up: tell the person now.` };
    const crowded = this.limitRefusal(input);
    if (crowded) return crowded;
    const now = this.now();
    const wait: WaitRecord = {
      id: randomUUID(),
      botId: input.botId,
      threadId: input.threadId,
      label: input.label,
      condition,
      ...(input.followUp ? { followUp: input.followUp } : {}),
      createdAt: now,
      expiresAt: now + (input.hours ?? WAIT_HOURS.default) * 3_600_000,
      nextCheckAt: now + interval(condition.kind, 0),
      errors: 0,
    };
    this.commit(() => this.waits.push(wait));
    if (wait.followUp) {
      const cardMessageId = this.options.showCard(wait as WaitRecord & { followUp: string });
      if (cardMessageId) {
        try { this.commit(() => { wait.cardMessageId = cardMessageId; }); } catch (error) { console.error(`wait ${wait.id}: could not store the card id`, error); }
      }
    }
    const note = verdict.page && !verdict.page.ok
      ? `The page could not be read just now (${verdict.page.error}); checks go on every minute and slow down while it keeps failing.`
      : condition.kind === "url_missing" && !condition.sawText
        ? `The page does not say “${condition.text}” now, as a plain check reads it (without running its scripts), so this fires only once it says it and then stops. It may be gone already, or shown only by the page's scripts: tell the person.`
        : undefined;
    return { state: "created", wait: cloneWait(wait), ...(note ? { note } : {}) };
  }

  private limitRefusal({ botId, threadId }: Pick<NewWait, "botId" | "threadId">): CreateWaitResult | null {
    const mine = this.waits.filter((w) => w.botId === botId && !w.ending);
    if (mine.length >= WAIT_LIMITS.perBot) {
      const here = mine.filter((w) => w.threadId === threadId), others = mine.length - here.length;
      const full = `You already keep ${WAIT_LIMITS.perBot} waits, the most one bot may`;
      const error = here.length
        ? `${full}. In this chat:\n${waitList(here)}${others ? `\n${others} more in other chats.` : ""}\nCancel one with cancel_wait first.`
        : `${full}, all in other chats. Ask the person to stop one in the chat it was made in.`;
      return { state: "refused", status: 409, error };
    }
    if (this.waits.length >= WAIT_LIMITS.total) {
      return { state: "refused", status: 409, error: `This computer already keeps ${WAIT_LIMITS.total} waits, the most it holds. Ask the person which ones to stop.` };
    }
    return null;
  }

  private async startingCondition(condition: NewWaitCondition): Promise<WaitCondition> {
    switch (condition.kind) {
      case "file_changed": return { ...condition, before: await this.probes.stamp(condition.path) };
      case "file_exists":
      case "file_missing": return { kind: condition.kind, path: condition.path };
      case "bot_idle": return { ...condition, sawBusy: false };
      case "url_contains": return { kind: "url_contains", url: condition.url, text: condition.text };
      case "url_missing": return { kind: "url_missing", url: condition.url, text: condition.text, sawText: false };
      default: return { ...condition };
    }
  }

  list(botId: string): WaitRecord[] {
    return this.waits.filter((w) => w.botId === botId && !w.ending).map(cloneWait);
  }

  /** Every wait, those ended but not yet posted too. */
  all(): WaitRecord[] {
    return this.waits.map(cloneWait);
  }

  cancel(id: string, botId: string): WaitRecord | null {
    const wait = this.waits.find((w) => w.id === id && w.botId === botId);
    if (!wait) return null;
    this.commit(() => { this.waits = this.waits.filter((w) => w !== wait); });
    if (wait.cardMessageId) this.safely(() => this.options.settleCard(wait, "cancelled"));
    return cloneWait(wait);
  }

  owners(): string[] {
    return [...new Set(this.waits.map((w) => w.botId))];
  }

  /** When a sleeping Cloud should wake to check: WAIT_WAKE_MS on while a wait is open, never a page's next minute (the
   * home would never sleep), null with none open. */
  nextWakeAt(): number | null {
    return this.waits.some((w) => !w.ending) ? this.now() + WAIT_WAKE_MS : null;
  }

  removeForBot(botId: string): number {
    const removed = this.waits.filter((w) => w.botId === botId).length;
    if (!removed) return 0;
    this.commit(() => { this.waits = this.waits.filter((w) => w.botId !== botId); });
    return removed;
  }

  noteBotBusy(botId: string): void {
    const pending = this.waits.filter((w) => !w.ending && w.condition.kind === "bot_idle" && w.condition.botId === botId && !w.condition.sawBusy);
    if (!pending.length) return;
    this.commit(() => {
      for (const w of pending) if (w.condition.kind === "bot_idle") w.condition.sawBusy = true;
    });
  }

  /** True while a tick decides and posts; its checks, a slow page among them, run before that. */
  get isTicking(): boolean { return this.ticking; }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.runTick();
    this.timer = setInterval(() => this.runTick(), WAIT_TICK_MS);
    this.timer.unref?.();
  }

  private runTick(): void {
    this.tick().catch((error) => console.error("wait tick failed", error));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const alive = this.waits.filter((w) => this.options.sourceAlive(w.botId, w.threadId));
      if (alive.length !== this.waits.length) {
        this.waits = alive;
        this.save();
      }
      const now = this.now();
      const due = this.waits.filter((w) => !w.ending && now >= w.nextCheckAt);
      const verdicts = new Map<WaitRecord, Verdict>();
      let processes: Promise<ProcessEntry[]> | undefined;
      const readProcesses = () => (processes ??= this.probes.processes());
      const pages = this.pagesQueued > 0 ? [] : due.filter((w) => isPage(w.condition));
      const chain = async () => {
        for (const w of pages) verdicts.set(w, await this.probe(w.condition, readProcesses));
      };
      await Promise.all([
        chain(),
        ...due.filter((w) => !isPage(w.condition)).map(async (w) => { verdicts.set(w, await this.probe(w.condition, readProcesses)); }),
      ]);
      if (!this.stopped) this.settle(now, verdicts);
    } finally {
      this.running = false;
    }
  }

  private settle(now: number, verdicts: ReadonlyMap<WaitRecord, Verdict>): void {
    this.ticking = true;
    try {
      let decided = false;
      for (const wait of this.waits.slice()) {
        if (wait.ending) continue;
        const verdict = verdicts.get(wait);
        const expired = now >= wait.expiresAt;
        if (!verdict) {
          if (expired && now < wait.nextCheckAt) {
            wait.ending = this.expiredNotice(wait);
            decided = true;
          }
          continue;
        }
        if (verdict.met) wait.ending = { status: "fired", text: `${wait.label}: done. ${firedDetail(wait.condition)}` };
        else if (verdict.gone && wait.condition.kind === "bot_idle") wait.ending = { status: "stopped", text: `Stopped waiting for ${wait.label}: ${wait.condition.botName} no longer exists.` };
        else if (expired) wait.ending = this.expiredNotice(wait);
        else {
          wait.errors = verdict.page && !verdict.page.ok ? wait.errors + 1 : 0;
          wait.nextCheckAt = now + interval(wait.condition.kind, wait.errors);
          decided = true;
          continue;
        }
        decided = true;
      }
      if (decided) this.save();

      for (const wait of this.waits.slice()) {
        if (!wait.ending) continue;
        let posted = false;
        try { posted = this.options.post(wait, wait.ending); } catch (error) { console.error(`wait ${wait.id}: could not post`, error); }
        if (!posted) continue;
        const status = wait.ending.status;
        this.commit(() => { this.waits = this.waits.filter((w) => w !== wait); });
        if (status === "fired" && wait.followUp) this.safely(() => this.options.followUp(wait as WaitRecord & { followUp: string }));
        if (wait.cardMessageId) this.safely(() => this.options.settleCard(wait, status === "fired" ? "fired" : "expired"));
      }
    } finally {
      this.ticking = false;
    }
  }

  private expiredNotice(wait: WaitRecord): WaitNotice {
    const n = Math.round((wait.expiresAt - wait.createdAt) / 3_600_000);
    return { status: "expired", text: `Stopped waiting for ${wait.label} after ${n} hour${n === 1 ? "" : "s"}.` };
  }

  private runPage(url: string): Promise<PageResult> {
    this.pagesQueued++;
    const run = this.pageTail.then(() => this.probes.page(url));
    this.pageTail = run.then(() => undefined, () => undefined).then(() => { this.pagesQueued--; });
    return run;
  }

  private async probe(condition: WaitCondition, processes: (() => Promise<ProcessEntry[]>) | undefined): Promise<Verdict> {
    switch (condition.kind) {
      case "url_contains":
      case "url_missing": {
        const page = await this.runPage(condition.url);
        if (!page.ok) return { met: false, page };
        const says = pageSays(page.text, condition.text);
        if (condition.kind === "url_contains") return { met: says, page: { ok: true } };
        if (says) condition.sawText = true;
        return { met: condition.sawText && !says, page: { ok: true } };
      }
      case "file_exists": return { met: (await this.probes.stamp(condition.path)) !== null };
      case "file_missing": return { met: (await this.probes.stamp(condition.path)) === null };
      case "file_changed": return { met: fileChanged(condition.before, await this.probes.stamp(condition.path)) };
      case "process_running":
      case "process_gone": {
        try {
          const running = processRunning(await (processes ?? (() => this.probes.processes()))(), condition.process);
          return { met: condition.kind === "process_running" ? running : !running };
        } catch {
          return { met: false, unlisted: true };
        }
      }
      case "bot_idle": {
        const busy = this.options.botBusy(condition.botId);
        if (busy === undefined) return { met: false, gone: true };
        if (busy) { condition.sawBusy = true; return { met: false }; }
        return { met: condition.sawBusy };
      }
    }
  }

  private safely(run: () => void): void {
    try { run(); } catch (error) { console.error("wait: callback failed", error); }
  }

  private commit(mutate: () => void): void {
    const before = this.waits.map(cloneWait);
    const identity = this.waits.slice();
    try {
      mutate();
      this.save();
    } catch (error) {
      identity.forEach((w, i) => {
        for (const key of Object.keys(w)) delete (w as unknown as Record<string, unknown>)[key];
        Object.assign(w, before[i]);
      });
      this.waits = identity;
      throw error;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, waits: this.waits }, null, 2), { mode: 0o600 });
  }
}
