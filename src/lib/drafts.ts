import { useCallback, useEffect, useState, useSyncExternalStore, type SetStateAction } from "react";
import { isAttachment, type Attachment } from "./composer-attachments.js";

const KEY = "omb-drafts";
const ATTACHMENTS_KEY = "omb-draft-attachments";
const SEND_IDS_KEY = "omb-draft-send-ids";
const CHANNEL_MODES_KEY = "omb-draft-channel-modes";
// Outside React, so a late failure from an unmounted composer cannot overwrite a newer draft.
const draftRevisions = new Map<string, number>();
const replyDrafts = new Map<string, string>();
type ChannelMode = "chat" | "goal";
type DraftRestore = { text: string; attachments: Attachment[]; channelMode?: ChannelMode };
type DraftRestoreListener = (draft: DraftRestore) => void;
const restoreListeners = new Map<string, Set<DraftRestoreListener>>();
const channelModeListeners = new Map<string, Set<() => void>>();
const attachmentPendingCounts = new Map<string, number>();
const attachmentPendingListeners = new Map<string, Set<() => void>>();
export interface FailedComposerSend {
  id: string;
  sendId: string;
  text: string;
  requestText: string;
  replyToId?: string;
  threadId: string;
  channelMode?: "chat" | "goal";
}
type FailedComposerSendInput = Omit<FailedComposerSend, "id">;
export interface ComposerSendSnapshot extends FailedComposerSendInput {
  draftId: string;
  revision: number;
  attachments: Attachment[];
}
const failedSends = new Map<string, FailedComposerSend[]>();
const failedSendListeners = new Map<string, Set<(sends: FailedComposerSend[]) => void>>();
type RestoredSend = { sendId: string; requestText?: string };
const restoredSends = new Map<string, RestoredSend>();
let failedSendSequence = 0;

type Values = Record<string, unknown>;
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

// localStorage can be unavailable or reject writes (private browsing, a full quota); memory answers every read.
const fallbackTextDrafts = new Map<string, string>();
const fallbackAttachmentDrafts = new Map<string, Attachment[]>();
const textDraftsByStore = new WeakMap<object, Map<string, string>>();
const attachmentDraftsByStore = new WeakMap<object, Map<string, Attachment[]>>();
const fallbackChannelModes = new Map<string, ChannelMode>();
const channelModesByStore = new WeakMap<object, Map<string, ChannelMode>>();

function memoryFor<T>(
  store: Store,
  stored: WeakMap<object, Map<string, T>>,
  fallback: Map<string, T>,
): Map<string, T> {
  if (!store) return fallback;
  const key = store as object;
  const existing = stored.get(key);
  if (existing) return existing;
  const created = new Map<string, T>();
  stored.set(key, created);
  return created;
}

function read(store: Store, key: string): Values {
  try {
    const raw = store?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Values) : {};
  } catch {
    return {};
  }
}

export function getDraft(store: Store, id: string): string {
  const memory = memoryFor(store, textDraftsByStore, fallbackTextDrafts);
  if (memory.has(id)) return memory.get(id)!;
  const text = read(store, KEY)[id];
  const value = typeof text === "string" ? text : "";
  memory.set(id, value);
  return value;
}

export function setDraft(store: Store, id: string, text: string): void {
  memoryFor(store, textDraftsByStore, fallbackTextDrafts).set(id, text);
  if (store) saveDraftLater(store, id);
}

const SAVE_DELAY_MS = 500;
const unsavedDrafts = new Map<NonNullable<Store>, Set<string>>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const page = (globalThis as { window?: Partial<EventTarget> }).window;
page?.addEventListener?.("blur", saveDrafts);
page?.addEventListener?.("pagehide", saveDrafts);

function saveDraftLater(store: NonNullable<Store>, id: string): void {
  const ids = unsavedDrafts.get(store) ?? new Set<string>();
  ids.add(id);
  unsavedDrafts.set(store, ids);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDrafts, SAVE_DELAY_MS);
}

