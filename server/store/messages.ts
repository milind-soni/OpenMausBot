// Message-tree persistence: the in-memory thread cache, transcript
// reads/writes and per-thread artifact cleanup. SQLite (message-db.ts) is
// the durable source of truth; legacy messages-<threadId>.json files are
// imported lazily on first read.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR } from "../config.ts";
import * as mdb from "../message-db.ts";
import { newId } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { ProfileRequestChanges } from "../../shared/profile-request.ts";
import { titleFromMessage, type Message } from "./records.ts";
import type { StoreContext, ThreadState } from "./context.ts";

export const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line) and the command beside it, a permission card's
 * summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  if (out.tool?.name) {
    out.tool = { ...out.tool, name: redactSecretsInText(out.tool.name) };
    if (out.tool.summary) out.tool.summary = redactSecretsInText(out.tool.summary);
  }
  if (out.routineRun) {
    const routineRun = { ...out.routineRun };
    routineRun.routineName = redactSecretsInText(routineRun.routineName);
    if (routineRun.summary) routineRun.summary = redactSecretsInText(routineRun.summary);
    if (routineRun.error) routineRun.error = redactSecretsInText(routineRun.error);
    out.routineRun = routineRun;
  }
  if (out.goalRun) {
    out.goalRun = {
      ...out.goalRun,
      goal: redactSecretsInText(out.goalRun.goal),
      coordinatorName: redactSecretsInText(out.goalRun.coordinatorName),
      detail: out.goalRun.detail ? redactSecretsInText(out.goalRun.detail) : undefined,
    };
  }
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    if (typeof card.answeredText === "string") card.answeredText = redactSecretsInText(card.answeredText);
    // Bot-authored question text sits behind the subtitle the same way a
    // routine's instructions do, so it is scrubbed on the same boundary.
    if (card.questionRequest) {
      card.questionRequest = {
        ...card.questionRequest,
        questions: card.questionRequest.questions.map((question) => ({
          ...question,
          question: redactSecretsInText(question.question),
          ...(question.header ? { header: redactSecretsInText(question.header) } : {}),
          options: question.options.map((option) => ({
            ...option,
            label: redactSecretsInText(option.label),
            ...(option.description ? { description: redactSecretsInText(option.description) } : {}),
          })),
        })),
      };
    }
    // Routine definitions are executable bot-authored text stored behind the
    // visible summary. Scrub the durable payload too so nesting it on a card
    // cannot bypass the transcript's secret-redaction boundary.
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    if (card.skillRequest) {
      const originalPreview = card.skillRequest.preview;
      const preview = originalPreview === undefined
        ? undefined
        : redactSecretsInText(originalPreview);
      // Current skill proposals are scrubbed before staging and their digest
      // binds the card to the exact SKILL.md bytes that apply will install.
      // Keep that binding only when this store-wide safety pass is a no-op and
      // the supplied digest already matches the persisted preview. A caller
      // that bypassed staging (or an older malformed card) is therefore
      // safely deny-only instead of showing one document and approving
      // another.
      const previewSha256 = preview !== undefined && preview === originalPreview
        ? createHash("sha256").update(preview).digest("hex")
        : undefined;
      const sha256 = card.skillRequest.sha256 !== undefined
        && card.skillRequest.sha256 === previewSha256
        ? card.skillRequest.sha256
        : undefined;
      card.skillRequest = {
        ...card.skillRequest,
        gist: redactSecretsInText(card.skillRequest.gist),
        source: card.skillRequest.source === undefined
          ? undefined
          : redactSecretsInText(card.skillRequest.source),
        preview,
        sha256,
        warnings: card.skillRequest.warnings.map((warning) => redactSecretsInText(warning)),
      };
    }
    // A profile proposal's before/after text (and its reason) is hidden
    // under the card's visible summary the same way a routine's or skill's
    // is — scrub it too so nesting it on a card cannot bypass the
    // transcript's secret-redaction boundary.
    if (card.profileRequest) {
      const scrubChanges = (changes: ProfileRequestChanges): ProfileRequestChanges => {
        const out: ProfileRequestChanges = {};
        for (const [key, value] of Object.entries(changes)) {
          out[key as keyof ProfileRequestChanges] = redactSecretsInText(value);
        }
        return out;
      };
      card.profileRequest = {
        ...card.profileRequest,
        targetName: redactSecretsInText(card.profileRequest.targetName),
        reason: redactSecretsInText(card.profileRequest.reason),
        before: scrubChanges(card.profileRequest.before),
        changes: scrubChanges(card.profileRequest.changes),
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

function thread(ctx: StoreContext, threadId: string): ThreadState {
  const t = ctx.threads.get(threadId);
  if (t) return t;
  // SQLite is the source of truth; a thread with no rows imports its
  // legacy messages-<threadId>.json once, inside readThread
  return cacheThread(ctx, threadId, mdb.readThread(threadId, messagesFile(threadId)));
}

/** Finish hydrating a full set of thread rows into the cache: chain any
 * legacy (pre-branching) rows' parentId in array order, default the
 * active leaf to the newest message, and store it. Shared by a full load
 * and by messagesTail() when its bounded read turns out to be the whole
 * thread anyway. */
function cacheThread(ctx: StoreContext, threadId: string, rows: mdb.ThreadRows): ThreadState {
  const { messages, activeLeafId: storedLeaf } = rows;
  let activeLeafId = storedLeaf;
  // legacy rows carry no parentId — chain them in array order
  let prev: string | null = null;
  for (const m of messages) {
    if (m.parentId === undefined) m.parentId = prev;
    prev = m.id;
  }
  if (!activeLeafId) activeLeafId = messages.at(-1)?.id ?? null;
  const t = { messages, activeLeafId };
  ctx.threads.set(threadId, t);
  return t;
}

export function messagesFor(ctx: StoreContext, threadId: string): Message[] {
  return thread(ctx, threadId).messages;
}

/** A bounded page of a thread's newest messages, for callers that only
 * need a display page — the startup/reconnect hydrate and a fresh
 * scrollback view. Reads just `limit` rows at the SQL boundary instead of
 * the whole transcript, unless the thread is already cached from other
 * work (then it's a plain in-memory slice, no extra SQL) or the bounded
 * read comes back as the complete thread anyway (short thread, or a
 * one-time legacy import) — that gets cached like any other full load so
 * a later messagesFor() doesn't re-read it. Legacy rows that predate
 * per-message parentId are only chained correctly on a full load, so a
 * bounded page missing that context falls back to one rather than
 * returning messages with a broken parent chain. */
export function messagesTail(ctx: StoreContext, threadId: string, limit: number): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } {
  let state = ctx.threads.get(threadId);
  if (!state) {
    const tail = mdb.readThreadTail(threadId, messagesFile(threadId), limit);
    const legacyRows = tail.hasMore !== undefined && tail.messages.some((m) => m.parentId === undefined);
    if (tail.hasMore !== true || legacyRows) {
      state = cacheThread(ctx, threadId, legacyRows ? mdb.readThread(threadId, messagesFile(threadId)) : tail);
    } else {
      return {
        messages: tail.messages,
        hasMore: tail.hasMore,
        activeLeafId: tail.activeLeafId ?? tail.messages.at(-1)?.id ?? null,
      };
    }
  }
  const { messages, activeLeafId } = state;
  const start = Math.max(0, messages.length - limit);
  return { messages: messages.slice(start), hasMore: start > 0, activeLeafId };
}

/** Used only with newly allocated import threads. No live actions are
 * replayed: the importer supplies inert text and freshly remapped IDs. */
export function importTranscript(ctx: StoreContext, threadId: string, messages: Message[], activeLeafId: string | null): void {
  if (ctx.messagesFor(threadId).length) throw new Error("Cannot import over an existing conversation");
  mdb.importThread(threadId, messages, activeLeafId);
  ctx.threads.delete(threadId);
}

export function activeLeaf(ctx: StoreContext, threadId: string): string | null {
  return thread(ctx, threadId).activeLeafId;
}

/** The visible conversation: root → activeLeafId. */
export function activePath(ctx: StoreContext, threadId: string): Message[] {
  const t = thread(ctx, threadId);
  const byId = new Map(t.messages.map((m) => [m.id, m]));
  const path: Message[] = [];
  let cur = t.activeLeafId ? byId.get(t.activeLeafId) : undefined;
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** Mark the last assistant text on the active branch as this turn's final
 * visible answer. If a provider ends after commentary without emitting a
 * separate answer, that commentary remains visible as the safe fallback. */
export function markTerminalAssistantMessage(ctx: StoreContext, threadId: string, turnId: string): Message | null {
  const path = ctx.activePath(threadId);
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const message = path[i];
    if (message.role === "bot" && message.kind === "text" && message.turnId === turnId) {
      if (message.turnTerminal) return message;
      return ctx.patchMessage(threadId, message.id, { turnTerminal: true });
    }
  }
  return null;
}

export function appendMessage(ctx: StoreContext, threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
  const t = thread(ctx, threadId);
  const full: Message = { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
  t.messages.push(full);
  t.activeLeafId = full.id;
  mdb.appendMessage(threadId, full);
  if (full.kind === "screen") {
    for (const pruned of pruneScreenFrames(t)) {
      mdb.updateMessage(threadId, pruned);
      ctx.emit({ type: "message.patch", threadId, message: pruned });
    }
  }
  ctx.emit({ type: "message", threadId, message: full });
  // The first-run quiz is not a live ask. Talking past it hides it so the
  // transcript is just the greeting plus what they said. Cards with a
  // requestId are permission/question prompts and stay until answered.
  if (full.role === "user" && full.kind === "text") ctx.dismissOnboardingCard(threadId);
  return full;
}

/** Insert a message into the active chain directly after `anchorId` — the
 * home for turn artifacts that finish AFTER the world moved on (the
 * settle-time screen capture races a fast follow-up send, which used to
 * leave the user's message stranded above the screenshot). When the anchor
 * is still the leaf this is a plain append; otherwise the anchor's
 * children are re-parented onto the inserted message, so the transcript
 * reads turn → artifact → follow-up and the leaf stays where it was. */
export function insertMessageAfter(ctx: StoreContext, threadId: string, anchorId: string | undefined, message: Omit<Message, "id" | "at">): Message {
  const t = thread(ctx, threadId);
  const anchorExists = anchorId !== undefined && t.messages.some((m) => m.id === anchorId);
  if (!anchorExists || t.activeLeafId === anchorId) return ctx.appendMessage(threadId, message);
  const full: Message = { id: newId(), at: Date.now(), ...redactBotAuthored(message), parentId: anchorId };
  const children = t.messages.filter((m) => m.parentId === anchorId);
  t.messages.push(full);
  mdb.appendMessage(threadId, full);
  if (full.kind === "screen") {
    for (const pruned of pruneScreenFrames(t)) {
      mdb.updateMessage(threadId, pruned);
      ctx.emit({ type: "message.patch", threadId, message: pruned });
    }
  }
  ctx.emit({ type: "message", threadId, message: full });
  // announced after the insert so no client ever sees two siblings
  // claiming the same parent
  for (const child of children) ctx.patchMessage(threadId, child.id, { parentId: full.id });
  return full;
}

/** Hide the first-run quiz on this thread, if it is still open. */
export function dismissOnboardingCard(ctx: StoreContext, threadId: string): Message | null {
  const t = thread(ctx, threadId);
  const card = t.messages.find(
    (message) => message.kind === "options" && message.card && !message.card.requestId && !message.card.dismissed,
  );
  if (!card?.card) return null;
  return ctx.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
}

/** Screen frames are ~100-500KB of base64 each; keeping every frame of a
 * long computer session bloats the transcript for nothing the client
 * would ever show. The newest few keep their pixels; older ones stay in the
 * transcript as placeholders. Mirrors the client's own frame cap.
 * Returns the messages whose pixels were dropped so the caller can
 * persist exactly those. */
function pruneScreenFrames(t: { messages: Message[] }, keep = 4): Message[] {
  const pruned: Message[] = [];
  let seen = 0;
  for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
    const m = t.messages[i];
    if (m.kind !== "screen" || !m.png) continue;
    seen += 1;
    if (seen > keep) {
      m.png = undefined;
      pruned.push(m);
    }
  }
  return pruned;
}

/** Fork the conversation: a new user message that replaces `sourceId`
 * (same parent, new text) and becomes the active leaf. */
export function branchMessage(ctx: StoreContext, threadId: string, sourceId: string, text: string): Message | null {
  const t = thread(ctx, threadId);
  const source = t.messages.find((m) => m.id === sourceId);
  if (!source) return null;
  const full: Message = {
    id: newId(),
    at: Date.now(),
    role: "user",
    kind: "text",
    text,
    parentId: source.parentId ?? null,
    replyToId: source.replyToId,
  };
  t.messages.push(full);
  t.activeLeafId = full.id;
  mdb.appendMessage(threadId, full);
  ctx.emit({ type: "message", threadId, message: full });
  // The message frame alone leaves every client on the OLD branch: a
  // client adopts a new message as its leaf only when it chains onto the
  // current leaf, and this one is a sibling of the edited message, not a
  // child of the reply. Say where the conversation now points, as
  // setActiveLeaf does, or the edit shows only after the next full bot
  // snapshot — in practice, once the reply has arrived.
  ctx.emit({ type: "thread", threadId, activeLeafId: full.id });
  return full;
}

/** Point the visible conversation at the branch containing `messageId`,
 * descending to that branch's most recently active leaf. */
export function setActiveLeaf(ctx: StoreContext, threadId: string, messageId: string): string | null {
  const t = thread(ctx, threadId);
  if (!t.messages.some((m) => m.id === messageId)) return null;
  let cur = messageId;
  for (;;) {
    const children = t.messages.filter((m) => m.parentId === cur);
    if (!children.length) break;
    cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
  }
  t.activeLeafId = cur;
  mdb.setActiveLeaf(threadId, cur);
  ctx.emit({ type: "thread", threadId, activeLeafId: cur });
  return cur;
}

export function patchMessage(ctx: StoreContext, threadId: string, messageId: string, patch: Partial<Message>): Message | null {
  const t = thread(ctx, threadId);
  const idx = t.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return null;
  const next = { ...t.messages[idx], ...patch, card: patch.card ?? t.messages[idx].card };
  // SQLite is the durable source of truth. Persist before changing memory so
  // a failed write cannot make this process believe a card was answered
  // while a restart would still show it as pending.
  mdb.updateMessage(threadId, next);
  t.messages[idx] = next;
  ctx.emit({ type: "message.patch", threadId, message: next });
  return next;
}

/** Toggle an emoji reaction on a message ("user" or a member botId). */
export function toggleReaction(ctx: StoreContext, threadId: string, messageId: string, emoji: string, by: string): Message | null {
  const existing = ctx.messagesFor(threadId).find((m) => m.id === messageId);
  if (!existing) return null;
  const reactions = existing.reactions ?? [];
  const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
  const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
  return ctx.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
}

/** A thread's durable record: DB rows, legacy JSON leftovers, and the
 * per-thread event logs. Every delete path funnels here — task, group,
 * and bot deletion — so the logs cannot outlive the thread anywhere. */
export function deleteThreadRecord(ctx: StoreContext, threadId: string) {
  ctx.threads.delete(threadId);
  mdb.deleteThread(threadId);
  let failure: unknown = null;
  for (const file of [
    messagesFile(threadId),
    `${messagesFile(threadId)}.imported`,
    join(EVENTS_DIR, `${threadId}.ndjson`),
    join(NATIVE_DIR, `${threadId}.ndjson`),
  ]) {
    try {
      unlinkSync(file);
    } catch (e) {
      // A missing file is already gone; any other failure (permissions,
      // I/O) can leave user data on disk, so deletion did not succeed.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") failure ??= e;
    }
  }
  if (failure) throw failure;
  ctx.emit({ type: "thread.deleted", threadId });
}

/** Thread deletions whose owning bot/task/group record is already durably
 * gone but whose transcript cleanup has not fully succeeded yet. Keyed by
 * the deleted owner's id; delete paths flush their key before anything
 * else and clear it only once every listed thread is really gone, so a
 * crash or unlink failure can never orphan transcript files. */
export type PendingThreadDeletions = Record<string, string[]>;

const PENDING_THREAD_DELETIONS_FILE = join(DATA_DIR, "pending-thread-deletions.json");

export function pendingThreadDeletions(): PendingThreadDeletions {
  try {
    return JSON.parse(readFileSync(PENDING_THREAD_DELETIONS_FILE, "utf8")) as PendingThreadDeletions;
  } catch {
    return {};
  }
}

function savePendingThreadDeletions(record: PendingThreadDeletions): void {
  writeFileAtomic(PENDING_THREAD_DELETIONS_FILE, `${JSON.stringify(record, null, 2)}\n`);
}

export function stagePendingThreadDeletions(key: string, threadIds: string[]): void {
  const record = pendingThreadDeletions();
  record[key] = [...new Set([...(record[key] ?? []), ...threadIds])];
  savePendingThreadDeletions(record);
}

export function clearPendingThreadDeletions(key: string, threadIds: string[]): void {
  const record = pendingThreadDeletions();
  if (!record[key]) return;
  const remaining = record[key]!.filter((threadId) => !threadIds.includes(threadId));
  if (remaining.length > 0) record[key] = remaining;
  else delete record[key];
  savePendingThreadDeletions(record);
}

export function flushPendingThreadDeletions(ctx: StoreContext, key: string): void {
  const threadIds = pendingThreadDeletions()[key];
  if (!threadIds?.length) return;
  for (const threadId of threadIds) {
    ctx.deleteThreadRecord(threadId);
  }
  clearPendingThreadDeletions(key, threadIds);
}

/** The first thing the human asked in a thread — a task's natural name. */
export function firstUserLine(ctx: StoreContext, threadId: string): string | null {
  const first = ctx.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
  return first?.text ? titleFromMessage(first.text) : null;
}

/** Search reads SQLite directly, so migrate every known legacy transcript
 * at startup rather than waiting until the user happens to open it. Only
 * pending JSON files are touched; already-migrated threads stay lazy. */
export function migrateLegacyTranscripts(threadIds: Iterable<string>): void {
  for (const threadId of threadIds) {
    const legacyFile = messagesFile(threadId);
    if (existsSync(legacyFile)) mdb.readThread(threadId, legacyFile);
  }
}
