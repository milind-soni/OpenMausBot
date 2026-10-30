import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, captureItemLimit, capturePrompt, captureSize, newCandidates, parseCandidates, statedInConversation, worthCapturing, type Candidate, type CaptureBatch, type CaptureTurn } from "./memory-capture.ts";
import { DREAM_FIRST_LOOKBACK_MS, DREAM_MIN_CONVERSATIONS, dreamPrompt, parseDream, type DreamConversation } from "./memory-dream.ts";
import { factIdentity, lineFactIdentity, notebookIdentities } from "./memory-entries.ts";
import { mergeTopicText } from "./memory-topics.ts";
import { isForgotten } from "./profile-learned.ts";
import { applyMoves, MAX_MOVES, organizeCandidates, organizePrompt, parseMoves } from "./memory-organize.ts";
import { recordMemoryChange } from "./memory-journal.ts";
import { applyTidy, contradictionCandidates, contradictionPrompt, parseContradictions, planChanges, planTidy, type Contradiction } from "./memory-tidy.ts";
import { appendMemoryArchive, ARCHIVE_TOPIC, ensureWorkspace, listMemoryTopics, memoryDate, memoryEntry, memoryTopicIndex, readMemoryText, updateMemory, workspaceDir, writeMemoryFile, writeMemoryTopic } from "./workspace.ts";

export { dreamConversations } from "./memory-dream.ts";

export const CAPTURE_MAX_TURNS = 6;
/** One capture call reads at most this much of one bot's waiting chats; the rest wait for the next call. */
export const CAPTURE_CALL_MAX_TURNS = 2 * CAPTURE_MAX_TURNS;
export const CAPTURE_CALL_MAX_BYTES = 24_000;
/** A chat that goes quiet takes along its bot's other chats that would go quiet within this long. */
export const CAPTURE_GATHER_MS = 15_000;
export const MODEL_TIMEOUT_MS = 60_000;
/** A dream reads up to twenty chats at once, so it gets longer than a capture call. */
export const DREAM_TIMEOUT_MS = 180_000;
export const MAX_TOPIC_CHECKS = 4;
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
  /** The person's chats with a bot since a time, for a dream; without it a bot cannot dream. */
  conversations?: (botId: string, since: number) => DreamConversation[];
  /** The one bot that dreams tonight, if any: its ideas go into the person's brief. */
  dreamer?: () => string | undefined;
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
  topicChecks?: number;
  topicsDeferred?: number;
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

export interface DreamReport {
  at: number;
  conversations: number;
  learned: { text: string; where: string }[];
  outdated: { was: string; now: string }[];
  ideas: string[];
  aboutMe: number;
  note?: string;
}

interface UpkeepState {
  bots: Record<string, {
    lastTidy?: TidyReport;
    lastCapture?: CaptureReport;
    core?: string[];
    topicCursor?: string;
    lastDream?: DreamReport;
    /** The last time a dream's model call answered: the next dream reads the chats after it. */
    dreamedTo?: number;
  }>;
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

function dropPending(botId: string): void {
  let parsed: Partial<PendingCapture>;
  try {
    parsed = JSON.parse(readFileSync(pendingPath(), "utf8")) as Partial<PendingCapture>;
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.batches)) return;
  const kept = parsed.batches.filter((batch) => batch?.botId !== botId);
  if (kept.length === parsed.batches.length) return;
  try {
    if (kept.length) writeFileAtomic(pendingPath(), `${JSON.stringify({ batches: kept })}\n`, { mode: 0o600 });
    else rmSync(pendingPath(), { force: true });
  } catch {
    // best effort: a deleted bot's saved turns are refused at capture anyway
  }
}

function readRaw(botId: string, relative: string): string | null {
  try {
    return readMemoryText(join(workspaceDir(botId), relative));
  } catch {
    return null;
  }
}