function saveDrafts(): void {
  clearTimeout(saveTimer);
  for (const [store, ids] of unsavedDrafts) {
    const memory = memoryFor(store, textDraftsByStore, fallbackTextDrafts);
    const drafts = read(store, KEY);
    for (const id of ids) {
      const text = memory.get(id);
      if (text) drafts[id] = text;
      else delete drafts[id];
    }
    try {
      store.setItem(KEY, JSON.stringify(drafts));
      unsavedDrafts.delete(store);
    } catch {
    }
  }
}

export function getDraftChannelMode(store: Store, id: string): ChannelMode {
  const memory = memoryFor(store, channelModesByStore, fallbackChannelModes);
  if (memory.has(id)) return memory.get(id)!;
  const mode = read(store, CHANNEL_MODES_KEY)[id] === "goal" ? "goal" : "chat";
  memory.set(id, mode);
  return mode;
}

export function setDraftChannelMode(store: Store, id: string, mode: ChannelMode): void {
  memoryFor(store, channelModesByStore, fallbackChannelModes).set(id, mode);
  const modes = read(store, CHANNEL_MODES_KEY);
  if (mode === "goal") modes[id] = mode;
  else delete modes[id];
  try {
    store?.setItem(CHANNEL_MODES_KEY, JSON.stringify(modes));
  } catch {
  }
}

export function getDraftAttachments(store: Store, id: string): Attachment[] {
  const memory = memoryFor(store, attachmentDraftsByStore, fallbackAttachmentDrafts);
  if (memory.has(id)) return [...memory.get(id)!];
  const attachments = read(store, ATTACHMENTS_KEY)[id];
  const value = Array.isArray(attachments) ? attachments.filter(isAttachment) : [];
  memory.set(id, value);
  return [...value];
}

export function setDraftAttachments(store: Store, id: string, attachments: Attachment[]): void {
  memoryFor(store, attachmentDraftsByStore, fallbackAttachmentDrafts).set(id, [...attachments]);
  const drafts = read(store, ATTACHMENTS_KEY);
  // Blob URLs exist only for this document: persist only upload-complete attachments.
  const durable = attachments.flatMap((attachment): Attachment[] => {
    if (attachment.kind !== "image") return [attachment];
    if (!attachment.path || attachment.uploading) return [];
    return [{
      kind: "image",
      id: attachment.id,
      path: attachment.path,
      name: attachment.name,
      size: attachment.size,
      mime: attachment.mime,
    }];
  });
  if (durable.length) drafts[id] = durable;
  else delete drafts[id];
  try {
    store?.setItem(ATTACHMENTS_KEY, JSON.stringify(drafts));
  } catch {
  }
}

export function rememberReplyDraft(threadId: string, messageId: string): void {
  replyDrafts.set(threadId, messageId);
}

export function replyDraft(threadId: string): string | undefined {
  return replyDrafts.get(threadId);
}

export function clearReplyDraft(threadId: string): void {
  replyDrafts.delete(threadId);
}

export function selectReplyDraft(draftId: string, threadId: string, messageId: string): void {
  markDraftEdited(draftId);
  rememberReplyDraft(threadId, messageId);
}

export function discardReplyDraft(draftId: string, threadId: string): void {
  markDraftEdited(draftId);
  clearReplyDraft(threadId);
}

function resolveReplyMessage<T extends { id: string }>(threadId: string, messages: T[]): T | null {
  const replyId = replyDraft(threadId);
  return replyId ? (messages.find((message) => message.id === replyId) ?? null) : null;
}

