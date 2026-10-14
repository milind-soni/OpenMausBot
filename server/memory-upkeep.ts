import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { CaptureBuffer, capturePrompt, newCandidates, parseCandidates, type Candidate, type CaptureBatch, type CaptureTurn } from "./memory-capture.ts";
import { factIdentity, lineFactIdentity, notebookIdentities } from "./memory-entries.ts";
import { mergeTopicText } from "./memory-topics.ts";
import { applyMoves, MAX_MOVES, organizeCandidates, organizePrompt, parseMoves } from "./memory-organize.ts";
import { recordMemoryChange } from "./memory-journal.ts";
import { applyTidy, contradictionCandidates, contradictionPrompt, parseContradictions, planChanges, planTidy, type Contradiction } from "./memory-tidy.ts";
import { appendMemoryArchive, ARCHIVE_TOPIC, ensureWorkspace, listMemoryTopics, memoryDate, memoryEntry, memoryTopicIndex, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

export const CAPTURE_MAX_TURNS = 6;
export const MODEL_TIMEOUT_MS = 60_000;
export const TIDY_CHECK_MS = 10 * 60_000;
export const MIN_ENTRIES_FOR_CONTRADICTIONS = 5;
const ARCHIVE_PATH = `memory/${ARCHIVE_TOPIC}`;
export const MAX_PENDING_THREADS = 50;
export const TOPIC_MAX_BYTES = 64 * 1024;

export interface UpkeepEngine {
  generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;
}

export interface UpkeepBot {
  id: string;
  name: string;
  memoryUpkeep?: boolean;
  memoryEnabled?: boolean;
}

export function upkeepEnabled(bot: Pick<UpkeepBot, "memoryUpkeep" | "memoryEnabled"> | undefined): bot is UpkeepBot {
  return Boolean(bot) && bot!.memoryUpkeep !== false && bot!.memoryEnabled !== false;
}

export interface UpkeepDeps {
  bots: () => readonly UpkeepBot[];
  bot: (id: string) => UpkeepBot | undefined;
  engine: (botId: string) => UpkeepEngine | null;
  busy: (botId: string) => boolean;
  addToAboutMe: (from: { botId: string; botName: string }, texts: readonly string[]) => number;
  sourceLabel: (botId: string, threadId: string) => string;
  /** Asked again at capture, so a turn queued before a visibility change is dropped. */
  mayCapture?: (botId: string, threadId: string) => boolean;
  restoreTurn?: (botId: string, threadId: string, turnId: string) => CaptureTurn | null;
  quietMs: () => number;
  tidyHour: () => number;
  writing?: <T>(botId: string, write: () => T) => T;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface TidyReport {
  at: number;
  expired: number;
  duplicates: number;
  superseded: number;
  deferred: number;
  organized?: number;
  contradictionsChecked: boolean;
  note?: string;
}

export interface CaptureReport {
  at: number;
  added: number;
  topics: number;
  aboutMe: number;
  organized?: number;
  note?: string;
}

interface UpkeepState {
  bots: Record<string, { lastTidy?: TidyReport; lastCapture?: CaptureReport; core?: string[] }>;
}

const MAX_CORE = 500;

function statePath(): string {
  return join(DATA_DIR, "memory-upkeep.json");
}

function loadState(): UpkeepState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as UpkeepState;
    return parsed && typeof parsed.bots === "object" && parsed.bots ? parsed : { bots: {} };
  } catch {
    return { bots: {} };
  }
}

function saveState(state: UpkeepState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
  }
}

interface PendingCapture {
  batches: { botId: string; threadId: string; turnIds: string[] }[];
}

function pendingPath(): string {
  return join(DATA_DIR, "memory-capture-pending.json");
}

function savePending(batches: readonly CaptureBatch[]): void {
  const byThread = new Map<string, { botId: string; threadId: string; turnIds: string[] }>();
  for (const batch of batches) {
    const ids = batch.turns.map((turn) => turn.turnId).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) continue;
    const key = `${batch.botId}\n${batch.threadId}`;
    const entry = byThread.get(key) ?? { botId: batch.botId, threadId: batch.threadId, turnIds: [] };
    entry.turnIds.push(...ids.filter((id) => !entry.turnIds.includes(id)));
    byThread.set(key, entry);
  }
  if (!byThread.size) return;
  const state: PendingCapture = {
    batches: [...byThread.values()].slice(-MAX_PENDING_THREADS).map((entry) => ({ ...entry, turnIds: entry.turnIds.slice(-CAPTURE_MAX_TURNS) })),
  };
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(pendingPath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
  }
}