async function askModel(engine: UpkeepEngine, prompt: string, timeoutMs = MODEL_TIMEOUT_MS): Promise<string | null> {
  if (!engine.generateText) return null;
  const expiry = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("The background model call timed out.", "TimeoutError");
      expiry.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([engine.generateText(prompt, { signal: expiry.signal }), expired]);
    return typeof answer === "string" ? answer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A flushed chat waiting for its capture call; `done` answers a caller of `capture`. */
interface Waiting {
  batch: CaptureBatch;
  done?: { resolve: (report: CaptureReport) => void; reject: (error: unknown) => void };
}

function callBytes(batch: CaptureBatch): number {
  const { said, replied } = captureSize(batch.turns);
  return said + replied;
}

/** A dream's ideas are offered until the next day's dream; older ones are dropped. */
export const IDEAS_FOR_MS = 24 * 60 * 60_000;
export const NO_DREAM_ENGINE = "This bot's engine cannot make the background model call a dream uses.";
export const NO_TEXT_ENGINE = "This bot's engine cannot make the quick background model call upkeep uses, so only expired notes and exact duplicates are tidied.";

export interface MemoryUpkeep {
  noteTurn(botId: string, threadId: string, turn: CaptureTurn): void;
  flushThread(threadId: string): void;
  dropBot(botId: string): void;
  forgetBot(botId: string): void;
  capture(batch: CaptureBatch): Promise<CaptureReport>;
  tidy(botId: string): Promise<TidyReport>;
  dream(botId: string): Promise<DreamReport>;
  /** The last dream's ideas while they are fresh, with how many chats it read. */
  ideas(botId: string): { ideas: string[]; conversations: number };
  status(botId: string): { lastTidy?: TidyReport; lastCapture?: CaptureReport; lastDream?: DreamReport; modelSteps: boolean };
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
  const dreaming = new Map<string, { generation: number; promise: Promise<DreamReport> }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let paused = false;
  const cancelled = (started: number) => started !== generation || paused;
  // Flushed chats wait here, also through a backup; one worker drains it, one capture call at a time.
  const queue: Waiting[] = [];
  let worker: Promise<void> | null = null;

  const record = (botId: string, patch: { lastTidy?: TidyReport; lastCapture?: CaptureReport; topicCursor?: string; lastDream?: DreamReport; dreamedTo?: number }) => {
    // a capture or tidy that was out when its bot was deleted leaves nothing behind
    if (!deps.bot(botId)) return;
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

  /** Files items under one source label, with the step and thread (when there is one) on every journal row. */
  function fileCandidates(botId: string, candidates: readonly Candidate[], filed: { source: string; via: string; threadId?: string }): { added: number; topics: number; kept: { text: string; where: string }[] } {
    const before = readRaw(botId, "MEMORY.md");
    const archiveBefore = readRaw(botId, ARCHIVE_PATH);
    const fresh = newCandidates(candidates, before ?? "").filter((candidate) => !isForgotten(candidate.text));
    const { source, via, threadId } = filed;
    const kept: { text: string; where: string }[] = [];
    let added = 0;
    const byTopic = new Map<string, Candidate[]>();
    for (const candidate of fresh) {
      if (candidate.topic) {
        byTopic.set(candidate.topic, [...(byTopic.get(candidate.topic) ?? []), candidate]);
        continue;
      }
      if (updateMemory(botId, { action: "append", text: candidate.text, ...(candidate.until ? { until: candidate.until } : {}) }, { source, now: now() }).ok) {
        added += 1;
        kept.push({ text: candidate.text, where: "MEMORY.md" });
      }
    }
    // The archive is journaled before MEMORY.md, so undoing the newest row brings moved entries back.
    recordMemoryChange(botId, { path: ARCHIVE_PATH, actor: "upkeep", via, threadId, before: archiveBefore, after: readRaw(botId, ARCHIVE_PATH) });
    if (added) recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via, threadId, before, after: readRaw(botId, "MEMORY.md") });
    const existing = new Map(listMemoryTopics(botId).map((topic) => [topic.name.toLowerCase(), topic.name]));
    let topics = 0;
    for (const [wanted, group] of byTopic) {
      const name = existing.get(wanted) ?? wanted;
      const path = `memory/${name}`;
      const current = readRaw(botId, path);
      if (current !== null && Buffer.byteLength(current, "utf8") > TOPIC_MAX_BYTES) continue;
      const seen = notebookIdentities(current ?? "");
      const unseen = group.filter((candidate) => !seen.has(factIdentity(candidate.text)));
      const lines = unseen.map((candidate) => memoryEntry(candidate.text, { source, now: now(), ...(candidate.until ? { until: candidate.until } : {}) }));
      if (!lines.length) continue;
      const title = name.replace(/\.md$/, "").replace(/-/g, " ");
      const aliases = [...new Set(group.flatMap((candidate) => candidate.topicAliases ?? []))];
      try {
        writeMemoryTopic(botId, name, mergeTopicText(current, { title, aliases, lines }));
      } catch {
        continue;
      }
      recordMemoryChange(botId, { path, actor: "upkeep", via, threadId, before: current, after: readRaw(botId, path) });
      existing.set(name.toLowerCase(), name);
      topics += lines.length;
      kept.push(...unseen.map((candidate) => ({ text: candidate.text, where: path })));
    }
    return { added, topics, kept };
  }

  /**
   * Which conversation each item came from. With several in one call and no valid "from", the guess is the
   * one with the most said, and a guess is used only where it cannot matter: the item is kept only if every
   * conversation still feeds memory, and reaches About me only if every one is the owner's own.
   */
  function attribute(candidates: readonly Candidate[], conversations: readonly CaptureBatch[], still: readonly boolean[]) {
    const owner = conversations.map((conversation) => conversation.turns.every((turn) => turn.owner !== false));
    const sizes = conversations.map((conversation) => captureSize(conversation.turns).said);
    const guess = sizes.indexOf(Math.max(...sizes));
    return candidates.flatMap((candidate) => {
      const named = conversations.length === 1 ? 0 : candidate.from !== undefined && candidate.from <= conversations.length ? candidate.from - 1 : -1;
      const sure = named >= 0;
      const at = sure ? named : guess;
      if (!still[at] || (!sure && !still.every(Boolean))) return [];
      // Only the owner's own words reach About me: another person's facts are not the owner's profile.
      return [{ candidate, at, aboutMe: candidate.aboutUser && owner[at]! && (sure || owner.every(Boolean)) }];
    });
  }

  /** One model call for one bot's waiting chats, each read as its own conversation. */
  async function captureCall(batches: readonly CaptureBatch[]): Promise<CaptureReport> {
    const started = generation;
    // The batch names where the facts go (a bot's own memory, or one of its layers on a Team Cloud); the bot record says whose.
    const id = batches[0]!.botId;
    const bot = deps.bot(id);
    const at = now().getTime();
    const off: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" };
    if (!upkeepEnabled(bot)) return off;
    const byThread = new Map<string, CaptureBatch>();
    for (const batch of batches) {
      const same = byThread.get(batch.threadId);
      if (same) same.turns.push(...batch.turns);
      else byThread.set(batch.threadId, { ...batch, turns: [...batch.turns] });
    }
    const allowed = (threadId: string) => deps.mayCapture?.(id, threadId) ?? true;
    const refused: CaptureReport = { at, added: 0, topics: 0, aboutMe: 0, note: "this conversation no longer feeds the bot's memory" };
    const conversations = [...byThread.values()].filter((conversation) => allowed(conversation.threadId));
    if (!conversations.length) return refused;
    const engine = deps.engine(id);
    if (!engine?.generateText) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: NO_TEXT_ENGINE };
      record(id, { lastCapture: report });
      return report;
    }
    ensureWorkspace(id);
    const today = memoryDate(now());
    const answer = await askModel(engine, capturePrompt({
      botName: bot.name,
      conversations: conversations.map((conversation) => conversation.turns),
      notebook: readRaw(id, "MEMORY.md") ?? "",
      today,
      topics: memoryTopicIndex(id),
    }));
    if (started !== generation) return { ...off, note: "upkeep stopped" };
    if (answer === null) {
      const report = { at, added: 0, topics: 0, aboutMe: 0, note: "The capture call did not answer in time." };
      record(id, { lastCapture: report });
      return report;
    }
    if (paused) {
      queue.unshift(...conversations.map((batch) => ({ batch })));
      return { at, added: 0, topics: 0, aboutMe: 0, note: "deferred until the backup finishes" };
    }
    // Re-read after the await; from here to the journal rows there is no await, so no write interleaves.
    if (!upkeepEnabled(deps.bot(id))) return off;
    const still = conversations.map((conversation) => allowed(conversation.threadId));
    if (!still.some(Boolean)) return refused;
    const filed = attribute(parseCandidates(answer, today, captureItemLimit(conversations.length)), conversations, still).flatMap((item) => {
      const turns = conversations[item.at]!.turns;
      if (isForgotten(item.candidate.text) || !statedInConversation(item.candidate, turns, false)) return [];
      return [{ ...item, aboutMe: item.aboutMe && statedInConversation(item.candidate, turns, true) }];
    });
    const { added, topics } = writing(id, () => {
      let added = 0;
      let topics = 0;
      conversations.forEach((conversation, i) => {
        const own = filed.filter((item) => item.at === i).map((item) => item.candidate);
        if (!own.length) return;
        const result = fileCandidates(id, own, { source: `${deps.sourceLabel(id, conversation.threadId)} (noticed)`, via: "capture", threadId: conversation.threadId });
        added += result.added;
        topics += result.topics;
      });
      return { added, topics };
    });
    const learned = filed.filter((item) => item.aboutMe).map((item) => item.candidate.text);
    const aboutMe = learned.length ? deps.addToAboutMe({ botId: id, botName: bot.name }, learned) : 0;
    const organized = await organize(id);
    const report: CaptureReport = { at, added, topics, aboutMe, organized };
    if (cancelled(started)) return report;
    record(id, { lastCapture: report });
    if (added || topics || aboutMe) log(`memory upkeep: noticed ${added} fact(s) for MEMORY.md, ${topics} for topic files and ${aboutMe} for About me — ${bot.name} (${id}) from ${conversations.map((conversation) => conversation.threadId).join(", ")}`);
    return report;
  }

  /** The first waiting batch, with its bot's other waiting batches that fit in the same call. */
  function takeCall(): Waiting[] {
    const first = queue.shift()!;
    const call = [first];
    let turns = first.batch.turns.length;
    let bytes = callBytes(first.batch);
    for (let i = 0; i < queue.length;) {
      const next = queue[i]!;
      const size = callBytes(next.batch);
      if (next.batch.botId === first.batch.botId && turns + next.batch.turns.length <= CAPTURE_CALL_MAX_TURNS && bytes + size <= CAPTURE_CALL_MAX_BYTES) {
        call.push(...queue.splice(i, 1));
        turns += next.batch.turns.length;
        bytes += size;
      } else i += 1;
    }
    return call;
  }

  async function work(): Promise<void> {
    const started = generation;
    try {
      // chats flushed together are all queued before the first call takes its share
      await Promise.resolve();
      while (!cancelled(started) && queue.length) {
        const call = takeCall();
        try {
          const report = await captureCall(call.map((entry) => entry.batch));
          for (const entry of call) entry.done?.resolve(report);
        } catch (error) {
          log(`memory upkeep: capture failed for ${call[0]!.batch.botId}: ${(error as Error).message}`);
          for (const entry of call) entry.done?.reject(error);
        }
      }
    } finally {
      worker = null;
      kick();
    }
  }

  function kick(): void {
    if (!worker && !paused && queue.length) worker = track(work());
  }

  function enqueue(entry: Waiting): void {
    queue.push(entry);
    kick();
  }

  function dropQueued(botId: string): void {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.batch.botId !== botId) continue;
      const [entry] = queue.splice(i, 1);
      entry!.done?.resolve({ at: now().getTime(), added: 0, topics: 0, aboutMe: 0, note: "upkeep is off" });
    }
  }

  const buffer = new CaptureBuffer({
    quietMs: deps.quietMs,
    maxTurns: CAPTURE_MAX_TURNS,
    gatherMs: CAPTURE_GATHER_MS,
    onFlush: (batch) => {
      // a test or a pleasantry has nothing to keep, so it costs no call
      if (worthCapturing(batch.turns)) enqueue({ batch });
    },
  });

  async function organize(botId: string): Promise<number> {
    const started = generation;
    const engine = deps.engine(botId);
    if (!engine?.generateText) return 0;
    const today = memoryDate(now());
    const state = loadState();
    const core = new Set(state.bots[botId]?.core ?? []);
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const candidates = organizeCandidates(first, today, core);
    if (!candidates.length) return 0;
    const answer = await askModel(engine, organizePrompt(candidates, memoryTopicIndex(botId)));
    if (answer === null || cancelled(started) || !upkeepEnabled(deps.bot(botId))) return 0;
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
    const started = generation;
    const bot = deps.bot(botId);
    const at = now().getTime();
    const today = memoryDate(now());
    const stopped: TidyReport = { at, expired: 0, duplicates: 0, superseded: 0, deferred: 0, contradictionsChecked: false, note: "Memory upkeep is off or paused; no further changes were made." };
    if (cancelled(started) || !upkeepEnabled(bot)) return stopped;
    ensureWorkspace(botId);
    const organized = await organize(botId);
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
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
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
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
    let topicSuperseded = 0;
    let topicDeferred = 0;
    let topicChecks = 0;
    let topicsDeferred = 0;
    let topicCursor = loadState().bots[botId]?.topicCursor;
    const deadline = Date.now() + MODEL_TIMEOUT_MS;
    const topics = listMemoryTopics(botId).filter(topic => topic.name !== ARCHIVE_TOPIC).sort((a, b) => a.name.localeCompare(b.name));
    const cursorAt = topics.findIndex(topic => topic.name === topicCursor) + 1;
    for (const topic of [...topics.slice(cursorAt), ...topics.slice(0, cursorAt)]) {
      const path = `memory/${topic.name}`;
      const topicBefore = readRaw(botId, path);
      if (topicBefore === null) continue;
      const topicCandidates = contradictionCandidates(topicBefore, today);
      let topicContradictions: Contradiction[] = [];
      if (engine?.generateText && topicCandidates.length >= 2) {
        const remaining = deadline - Date.now();
        if (topicChecks >= MAX_TOPIC_CHECKS || remaining <= 0) topicsDeferred++;
        else {
          topicChecks++;
          topicCursor = topic.name;
          const answer = await askModel(engine, contradictionPrompt(topicCandidates), remaining);
          if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return stopped;
          if (readRaw(botId, path) !== topicBefore) {
            topicsDeferred++;
            continue;
          }
          if (answer !== null) {
            topicContradictions = parseContradictions(answer, topicCandidates.length);
            contradictionsChecked = true;
            if (note?.startsWith("Contradictions are checked from")) note = undefined;
          } else topicsDeferred++;
        }
      }
      const topicPlan = planTidy(topicBefore, today, topicContradictions, 1);
      topicSuperseded += topicPlan.superseded.length;
      topicDeferred += topicPlan.deferred;
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
    if (topicsDeferred) note = [note, `${topicsDeferred} topic checks deferred because of the budget, a timeout or concurrent edits.`].filter(Boolean).join(" ");
    const report: TidyReport = {
      at,
      expired: plan.expired.length + topicExpired,
      duplicates: plan.duplicates.length + topicDuplicates,
      superseded: plan.superseded.length + topicSuperseded,
      deferred: plan.deferred + topicDeferred,
      ...(organized ? { organized } : {}),
      contradictionsChecked,
      topicChecks,
      topicsDeferred,
      ...(note ? { note } : {}),
    };
    record(botId, { lastTidy: report, topicCursor });
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

  /** Reads the chats since the last dream that answered; the first one looks back a week. */
  function dreamSince(botId: string, at: number): number {
    return loadState().bots[botId]?.dreamedTo ?? at - DREAM_FIRST_LOOKBACK_MS;
  }

  async function runDream(botId: string): Promise<DreamReport> {
    const started = generation;
    const bot = deps.bot(botId);
    const at = now().getTime();
    const report = (note: string, conversations = 0): DreamReport => ({ at, conversations, learned: [], outdated: [], ideas: [], aboutMe: 0, note });
    if (cancelled(started) || !upkeepEnabled(bot)) return report("Memory upkeep is off or paused, so nothing was read.");
    if (!deps.conversations) return report("Dreaming is not available here.");
    const engine = deps.engine(botId);
    if (!engine?.generateText) {
      const off = report(NO_DREAM_ENGINE);
      record(botId, { lastDream: off });
      return off;
    }
    const conversations = deps.conversations(botId, dreamSince(botId, at));
    if (conversations.length < DREAM_MIN_CONVERSATIONS) {
      const few = report(`A dream needs at least ${DREAM_MIN_CONVERSATIONS} chats where you wrote since the last one; there ${conversations.length === 1 ? "is 1" : `are ${conversations.length}`}.`, conversations.length);
      record(botId, { lastDream: few });
      return few;
    }
    ensureWorkspace(botId);
    const today = memoryDate(now());
    const first = readRaw(botId, "MEMORY.md") ?? "";
    const notebook = contradictionCandidates(first, today);
    const answer = await askModel(engine, dreamPrompt({ botName: bot.name, today, conversations, notebook, topics: memoryTopicIndex(botId) }), DREAM_TIMEOUT_MS);
    if (cancelled(started) || !upkeepEnabled(deps.bot(botId))) return report("Memory upkeep was stopped, switched off or paused during the dream; no changes were made.", conversations.length);
    if (answer === null) {
      const late = report("The dream did not answer in time.", conversations.length);
      record(botId, { lastDream: late });
      return late;
    }
    const dreamt = parseDream(answer, conversations.length, notebook.length);
    const source = `dream across ${conversations.length} chats`;
    // Re-read inside the write: if the notes changed after the prompt, its line numbers are stale.
    const written = writing(botId, () => {
      const before = readRaw(botId, "MEMORY.md") ?? "";
      const outdated: DreamReport["outdated"] = [];
      const stale = dreamt.outdated.length > 0 && before !== first;
      if (!stale) {
        for (const item of dreamt.outdated) {
          const entry = notebook[item.line]!;
          if (updateMemory(botId, { action: "supersede", oldText: entry.body, text: item.now }, { source, now: now() }).ok) outdated.push({ was: entry.body, now: item.now });
        }
        if (outdated.length) recordMemoryChange(botId, { path: "MEMORY.md", actor: "upkeep", via: "dream", before, after: readRaw(botId, "MEMORY.md") });
      }
      const candidates: Candidate[] = dreamt.learned.map((item) => ({
        text: item.text,
        kind: "preference",
        aboutUser: item.aboutUser,
        ...(item.topic ? { topic: item.topic } : {}),
        ...(item.topicAliases ? { topicAliases: item.topicAliases } : {}),
      }));
      const { kept } = candidates.length ? fileCandidates(botId, candidates, { source, via: "dream" }) : { kept: [] };
      return { outdated, kept, stale };
    });
    const aboutUser = dreamt.learned.filter((item) => item.aboutUser).map((item) => item.text);
    const aboutMe = aboutUser.length ? deps.addToAboutMe({ botId, botName: bot.name }, aboutUser) : 0;
    const done: DreamReport = {
      at,
      conversations: conversations.length,
      learned: written.kept,
      outdated: written.outdated,
      ideas: dreamt.ideas.map((idea) => idea.text),
      aboutMe,
      ...(written.stale ? { note: "The notes changed during the dream, so outdated notes wait for the next one." } : {}),
    };
    record(botId, { lastDream: done, dreamedTo: at });
    log(`memory upkeep: ${bot.name} (${botId}) dreamt over ${conversations.length} chats — ${done.learned.length} learned, ${done.outdated.length} updated, ${done.ideas.length} idea(s), ${aboutMe} for About me`);
    return done;
  }

  function dream(botId: string): Promise<DreamReport> {
    const started = generation;
    const running = dreaming.get(botId);
    if (running?.generation === started) return running.promise;
    const promise = track(runDream(botId)).finally(() => {
      if (dreaming.get(botId)?.promise === promise) dreaming.delete(botId);
    });
    dreaming.set(botId, { generation: started, promise });
    return promise;
  }

  function dreamDue(botId: string): boolean {
    const current = now();
    const saved = loadState().bots[botId];
    if (deps.dreamer?.() !== botId || !deps.conversations || current.getHours() < deps.tidyHour()) return false;
    if (saved?.lastDream && memoryDate(new Date(saved.lastDream.at)) >= memoryDate(current)) return false;
    return deps.conversations(botId, dreamSince(botId, current.getTime())).length >= DREAM_MIN_CONVERSATIONS;
  }

  function due(botId: string): boolean {
    const current = now();
    if (current.getHours() < deps.tidyHour()) return false;
    const last = loadState().bots[botId]?.lastTidy?.at;
    return !last || memoryDate(new Date(last)) < memoryDate(current);
  }

  async function tick(): Promise<void> {
    const started = generation;
    if (cancelled(started)) return;
    for (const bot of deps.bots()) {
      if (cancelled(started)) return;
      if (!upkeepEnabled(bot) || deps.busy(bot.id)) continue;
      if (due(bot.id)) {
        try {
          await tidy(bot.id);
        } catch (error) {
          log(`memory upkeep: tidy failed for ${bot.id}: ${(error as Error).message}`);
        }
      }
      if (cancelled(started)) return;
      try {
        if (deps.busy(bot.id) || !dreamDue(bot.id)) continue;
        await dream(bot.id);
      } catch (error) {
        log(`memory upkeep: dream failed for ${bot.id}: ${(error as Error).message}`);
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
    dropBot(botId) {
      buffer.dropBot(botId);
      dropQueued(botId);
    },
    forgetBot(botId) {
      buffer.dropBot(botId);
      dropQueued(botId);
      dropPending(botId);
      const state = loadState();
      if (!state.bots[botId]) return;
      delete state.bots[botId];
      saveState(state);
    },
    capture: (batch) => new Promise<CaptureReport>((resolve, reject) => enqueue({ batch, done: { resolve, reject } })),
    tidy,
    dream,
    ideas(botId) {
      const last = loadState().bots[botId]?.lastDream;
      return last && now().getTime() - last.at < IDEAS_FOR_MS ? { ideas: last.ideas, conversations: last.conversations } : { ideas: [], conversations: 0 };
    },
    status(botId) {
      const { lastTidy, lastCapture, lastDream } = loadState().bots[botId] ?? {};
      return { ...(lastTidy ? { lastTidy } : {}), ...(lastCapture ? { lastCapture } : {}), ...(lastDream ? { lastDream } : {}), modelSteps: Boolean(deps.engine(botId)?.generateText) };
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
      const started = ++generation;
      const scheduledTick = () => { if (started === generation) void tick(); };
      timer = setInterval(scheduledTick, TIDY_CHECK_MS);
      timer.unref?.();
      first = setTimeout(scheduledTick, 60_000);
      first.unref?.();
    },
    stop() {
      generation++;
      if (timer) clearInterval(timer);
      timer = null;
      if (first) clearTimeout(first);
      first = null;
      const queued = queue.splice(0);
      for (const entry of queued) entry.done?.resolve({ at: now().getTime(), added: 0, topics: 0, aboutMe: 0, note: "kept for the next start" });
      const waiting = [...queued.map((entry) => entry.batch), ...buffer.drain()];
      if (deps.restoreTurn) savePending(waiting);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      kick();
    },
    async idle() {
      while (inflight.size) await Promise.allSettled(inflight);
    },
  };
}