export function useReplyDraft<T extends { id: string }>(
  threadId: string,
  draftId: string,
  messages: T[],
) {
  const [replyState, setReplyState] = useState<{ threadId: string; message: T | null }>(() => ({
    threadId,
    message: resolveReplyMessage(threadId, messages),
  }));
  const replyTo =
    replyState.threadId === threadId
      ? replyState.message
      : resolveReplyMessage(threadId, messages);

  useEffect(() => {
    setReplyState((current) => {
      if (current.threadId === threadId && current.message) return current;
      return { threadId, message: resolveReplyMessage(threadId, messages) };
    });
  }, [messages, threadId]);

  const selectReply = useCallback((message: T) => {
    selectReplyDraft(draftId, threadId, message.id);
    setReplyState({ threadId, message });
  }, [draftId, threadId]);

  const clearReply = useCallback(() => {
    discardReplyDraft(draftId, threadId);
    setReplyState({ threadId, message: null });
  }, [draftId, threadId]);

  const consumeReply = useCallback(() => {
    clearReplyDraft(threadId);
    setReplyState({ threadId, message: null });
  }, [threadId]);

  const restoreReply = useCallback((message: T, targetThreadId: string) => {
    const currentId = replyDraft(targetThreadId);
    if (currentId && currentId !== message.id) return;
    // Persist before touching React state: this view may have unmounted mid-request.
    rememberReplyDraft(targetThreadId, message.id);
    if (threadId === targetThreadId) {
      setReplyState((current) =>
        current.threadId === targetThreadId && current.message
          ? current
          : { threadId: targetThreadId, message },
      );
    }
  }, [threadId]);

  return { replyTo, selectReply, clearReply, consumeReply, restoreReply };
}

export function draftRevision(draftId: string): number {
  return draftRevisions.get(draftId) ?? 0;
}

export function markDraftEdited(draftId: string): void {
  restoredSends.delete(draftId);
  setStoredSendId(getStore(), draftId, undefined);
  draftRevisions.set(draftId, draftRevision(draftId) + 1);
}

export function restoredSendId(draftId: string): string | undefined {
  return restoredSend(draftId)?.sendId;
}

export function restoredRequestText(draftId: string): string | undefined {
  return restoredSend(draftId)?.requestText;
}

function restoredSend(draftId: string): RestoredSend | undefined {
  const memory = restoredSends.get(draftId);
  if (memory) return memory;
  const stored = read(getStore(), SEND_IDS_KEY)[draftId];
  if (!stored || (typeof stored !== "string" && typeof stored !== "object")) return undefined;
  const value = typeof stored === "string" ? { sendId: stored } : stored as Record<string, unknown>;
  if (typeof value.sendId !== "string" || (value.requestText !== undefined && typeof value.requestText !== "string")) return undefined;
  const send = { sendId: value.sendId, requestText: value.requestText };
  restoredSends.set(draftId, send);
  return send;
}

function setStoredSendId(store: Store, draftId: string, send: RestoredSend | undefined): void {
  const ids = read(store, SEND_IDS_KEY);
  if (send) ids[draftId] = send;
  else delete ids[draftId];
  try {
    store?.setItem(SEND_IDS_KEY, JSON.stringify(ids));
  } catch {
  }
}

export function restoreComposerDraft(id: string, draft: DraftRestore): void {
  const store = getStore();
  setDraft(store, id, draft.text);
  setDraftAttachments(store, id, draft.attachments);
  setDraftChannelMode(store, id, draft.channelMode ?? "chat");
  for (const listener of restoreListeners.get(id) ?? []) listener(draft);
}

export function appendComposerDraft(id: string, text: string): void {
  const store = getStore();
  const current = getDraft(store, id);
  markDraftEdited(id);
  restoreComposerDraft(id, {
    text: current ? `${current}\n\n${text}` : text,
    attachments: getDraftAttachments(store, id),
    channelMode: getDraftChannelMode(store, id),
  });
}

export function prependComposerDraft(id: string, text: string): void {
  const store = getStore();
  const current = getDraft(store, id);
  markDraftEdited(id);
  restoreComposerDraft(id, {
    text: current.trim() ? `${text}\n\n${current}` : text,
    attachments: getDraftAttachments(store, id),
    channelMode: getDraftChannelMode(store, id),
  });
}

/** Leads the draft with `text` once: asking again does not stack it. */
export function leadComposerDraft(id: string, text: string): void {
  if (!getDraft(getStore(), id).startsWith(text)) prependComposerDraft(id, text);
}