/** Removed before replay, so a start that fails part way never replays them twice. */
function takePending(): PendingCapture["batches"] {
  let raw: string;
  try {
    raw = readFileSync(pendingPath(), "utf8");
  } catch {
    return [];
  }
  rmSync(pendingPath(), { force: true });
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCapture>;
    if (!Array.isArray(parsed?.batches)) return [];
    return parsed.batches
      .filter((batch) => batch && typeof batch.botId === "string" && typeof batch.threadId === "string" && Array.isArray(batch.turnIds))
      .slice(-MAX_PENDING_THREADS)
      .map((batch) => ({ botId: batch.botId, threadId: batch.threadId, turnIds: batch.turnIds.filter((id): id is string => typeof id === "string").slice(-CAPTURE_MAX_TURNS) }));
  } catch {
    return [];
  }
}

function readRaw(botId: string, relative: string): string | null {
  try {
    return readMemoryText(join(workspaceDir(botId), relative));
  } catch {
    return null;
  }
}

async function askModel(engine: UpkeepEngine, prompt: string): Promise<string | null> {
  if (!engine.generateText) return null;
  const expiry = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  try {
    const answer = await Promise.race([
      engine.generateText(prompt, { signal: expiry }),
      new Promise<never>((_, reject) => expiry.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
    ]);
    return typeof answer === "string" ? answer : null;
  } catch {
    return null;
  }
}

export const NO_TEXT_ENGINE = "This bot's engine cannot make the quick background model call upkeep uses, so only expired notes and exact duplicates are tidied.";

export interface MemoryUpkeep {
  noteTurn(botId: string, threadId: string, turn: CaptureTurn): void;
  flushThread(threadId: string): void;
  dropBot(botId: string): void;
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  tidy(botId: string): Promise<TidyReport>;
  status(botId: string): { lastTidy?: TidyReport; lastCapture?: CaptureReport; modelSteps: boolean };
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  idle(): Promise<void>;
}

export function createMemoryUpkeep(deps: UpkeepDeps): MemoryUpkeep {
  const now = () => deps.now?.() ?? new Date();
  const log = (line: string) => deps.log?.(line);
  const inflight = new Set<Promise<unknown>>();
  const tidying = new Map<string, Promise<TidyReport>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  const deferred: CaptureBatch[] = [];

  const record = (botId: string, patch: { lastTidy?: TidyReport; lastCapture?: CaptureReport }) => {
    const state = loadState();
    state.bots[botId] = { ...state.bots[botId], ...patch };
    saveState(state);
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };

  const writing = deps.writing ?? (<T>(_botId: string, write: () => T): T => write());

  async function capture(batch: CaptureBatch): Promise<CaptureReport> {
    const bot = deps.bot(batch.botId);
    const at = now().getTime();
    const off: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" };
    if (!upkeepEnabled(bot)) return off;
    const allowed = () => deps.mayCapture?.(bot.id, batch.threadId) ?? true;
    const refused: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "this conversation no longer feeds the bot's memory" };
    if (!allowed()) return refused;
    const engine = deps.engine(bot.id);
    if (!engine?.generateText) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: NO_TEXT_ENGINE };
      record(bot.id, { lastCapture: report });
      return report;
    }
    ensureWorkspace(bot.id);
    const today = memoryDate(now());
    const answer = await askModel(engine, capturePrompt({
      botName: bot.name,
      turns: batch.turns,
      notebook: readRaw(bot.id, "MEMORY.md") ?? "",
      today,
      topics: memoryTopicIndex(bot.id),
    }));
    if (answer === null) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: "The capture call did not answer in time." };
      record(bot.id, { lastCapture: report });
      return report;
    }
    if (paused) {
      deferred.push(batch);
      return { at, added: 0, topics: 0, aboutMe: 0, note: "deferred until the backup finishes" };
    }
    // Re-read after the await; from here to the journal rows there is no await, so no write interleaves.
    if (!upkeepEnabled(deps.bot(bot.id))) return off;
    if (!allowed()) return refused;
    const { parsed, added, topics } = writing(bot.id, () => {
      const before = readRaw(bot.id, "MEMORY.md");
      const archiveBefore = readRaw(bot.id, ARCHIVE_PATH);
      const parsed = parseCandidates(answer, today);
      const fresh = newCandidates(parsed, before ?? "");
      const source = `${deps.sourceLabel(bot.id, batch.threadId)} (noticed)`;
      let added = 0;
      const byTopic = new Map<string, Candidate[]>();
      for (const candidate of fresh) {
        if (candidate.topic) {
          byTopic.set(candidate.topic, [...(byTopic.get(candidate.topic) ?? []), candidate]);
          continue;
        }
        if (updateMemory(bot.id, { action: "append", text: candidate.text, ...(candidate.until ? { until: candidate.until } : {}) }, { source, now: now() }).ok) added += 1;
      }
      // The archive is journaled before MEMORY.md, so undoing the newest row brings moved entries back.
      recordMemoryChange(bot.id, { path: ARCHIVE_PATH, actor: "upkeep", via: "capture", threadId: batch.threadId, before: archiveBefore, after: readRaw(bot.id, ARCHIVE_PATH) });
      if (added) recordMemoryChange(bot.id, { path: "MEMORY.md", actor: "upkeep", via: "capture", threadId: batch.threadId, before, after: readRaw(bot.id, "MEMORY.md") });
      const existing = new Map(listMemoryTopics(bot.id).map((topic) => [topic.name.toLowerCase(), topic.name]));
      let topics = 0;
      for (const [wanted, candidates] of byTopic) {
        const name = existing.get(wanted) ?? wanted;
        const path = `memory/${name}`;
        const current = readRaw(bot.id, path);
        if (current !== null && Buffer.byteLength(current, "utf8") > TOPIC_MAX_BYTES) continue;
        const seen = notebookIdentities(current ?? "");
        const lines = candidates
          .filter((candidate) => !seen.has(factIdentity(candidate.text)))
          .map((candidate) => memoryEntry(candidate.text, { source, now: now(), ...(candidate.until ? { until: candidate.until } : {}) }));
        if (!lines.length) continue;
        const title = name.replace(/\.md$/, "").replace(/-/g, " ");
        const aliases = [...new Set(candidates.flatMap((candidate) => candidate.topicAliases ?? []))];
        try {
          writeMemoryTopic(bot.id, name, mergeTopicText(current, { title, aliases, lines }));
        } catch {
          continue;
        }
        recordMemoryChange(bot.id, { path, actor: "upkeep", via: "capture", threadId: batch.threadId, before: current, after: readRaw(bot.id, path) });
        existing.set(name.toLowerCase(), name);
        topics += lines.length;
      }
      return { parsed, added, topics };
    });
    // Only the owner's own words reach About me: another person's facts are not the owner's profile.
    const owner = batch.turns.every((turn) => turn.owner !== false);
    const aboutMe = owner ? deps.addToAboutMe({ botId: bot.id, botName: bot.name }, parsed.filter((c) => c.aboutUser).map((c) => c.text)) : 0;
    const organized = await organize(bot.id);
    const report: CaptureReport = { at, added, topics, aboutMe, organized };
    record(bot.id, { lastCapture: report });
    if (added || topics || aboutMe) log(`memory upkeep: noticed ${added} fact(s) for MEMORY.md, ${topics} for topic files and ${aboutMe} for About me — ${bot.name} (${bot.id}) from ${batch.threadId}`);
    return report;
  }

  const buffer = new CaptureBuffer({
    quietMs: deps.quietMs,
    maxTurns: CAPTURE_MAX_TURNS,
    onFlush: (batch) => {
      if (paused) {
        deferred.push(batch);
        return;
      }
      void track(capture(batch)).catch((error: unknown) => log(`memory upkeep: capture failed for ${batch.botId}: ${(error as Error).message}`));
    },
  });

  async function organize(botId: string): Promise<number> {
    const engine = deps.engine(botId);
    if (!engine?.generateText) return 0;
    const today = memoryDate(now());
    const state = loadState();
    const core = new Set(state.bots[botId]?.core ?? []);
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const candidates = organizeCandidates(first, today, core);
    if (!candidates.length) return 0;
    const answer = await askModel(engine, organizePrompt(candidates, memoryTopicIndex(botId)));
    if (answer === null || paused || !upkeepEnabled(deps.bot(botId))) return 0;
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first) return 0;
    const proposed = parseMoves(answer, candidates);
    if (proposed === null) return 0;
    const moved = new Set(proposed.map((move) => move.entry.line));
    const moves = proposed.slice(0, MAX_MOVES);
    const judgedCore = candidates.filter((entry) => !moved.has(entry.line)).map((entry) => factIdentity(entry.body));
    const saved = loadState();
    saved.bots[botId] = { ...saved.bots[botId], core: [...new Set([...(saved.bots[botId]?.core ?? []), ...judgedCore])].slice(-MAX_CORE) };
    saveState(saved);
    if (!moves.length) return 0;
    return writing(botId, () => {
      const { byTopic } = applyMoves(before, moves);
      const written = new Set<string>();
      const existing = new Map(listMemoryTopics(botId).map((topic) => [topic.name.toLowerCase(), topic.name]));
      let count = 0;
      for (const [wanted, group] of byTopic) {
        const name = existing.get(wanted) ?? wanted;
        const path = `memory/${name}`;
        const current = readRaw(botId, path);
        const seen = notebookIdentities(current ?? "");
        const lines = group.lines.filter((line) => !seen.has(lineFactIdentity(line)));
        if (lines.length) {
          try {
            writeMemoryTopic(botId, name, mergeTopicText(current, { title: name.replace(/\.md$/, "").replace(/-/g, " "), aliases: group.aliases, lines }));
          } catch (error) {
            log(`memory upkeep: could not write ${path}; kept its entries in MEMORY.md: ${(error as Error).message}`);
            continue;
          }
          recordMemoryChange(botId, { path, actor: "upkeep", via: "organize", before: current, after: readRaw(botId, path) });
        }
        existing.set(name.toLowerCase(), name);
        written.add(wanted);
        count += group.lines.length;
      }
      if (!written.size) return 0;
      const { text } = applyMoves(before, moves.filter((move) => written.has(move.topic)));
      writeMemoryFile(botId, text);
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "organize", before, after: readRaw(botId, "MEMORY.md") });
      log(`memory upkeep: moved ${count} entr${count === 1 ? "y" : "ies"} from MEMORY.md into topic files for ${deps.bot(botId)?.name ?? botId}`);
      return count;
    });
  }

  function appendArchive(botId: string, archived: readonly string[]): void {
    const archiveBefore = readRaw(botId, ARCHIVE_PATH);
    appendMemoryArchive(botId, archived);
    recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via: "tidy", before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
  }

  async function runTidy(botId: string): Promise<TidyReport> {
    const bot = deps.bot(botId);
    const at = now().getTime();
    const today = memoryDate(now());
    const stopped: TidyReport = { at, expired: 0, duplicates: 0, superseded: 0, deferred: 0, contradictionsChecked: false, note: "Memory upkeep is off or paused; no further changes were made." };
    if (paused || !upkeepEnabled(bot)) return stopped;
    ensureWorkspace(botId);
    const organized = await organize(botId);
    if (paused || !upkeepEnabled(deps.bot(botId))) return stopped;
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const engine = deps.engine(botId);
    const candidates = contradictionCandidates(first, today);
    let contradictions: Contradiction[] = [];
    let contradictionsChecked = false;
    let note: string | undefined;
    if (!engine?.generateText) note = NO_TEXT_ENGINE;
    else if (candidates.length < MIN_ENTRIES_FOR_CONTRADICTIONS) note = `Contradictions are checked from ${MIN_ENTRIES_FOR_CONTRADICTIONS} notes on.`;
    else {
      const answer = await askModel(engine, contradictionPrompt(candidates));
      if (answer === null) note = "The contradiction check did not answer in time.";
      else {
        contradictions = parseContradictions(answer, candidates.length);
        contradictionsChecked = true;
      }
    }
    if (paused || !upkeepEnabled(deps.bot(botId))) return stopped;
    // Re-read after the await: if the notes changed, the model's line numbers are stale.
    const before = readRaw(botId, "MEMORY.md") ?? "";
    if (before !== first && contradictions.length) {
      contradictions = [];
      note = "The notes changed during the check; contradictions wait for the next tidy-up.";
    }
    const plan = planTidy(before, today, contradictions);
    if (planChanges(plan)) {
      const { text, archived } = applyTidy(before, plan, today);
      // The archive is written first: a line is never out of MEMORY.md before it is in the archive.
      writing(botId, () => {
        if (archived.length) appendArchive(botId, archived);
        writeMemoryFile(botId, text);
      });
      recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "tidy", before, after: readRaw(botId, "MEMORY.md") });
    }
    let topicExpired = 0;
    let topicDuplicates = 0;
    for (const topic of listMemoryTopics(botId)) {
      if (topic.name === ARCHIVE_TOPIC) continue;
      const path = `memory/${topic.name}`;
      const topicBefore = readRaw(botId, path);
      if (topicBefore === null) continue;
      const topicPlan = planTidy(topicBefore, today);
      if (!planChanges(topicPlan)) continue;
      const tidied = applyTidy(topicBefore, topicPlan, today);
      writing(botId, () => {
        if (tidied.archived.length) appendArchive(botId, tidied.archived);
        writeMemoryTopic(botId, topic.name, tidied.text);
      });
      recordMemoryChange(botId, { path, actor: "upkeep", via: "tidy", before: topicBefore, after: readRaw(botId, path) });
      topicExpired += topicPlan.expired.length;
      topicDuplicates += topicPlan.duplicates.length;
    }
    const report: TidyReport = {
      at,
      expired: plan.expired.length + topicExpired,
      duplicates: plan.duplicates.length + topicDuplicates,
      superseded: plan.superseded.length,
      deferred: plan.deferred,
      ...(organized ? { organized } : {}),
      contradictionsChecked,
      ...(note ? { note } : {}),
    };
    record(botId, { lastTidy: report });
    if (report.expired || report.duplicates || report.superseded || organized) log(`memory upkeep: tidied ${bot?.name ?? botId} — ${report.expired} expired, ${report.duplicates} duplicate(s), ${report.superseded} contradicted`);
    return report;
  }

  function tidy(botId: string): Promise<TidyReport> {
    const running = tidying.get(botId);
    if (running) return running;
    const promise = track(runTidy(botId)).finally(() => tidying.delete(botId));
    tidying.set(botId, promise);
    return promise;
  }

  function due(botId: string): boolean {
    const current = now();
    if (current.getHours() < deps.tidyHour()) return false;
    const last = loadState().bots[botId]?.lastTidy?.at;
    return !last || memoryDate(new Date(last)) < memoryDate(current);
  }

  async function tick(): Promise<void> {
    if (paused) return;
    for (const bot of deps.bots()) {
      if (paused) return;
      if (!upkeepEnabled(bot) || deps.busy(bot.id) || !due(bot.id)) continue;
      try {
        await tidy(bot.id);
      } catch (error) {
        log(`memory upkeep: tidy failed for ${bot.id}: ${(error as Error).message}`);
      }
    }
  }

  return {
    noteTurn(botId, threadId, turn) {
      if (!upkeepEnabled(deps.bot(botId))) return;
      if (!turn.person.trim() && !turn.bot.trim()) return;
      buffer.add(botId, threadId, turn);
    },
    flushThread: (threadId) => buffer.flush(threadId),
    dropBot: (botId) => buffer.dropBot(botId),
    capture: (batch) => track(capture(batch)),
    tidy,
    status(botId) {
      const { lastTidy, lastCapture } = loadState().bots[botId] ?? {};
      return { ...(lastTidy ? { lastTidy } : {}), ...(lastCapture ? { lastCapture } : {}), modelSteps: Boolean(deps.engine(botId)?.generateText) };
    },
    tick,
    start() {
      if (timer) return;
      if (deps.restoreTurn) {
        try {
          for (const saved of takePending()) {
            if (!upkeepEnabled(deps.bot(saved.botId))) continue;
            for (const turnId of saved.turnIds) {
              const turn = deps.restoreTurn(saved.botId, saved.threadId, turnId);
              if (turn && (turn.person.trim() || turn.bot.trim())) buffer.add(saved.botId, saved.threadId, { ...turn, turnId });
            }
          }
        } catch (error) {
          log(`memory upkeep: could not queue turns saved at the last shutdown: ${(error as Error).message}`);
        }
      }
      timer = setInterval(() => void tick(), TIDY_CHECK_MS);
      timer.unref?.();
      const first = setTimeout(() => void tick(), 60_000);
      first.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      const waiting = [...deferred.splice(0), ...buffer.drain()];
      if (deps.restoreTurn) savePending(waiting);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const batch of deferred.splice(0)) {
        void track(capture(batch)).catch((error: unknown) => log(`memory upkeep: capture failed for ${batch.botId}: ${(error as Error).message}`));
      }
    },
    async idle() {
      while (inflight.size) await Promise.allSettled(inflight);
    },
  };
}

export const DEFAULT_CAPTURE_QUIET_MS = 2 * 60_000;
export const DEFAULT_TIDY_HOUR = 3;

export function captureQuietMs(cfg: AppConfig): number {
  return cfg.memory?.captureQuietMs ?? DEFAULT_CAPTURE_QUIET_MS;
}

export function tidyHour(cfg: AppConfig): number {
  return cfg.memory?.tidyHour ?? DEFAULT_TIDY_HOUR;
}