export function appendDraftAttachments(id: string, additions: Attachment[]): void {
  if (additions.length === 0) return;
  markDraftEdited(id);
  const store = getStore();
  const draft = {
    text: getDraft(store, id),
    attachments: [...getDraftAttachments(store, id), ...additions],
  };
  setDraftAttachments(store, id, draft.attachments);
  for (const listener of restoreListeners.get(id) ?? []) listener(draft);
}

export function replaceDraftAttachment(
  id: string,
  attachmentId: string,
  replacement: Attachment | null,
): boolean {
  const store = getStore();
  const current = getDraftAttachments(store, id);
  const index = current.findIndex((attachment) => attachment.id === attachmentId);
  if (index === -1) return false;
  const attachments = replacement
    ? current.map((attachment, at) => (at === index ? replacement : attachment))
    : current.filter((_, at) => at !== index);
  const draft = { text: getDraft(store, id), attachments };
  setDraftAttachments(store, id, attachments);
  for (const listener of restoreListeners.get(id) ?? []) listener(draft);
  return true;
}

export function changeDraftAttachmentPending(id: string, pending: boolean): void {
  const previous = attachmentPendingCounts.get(id) ?? 0;
  const next = pending ? previous + 1 : Math.max(0, previous - 1);
  if (next === previous) return;
  if (next > 0) attachmentPendingCounts.set(id, next);
  else attachmentPendingCounts.delete(id);
  for (const listener of attachmentPendingListeners.get(id) ?? []) listener();
}

function subscribeToAttachmentPending(id: string, listener: () => void): () => void {
  const listeners = attachmentPendingListeners.get(id) ?? new Set<() => void>();
  listeners.add(listener);
  attachmentPendingListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) attachmentPendingListeners.delete(id);
  };
}

export function isDraftAttachmentPending(id: string): boolean {
  return (attachmentPendingCounts.get(id) ?? 0) > 0;
}

export function useDraftAttachmentPending(id: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToAttachmentPending(id, listener),
    [id],
  );
  const snapshot = useCallback(() => isDraftAttachmentPending(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

function subscribeToDraftRestores(id: string, listener: DraftRestoreListener): () => void {
  const listeners = restoreListeners.get(id) ?? new Set<DraftRestoreListener>();
  listeners.add(listener);
  restoreListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) restoreListeners.delete(id);
  };
}

function publishFailedSends(id: string): void {
  const sends = failedSends.get(id) ?? [];
  for (const listener of failedSendListeners.get(id) ?? []) listener(sends);
}

export function failedComposerSends(id: string): FailedComposerSend[] {
  return failedSends.get(id) ?? [];
}

export function rememberFailedComposerSend(
  id: string,
  input: FailedComposerSendInput,
): FailedComposerSend {
  const failed = { ...input, id: `${Date.now().toString(36)}-${++failedSendSequence}` };
  failedSends.set(id, [...failedComposerSends(id), failed]);
  publishFailedSends(id);
  return failed;
}

export function recoverFailedComposerSend(sent: ComposerSendSnapshot): "restored" | "outbox" {
  if (draftRevision(sent.draftId) !== sent.revision) {
    rememberFailedComposerSend(sent.draftId, {
      sendId: sent.sendId,
      text: sent.text,
      requestText: sent.requestText,
      replyToId: sent.replyToId,
      threadId: sent.threadId,
      channelMode: sent.channelMode,
    });
    return "outbox";
  }
  markDraftEdited(sent.draftId);
  restoreComposerDraft(sent.draftId, {
    text: sent.text,
    attachments: sent.attachments,
    channelMode: sent.channelMode,
  });
  // The response may have vanished after the server accepted it: the next Send reuses this identity.
  const retry = { sendId: sent.sendId, requestText: sent.requestText };
  restoredSends.set(sent.draftId, retry);
  setStoredSendId(getStore(), sent.draftId, retry);
  return "restored";
}

export function forgetFailedComposerSend(id: string, failedId: string): void {
  const remaining = failedComposerSends(id).filter((failed) => failed.id !== failedId);
  if (remaining.length > 0) failedSends.set(id, remaining);
  else failedSends.delete(id);
  publishFailedSends(id);
}

export function useFailedComposerSends(id: string): FailedComposerSend[] {
  const [sends, setSends] = useState(() => failedComposerSends(id));
  useEffect(() => {
    setSends(failedComposerSends(id));
    const listeners = failedSendListeners.get(id) ?? new Set<(next: FailedComposerSend[]) => void>();
    listeners.add(setSends);
    failedSendListeners.set(id, listeners);
    return () => {
      listeners.delete(setSends);
      if (listeners.size === 0) failedSendListeners.delete(id);
    };
  }, [id]);
  return sends;
}

// With storage blocked the localStorage getter itself throws, and `typeof` doesn't shield it.
function getStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** A draft's channel mode, the same in every place that shows it: the composer's chip and the bot panel's switch. */
export function useComposerChannelMode(id: string): [ChannelMode, (next: SetStateAction<ChannelMode>) => void] {
  const store = getStore();
  const [mode, setMode] = useState(() => getDraftChannelMode(store, id));
  useEffect(() => {
    const sync = () => setMode(getDraftChannelMode(store, id));
    const unsubscribe = subscribeToDraftRestores(id, sync);
    const listeners = channelModeListeners.get(id) ?? new Set<() => void>();
    listeners.add(sync);
    channelModeListeners.set(id, listeners);
    sync();
    return () => {
      unsubscribe();
      listeners.delete(sync);
      if (listeners.size === 0 && channelModeListeners.get(id) === listeners) channelModeListeners.delete(id);
    };
  }, [id, store]);
  const set = useCallback((next: SetStateAction<ChannelMode>) => {
    const value = typeof next === "function" ? next(getDraftChannelMode(store, id)) : next;
    setDraftChannelMode(store, id, value);
    setMode(value);
    for (const listener of Array.from(channelModeListeners.get(id) ?? [])) listener();
  }, [id, store]);
  return [mode, set];
}

export function useDraft(id: string, legacyId?: string): [string, (next: string) => void] {
  const store = getStore();
  const [text, setText] = useState(() => {
    const current = getDraft(store, id);
    if (current || !legacyId) return current;
    const legacy = getDraft(store, legacyId);
    if (!legacy) return "";
    setDraft(store, id, legacy);
    setDraft(store, legacyId, "");
    return legacy;
  });
  const set = useCallback(
    (next: string) => {
      setText(next);
      setDraft(store, id, next);
    },
    [store, id],
  );
  useEffect(() => {
    const unsubscribe = subscribeToDraftRestores(id, (draft) => setText(draft.text));
    // A rejected request may have restored storage between this mount's init and its listener attaching.
    setText(getDraft(store, id));
    return () => {
      unsubscribe();
      saveDrafts();
    };
  }, [id, store]);
  return [text, set];
}

export function useComposerDraft(
  id: string,
  legacyId?: string,
): [
  string,
  (next: string) => void,
  Attachment[],
  (next: SetStateAction<Attachment[]>) => void,
] {
  const store = getStore();
  const [text, setText] = useDraft(id, legacyId);
  const [attachments, setAttachmentState] = useState(() => {
    const current = getDraftAttachments(store, id);
    if (current.length > 0 || !legacyId) return current;
    const legacy = getDraftAttachments(store, legacyId);
    if (legacy.length === 0) return [];
    setDraftAttachments(store, id, legacy);
    setDraftAttachments(store, legacyId, []);
    return legacy;
  });
  useEffect(() => {
    const unsubscribe = subscribeToDraftRestores(id, (draft) => setAttachmentState(draft.attachments));
    setAttachmentState(getDraftAttachments(store, id));
    return unsubscribe;
  }, [id, store]);
  const setAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      if (typeof next !== "function") {
        // Persist before rendering: this component may have unmounted while the request ran.
        setDraftAttachments(store, id, next);
        setAttachmentState(next);
        return;
      }
      setAttachmentState((previous) => {
        const value = next(previous);
        setDraftAttachments(store, id, value);
        return value;
      });
    },
    [store, id],
  );
  return [text, setText, attachments, setAttachments];
}
