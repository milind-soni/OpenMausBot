"use client";
import { errorText } from "@/lib/error-text";

import { RECONNECT_TO_CREATE, useWorkspaceOnline } from "./workspace-connection";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AtSign,
  Check,
  Download,
  Ellipsis,
  File,
  Hash,
  Loader2,
  MessageCircle,
  Paperclip,
  Pencil,
  Pin,
  Reply,
  X,
} from "lucide-react";
import { Dialog } from "./dialog";
import { IssueToastHost, showIssueToast } from "./issue-shared";
import { SuggestionRow } from "./suggestion-row";
import { CHAT_REACTIONS, MessageMenu, type MessageAction, type MessageMenuAnchor } from "./chat-message-menu";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  ChatAttachment,
  ChatMention,
  ChatReference,
  LocalChatMessage,
} from "@/lib/chat-types";
import { localApi, uploadLocalFile } from "@/lib/client-api";
import { useMemberProfile, useWorkspace } from "./workspace-context";
import { UserAvatar, memberName } from "./user-avatar";
import { ContentSkeleton } from "./content-skeleton";
import type { ChatMember } from "./chat-shell";
import {
  chatTrigger,
  insertChatTag,
  type ChatTrigger,
} from "@/lib/chat-composer";
import {
  useChatSuggestions,
  type ChatSuggestion,
} from "./use-chat-suggestions";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { IssueComposer } from "./lazy-views";
import { LocalAttachment } from "./local-attachment";
import { LOCALE, displayName, formatDate, formatDateTime, formatTime } from "@/lib/format";
import { activeChatTags, chatMessageParts, chatTextParts } from "@/lib/chat-text";
import { useChatTypingFocus } from "./use-chat-typing-focus";
import { hasOpenKeyboardOverlay } from "@/lib/keyboard-navigation";
const drafts = new Map<string, string>();
const isSheetPointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
// The last messages seen per conversation, so coming back to Chat shows them at once while they refresh.
const recentMessages = new Map<string, LocalChatMessage[]>();

type User = {
  _id: Id<"users">;
  name: string;
  username?: string;
  email: string;
  avatarUrl?: string | null;
};

/** A message joins the one above it (no avatar or name) when the same person wrote it within five minutes. */
const GROUP_GAP = 5 * 60 * 1000;
const LONG_PRESS_MS = 450;

function dayLabel(time: number) {
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Yesterday";
  return `${date.toLocaleDateString(LOCALE, { weekday: "long" })}, ${formatDate(date)}`;
}

export function ChatThread({
  sessionToken,
  user,
  onOpenReference,
  focusMessageId,
  members,
  conversation,
  recipient,
  onBack,
  query,
  pinnedOnly,
  onRead,
  initialUnread = 0,
}: {
  sessionToken: string;
  user: User;
  onOpenReference: (projectId: Id<"projects">, taskId?: Id<"tasks">) => void;
  focusMessageId?: string;
  members?: ChatMember[];
  conversation: string;
  recipient?: ChatMember;
  onBack: () => void;
  query: string;
  pinnedOnly: boolean;
  onRead: () => Promise<void>;
  /** Unread messages when the conversation was opened: a "New" divider goes above the first of them. */
  initialUnread?: number;
}) {
  const workspace = useWorkspace();
  const openMember = useMemberProfile();
  const draftKey = `${user._id}:${workspace._id}:${conversation}`;
  const [messages, setMessages] = useState<LocalChatMessage[]>(() => recentMessages.get(draftKey) || []);
  const [issueMessage, setIssueMessage] = useState<LocalChatMessage | null>(null);
  const projects = useQuery(api.projects.listForUser, issueMessage ? { sessionToken, teamId: workspace._id } : "skip");
  const [searchResults, setSearchResults] = useState<LocalChatMessage[]>([]);
  const [searching, setSearching] = useState(false);
  const [moreResults, setMoreResults] = useState(false);
  const searchText = query.trim();
  const [loading, setLoading] = useState(() => !recentMessages.has(draftKey));
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => { if (!loading) recentMessages.set(draftKey, messages.slice(-200)); }, [draftKey, loading, messages]);
  const [body, setBody] = useState(() => drafts.get(draftKey) || "");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [notice, setNotice] = useState("");
  const [reply, setReply] = useState<LocalChatMessage | null>(null);
  const [editing, setEditing] = useState<LocalChatMessage | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // Local thumbnails for images waiting in the composer, keyed by attachment id.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  useEffect(() => {
    const ids = new Set(attachments.map(file => file.id));
    setPreviews(current => {
      const stale = Object.keys(current).filter(id => !ids.has(id));
      if (!stale.length) return current;
      stale.forEach(id => URL.revokeObjectURL(current[id]));
      return Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
    });
  }, [attachments]);
  useEffect(() => () => Object.values(previewsRef.current).forEach(url => URL.revokeObjectURL(url)), []);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [mentions, setMentions] = useState<ChatMention[]>([]);
  const [trigger, setTrigger] = useState<ChatTrigger | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [focusedMessage, setFocusedMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newBelow, setNewBelow] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [menu, setMenu] = useState<{ message: LocalChatMessage; anchor: MessageMenuAnchor; opener: HTMLElement | null } | null>(null);
  const [deleting, setDeleting] = useState<LocalChatMessage | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null);
  const [unreadFrom, setUnreadFrom] = useState("");
  const unreadPending = useRef(initialUnread);
  const longPress = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightsRef = useRef<HTMLDivElement>(null);
  const draftParts = useMemo(() => chatTextParts(body, editing?.mentions ?? mentions, editing?.references ?? references), [body, editing, mentions, references]);
  const activeTags = activeChatTags(draftParts);
  const uploadRef = useRef<HTMLInputElement>(null);
  const scope = `teamId=${workspace._id}${conversation ? `&conversation=${encodeURIComponent(conversation)}` : ""}`;
  const endpoint = `/api/local-chat/messages?${scope}`;
  const searchGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++searchGeneration.current;
    setSearchResults([]); setMoreResults(false); setSearching(Boolean(searchText));
    if (!searchText) return () => controller.abort();
    const timer = setTimeout(() => {
      void localApi<{ messages: LocalChatMessage[]; hasMore: boolean }>(`${endpoint}&search=${encodeURIComponent(searchText)}`, sessionToken, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setSearchResults(result.messages); setMoreResults(result.hasMore); } })
        .catch(error => { if (!controller.signal.aborted) setNotice(errorText(error, "Search failed")); })
        .finally(() => { if (generation === searchGeneration.current) setSearching(false); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [searchText, endpoint, sessionToken]);
  const olderSearchResults = async () => {
    const generation = searchGeneration.current;
    setSearching(true);
    try {
      const result = await localApi<{ messages: LocalChatMessage[]; hasMore: boolean }>(`${endpoint}&search=${encodeURIComponent(searchText)}&before=${searchResults[0]?.createdAt}`, sessionToken);
      if (generation === searchGeneration.current) { setSearchResults(current => [...result.messages, ...current]); setMoreResults(result.hasMore); }
    } catch (error) { if (generation === searchGeneration.current) setNotice(errorText(error, "Search failed")); }
    finally { if (generation === searchGeneration.current) setSearching(false); }
  };
  const online = useWorkspaceOnline();
  const canWrite =
    online && workspace.role !== "viewer" && (!conversation || Boolean(recipient));
  useChatTypingFocus(inputRef, canWrite);
  const wasSending = useRef(false);
  useEffect(() => {
    const input = inputRef.current;
    if (wasSending.current && !sending && canWrite && input && !hasOpenKeyboardOverlay() &&
      (document.activeElement === document.body || input.closest("form")?.contains(document.activeElement))) input.focus({ preventScroll: true });
    wasSending.current = sending;
  }, [sending, canWrite]);
  // Messages store the author's name at send time; prefer the member's current full name.
  const nameOf = (message: LocalChatMessage) => {
    const member = members?.find(m => m.userId === message.authorUserId || m.email.toLowerCase() === message.authorEmail.toLowerCase());
    return member ? displayName(member) : message.authorUserId === user._id ? displayName(user) : message.authorName;
  };
  // A message as plain text, with mentions under the teammate's current name (the same names the message shows).
  const plainText = (message: LocalChatMessage) => chatMessageParts(message.body, message.mentions, message.references).map(part => {
    if (part.kind !== "mention") return part.text;
    const target = members?.find(member => member.userId === part.mention.userId);
    return target ? `@${displayName(target)}` : part.text;
  }).join("");
  const others = useMemo(() => members?.filter(member => member.userId !== user._id), [members, user._id]);
  const suggestions = useChatSuggestions(
    trigger,
    others,
    sessionToken,
    workspace._id,
  );
  const activeSuggestion = Math.min(
    suggestionIndex,
    Math.max(0, suggestions.options.length - 1),
  );
  const updateTrigger = (text: string, cursor: number) => {
    const next = editing ? null : chatTrigger(text, cursor);
    setTrigger(conversation && next?.kind === "member" ? null : next);
    setSuggestionIndex(0);
  };
  const chooseSuggestion = (option: ChatSuggestion) => {
    if (
      !trigger ||
      (option.member && !activeTags.mentionIds.has(option.member.userId!) && activeTags.mentionIds.size >= 20) ||
      (option.reference && !activeTags.referenceIds.has(option.reference.id) && activeTags.referenceIds.size >= 12)
    )
      return;
    const next = insertChatTag(body, trigger, option.insert);
    if (next.text.length > 8000) return;
    if (option.member?.userId)
      setMentions((previous) => {
        const current = previous.filter(m => activeTags.mentionIds.has(m.userId));
        return current.some((m) => m.userId === option.member!.userId)
          ? current
          : [
              ...current,
              { userId: option.member!.userId!, name: option.insert },
            ];
      });
    if (option.reference)
      setReferences((previous) => {
        const current = previous.filter(r => activeTags.referenceIds.has(r.id));
        return current.some((r) => r.id === option.reference!.id)
          ? current
          : [...current, option.reference!];
      });
    setBody(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };
  const openSuggestions = (symbol: "@" | "#") => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? body.length,
      end = input?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/.test(body[start - 1]) ? " " : "";
    const text = body.slice(0, start) + prefix + symbol + body.slice(end),
      cursor = start + prefix.length + 1;
    setBody(text);
    updateTrigger(text, cursor);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(cursor, cursor);
    });
  };
  const alive = useRef(true),
    sendLock = useRef(false),
    uploadLock = useRef(false),
    lastRead = useRef("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!editing) {
      if (body) drafts.set(draftKey, body);
      else drafts.delete(draftKey);
      if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
    }
    const input = inputRef.current;
    if (input) {
      input.style.height = "0px";
      input.style.height = `${Math.min(160, Math.max(40, input.scrollHeight))}px`;
      if (highlightsRef.current) highlightsRef.current.scrollTop = input.scrollTop;
    }
  }, [body, draftKey, editing]);
  const markRead = useCallback(
    async (message?: LocalChatMessage) => {
      if (
        !conversation ||
        !message ||
        document.hidden ||
        lastRead.current === message.id
      )
        return;
      await localApi(`/api/local-chat/conversations?${scope}`, sessionToken, {
        method: "PATCH",
        json: { messageId: message.id },
      });
      lastRead.current = message.id;
      await onRead();
    },
    [conversation, scope, sessionToken, onRead],
  );
  const scrollBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setNewBelow(false);
    setFarFromBottom(false);
    stickRef.current = true;
  };
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await localApi<{
        messages: LocalChatMessage[];
        hasMore: boolean;
      }>(endpoint, sessionToken, { signal });
      if (!alive.current || signal?.aborted) return;
      setMessages((current) => {
        const first = result.messages[0]?.createdAt ?? 0;
        return result.hasMore
          ? [...current.filter((m) => m.createdAt < first), ...result.messages]
          : result.messages;
      });
      setHasMore((current) => current || result.hasMore);
      setLoading(false);
      if (stickRef.current) await markRead(result.messages.at(-1));
    },
    [endpoint, sessionToken, markRead],
  );
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        await refresh(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          setNotice(
            errorText(error, "Chat unavailable"),
          );
          setLoading(false);
        }
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
  // Only a new latest message moves the view (or raises the pill); loading earlier messages keeps the reading position.
  const lastMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (!lastMessageId) return;
    if (stickRef.current) scrollBottom();
    else setNewBelow(true);
  }, [lastMessageId]);
  // Place the "New" divider once, on the first load: above the oldest of the messages others sent since the last read.
  useEffect(() => {
    if (loading || !unreadPending.current) return;
    let count = unreadPending.current, first = "";
    unreadPending.current = 0;
    for (let index = messages.length - 1; index >= 0 && count > 0; index--) {
      if (messages[index].authorUserId === user._id) continue;
      first = messages[index].id;
      count--;
    }
    if (!first) return;
    setUnreadFrom(first);
    requestAnimationFrame(() => {
      const element = scrollRef.current, divider = document.getElementById("chat-unread-divider");
      if (element && divider && divider.offsetTop < element.scrollTop) {
        stickRef.current = false;
        element.scrollTop = Math.max(0, divider.offsetTop - 12);
      }
    });
  }, [loading, messages, user._id]);
  useEffect(() => {
    if (!focusMessageId || conversation) return;
    let alive = true;
    stickRef.current = false;
    void localApi<{ messages: LocalChatMessage[] }>(
      `${endpoint}&focus=${encodeURIComponent(focusMessageId)}`,
      sessionToken,
    )
      .then((result) => {
        if (!alive) return;
        setMessages((current) =>
          [
            ...new Map(
              [...current, ...result.messages].map((m) => [m.id, m]),
            ).values(),
          ].sort((a, b) => a.createdAt - b.createdAt),
        );
        setFocusedMessage(focusMessageId);
      })
      .catch(() => {
        if (alive) setNotice("This message is no longer available");
      });
    return () => {
      alive = false;
    };
  }, [focusMessageId, conversation, endpoint, sessionToken]);
  useEffect(() => {
    if (focusedMessage)
      document
        .getElementById(`message-${focusedMessage}`)
        ?.scrollIntoView({ block: "center" });
  }, [focusedMessage]);
  const older = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      const element = scrollRef.current;
      const height = element?.scrollHeight || 0;
      const result = await localApi<{
        messages: LocalChatMessage[];
        hasMore: boolean;
      }>(`${endpoint}&before=${messages[0]?.createdAt}`, sessionToken);
      stickRef.current = false;
      setMessages((current) => [...result.messages, ...current]);
      setHasMore(result.hasMore);
      requestAnimationFrame(() => {
        if (element) element.scrollTop = element.scrollHeight - height;
      });
    } catch (error) {
      setNotice(
        errorText(error, "Could not load messages"),
      );
    } finally {
      setLoadingOlder(false);
    }
  };
  const change = async (id: string, patch: object) => {
    try {
      await localApi(endpoint, sessionToken, {
        method: "PATCH",
        json: { id, ...patch },
      });
      await refresh();
    } catch (error) {
      setNotice(
        errorText(error, "Could not update message"),
      );
    }
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      !canWrite ||
      sendLock.current ||
      uploadLock.current ||
      (!body.trim() && !attachments.length)
    )
      return;
    sendLock.current = true;
    setSending(true);
    setNotice("");
    try {
      if (editing) {
        await localApi(endpoint, sessionToken, {
          method: "PATCH",
          json: { id: editing.id, body },
        });
        setEditing(null);
      } else
        await localApi(endpoint, sessionToken, {
          method: "POST",
          json: {
            body,
            attachmentIds: attachments.map((f) => f.id),
            references: references.filter(r => activeTags.referenceIds.has(r.id)),
            mentionUserIds: [...activeTags.mentionIds],
            replyTo: reply?.id,
          },
        });
      if (!editing) drafts.delete(draftKey);
      if (!alive.current) return;
      setBody(editing ? drafts.get(draftKey) || "" : "");
      setTrigger(null);
      setAttachments([]);
      setReferences([]);
      setMentions([]);
      setReply(null);
      stickRef.current = true;
      await refresh();
    } catch (error) {
      setNotice(errorText(error, "Message failed"));
    } finally {
      sendLock.current = false;
      if (alive.current) setSending(false);
    }
  };
  const upload = async (files: FileList | File[]) => {
    if (!canWrite || editing || uploadLock.current || sendLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    setNotice("");
    try {
      for (const file of Array.from(files).slice(0, 8 - attachments.length)) {
        if (file.size > 15 * 1024 * 1024)
          throw new Error(`${file.name} exceeds 15 MB`);
        const result = { file: await uploadLocalFile(`/api/local-chat/files?${scope}`, sessionToken, file) as ChatAttachment };
        if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
          const url = URL.createObjectURL(file);
          setPreviews(current => ({ ...current, [result.file.id]: url }));
        }
        setAttachments((current) => [...current, result.file]);
      }
    } catch (error) {
      setNotice(errorText(error, "Upload failed"));
    } finally {
      uploadLock.current = false;
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };
  const startEdit = (message: LocalChatMessage) => {
    setEditing(message);
    setReply(null);
    setTrigger(null);
    setBody(message.body);
    requestAnimationFrame(() => { const input = inputRef.current; input?.focus(); input?.setSelectionRange(message.body.length, message.body.length); });
  };
  const startReply = (message: LocalChatMessage) => {
    setReply(message);
    if (editing) setBody(drafts.get(draftKey) || "");
    setEditing(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const cancelContext = () => {
    if (editing) setBody(drafts.get(draftKey) || "");
    setReply(null);
    setEditing(null);
  };
  const act = async (message: LocalChatMessage, action: MessageAction) => {
    if (action.startsWith("react:")) return change(message.id, { reaction: action.slice(6) });
    if (action === "reply") startReply(message);
    else if (action === "edit") startEdit(message);
    else if (action === "issue") setIssueMessage(message);
    else if (action === "pin") await change(message.id, { pinned: !message.pinned });
    else if (action === "delete") setDeleting(message);
    else if (action === "copy") {
      try { await navigator.clipboard.writeText(message.body); showIssueToast("Copied"); }
      catch { setNotice("Could not copy message"); }
    }
  };
  const openMenu = (message: LocalChatMessage, anchor: MessageMenuAnchor, opener: HTMLElement | null) => {
    if (!canWrite) return;
    setMenu({ message, anchor, opener });
  };
  // Touch: hold a message to open its actions (a bottom sheet); moving the finger first is a scroll.
  const pressHandlers = (message: LocalChatMessage) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" || !canWrite) return;
      const target = event.currentTarget;
      if (longPress.current) window.clearTimeout(longPress.current.timer);
      longPress.current = { x: event.clientX, y: event.clientY, fired: false, timer: window.setTimeout(() => {
        if (!longPress.current) return;
        longPress.current.fired = true;
        target.classList.add("is-pressed");
        navigator.vibrate?.(8);
        openMenu(message, null, target);
      }, LONG_PRESS_MS) };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const press = longPress.current;
      if (press && !press.fired && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) { window.clearTimeout(press.timer); longPress.current = null; }
    },
    onPointerUp: () => { const press = longPress.current; if (press && !press.fired) { window.clearTimeout(press.timer); longPress.current = null; } },
    onPointerCancel: () => { const press = longPress.current; if (press) window.clearTimeout(press.timer); longPress.current = null; },
    // The click a phone makes after the finger lifts would land on the sheet that just opened under it.
    onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => { if (longPress.current?.fired) event.preventDefault(); },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      // The click a finished long-press produces must not follow a link or open a profile underneath.
      if (longPress.current?.fired) { event.preventDefault(); event.stopPropagation(); longPress.current = null; }
    },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      if (!canWrite || (event.target as HTMLElement).closest("a[href]")) return;
      event.preventDefault();
      if (longPress.current?.fired || menu) return;
      openMenu(message, isSheetPointer() ? null : { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY }, null);
    },
  });
  const filtered = (searchText ? searchResults : messages).filter(m => !pinnedOnly || m.pinned);
  const menuMessage = menu && (messages.find(m => m.id === menu.message.id) || searchResults.find(m => m.id === menu.message.id) || menu.message);
  return (
    <section
      className="chat-thread"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length && canWrite) {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }
      }}
    >
      {conversation && (
        <div className="dm-recipient">
          <button
            className="icon-button dm-back"
            aria-label="Back to direct messages"
            onClick={onBack}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            className="dm-recipient-profile"
            disabled={!recipient}
            onClick={() => recipient && openMember(recipient.email)}
          >
            <UserAvatar
              user={recipient || { name: "Former member" }}
              size="small"
            />
            <strong>
              {recipient ? memberName(recipient) : "Former member"}
            </strong>
          </button>
        </div>
      )}
      <div
        className="conversation"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const below = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickRef.current = below < 100;
          setFarFromBottom(below > el.clientHeight);
          if (stickRef.current) {
            setNewBelow(false);
            void markRead(messages.at(-1)).catch(() => {});
          }
        }}
      >
        {(loading || (searching && !searchResults.length)) && (
          <ContentSkeleton kind="chat" label="Loading messages" rows={6} />
        )}
        {!searchText && hasMore && (
          <button
            className="load-earlier"
            disabled={loadingOlder}
            onClick={older}
          >
            {loadingOlder ? "Loading..." : "Load earlier messages"}
          </button>
        )}
        {searchText && moreResults && <button className="load-earlier" disabled={searching} onClick={olderSearchResults}>{searching ? "Searching..." : "Earlier results"}</button>}
        {!loading && !searching && !filtered.length && (
          <div className="chat-empty">
            <MessageCircle size={32} />
            <h2>
              {query || pinnedOnly
                ? "No messages found"
                : conversation
                  ? `Message ${recipient ? memberName(recipient) : "this teammate"}`
                  : "Start a conversation"}
            </h2>
          </div>
        )}
        {filtered.map((message, index) => {
          const member = members?.find(
            (m) =>
              m.userId === message.authorUserId ||
              m.email.toLowerCase() === message.authorEmail.toLowerCase(),
          );
          const own = message.authorUserId === user._id;
          const identity =
            own || message.authorEmail.toLowerCase() === user.email.toLowerCase()
              ? user
              : member || {
                  name: message.authorName,
                  email: message.authorEmail,
                  avatarUrl: message.avatarUrl,
                };
          const name = memberName(identity);
          const previous = filtered[index - 1];
          const newDay =
            !previous ||
            new Date(previous.createdAt).toDateString() !==
              new Date(message.createdAt).toDateString();
          const unreadStart = message.id === unreadFrom;
          const grouped = Boolean(previous && !newDay && !unreadStart && !message.replyTo &&
            previous.authorUserId === message.authorUserId && message.createdAt - previous.createdAt < GROUP_GAP);
          const replyMessage = messages.find((m) => m.id === message.replyTo);
          const reactions = Object.entries(message.reactions || {}).filter(([, ids]) => ids.length);
          const time = <time
            dateTime={new Date(message.createdAt).toISOString()}
            title={formatDateTime(message.createdAt)}
          >
            {formatTime(message.createdAt)}
          </time>;
          return (
            <Fragment key={message.id}>
              {/* The first unread message of a day gets one row: the day, then the red "New" line. */}
              {newDay && (
                <div className={`chat-day ${unreadStart ? "is-unread" : ""}`} id={unreadStart ? "chat-unread-divider" : undefined}>
                  <span>{dayLabel(message.createdAt)}</span>
                  {unreadStart && <b>New</b>}
                </div>
              )}
              {unreadStart && !newDay && <div className="chat-unread" id="chat-unread-divider"><span>New</span></div>}
              <article
                id={`message-${message.id}`}
                className={`conversation-message ${grouped ? "is-grouped" : ""} ${message.id === focusedMessage ? "notification-focus" : ""} ${menu?.message.id === message.id ? "is-active" : ""}`}
                tabIndex={-1}
                {...pressHandlers(message)}
              >
                {grouped ? <span className="message-gutter"><time dateTime={new Date(message.createdAt).toISOString()} title={formatDateTime(message.createdAt)}>{formatTime(message.createdAt).replace(/\s?[AP]M$/, "")}</time></span> : <button
                  className="chat-profile-avatar"
                  disabled={!member}
                  aria-label={`View ${name} profile`}
                  onClick={() => member && openMember(member.email)}
                >
                  <UserAvatar user={identity} />
                </button>}
                <div className="message-content">
                  {!grouped && <header>
                    <button
                      className="chat-profile-name"
                      disabled={!member}
                      onClick={() => member && openMember(member.email)}
                    >
                      {name}
                    </button>
                    {time}
                  </header>}
                  {replyMessage && (
                    <button
                      className="message-reply-preview"
                      onClick={() =>
                        document
                          .getElementById(`message-${replyMessage.id}`)
                          ?.scrollIntoView({
                            block: "center",
                            behavior: "smooth",
                          })
                      }
                    >
                      <Reply size={12} />
                      <strong>{nameOf(replyMessage)}</strong>
                      <span>{plainText(replyMessage) || "Attachment"}</span>
                    </button>
                  )}
                  {(message.body || message.editedAt || message.pinned) && <p className="chat-message-text">{chatMessageParts(message.body, message.mentions, message.references).map((part, index) => {
                    if (part.kind === "link") return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>;
                    if (part.kind === "mention") {
                      const target = members?.find(member => member.userId === part.mention.userId);
                      return <button key={index} type="button" className="chat-inline-tag" disabled={!target} onClick={() => target && openMember(target.email)}>{target ? `@${displayName(target)}` : part.text}</button>;
                    }
                    if (part.kind === "reference") return <button key={index} type="button" className="chat-inline-tag chat-inline-reference" onClick={() => onOpenReference(part.reference.projectId as Id<"projects">, part.reference.type === "issue" ? part.reference.id as Id<"tasks"> : undefined)}>{part.text}</button>;
                    return <Fragment key={index}>{part.text}</Fragment>;
                  })}{message.editedAt ? <small className="message-meta" title={formatDateTime(message.editedAt)}>(edited)</small> : null}{message.pinned ? <small className="message-meta message-pinned" aria-label="Pinned"><Pin size={11} /></small> : null}</p>}
                  {message.attachments?.length ? (
                    <div className="message-files" onClick={event => {
                      // Images open in place; other files keep their download link.
                      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.image-attachment[href]");
                      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || longPress.current?.fired) return;
                      event.preventDefault();
                      setLightbox({ url: link.href, name: link.getAttribute("download") || "" });
                    }}>
                      {message.attachments.map((file) => (
                        <LocalAttachment
                          key={file.id}
                          file={file}
                          sessionToken={sessionToken}
                          scope={scope}
                        />
                      ))}
                    </div>
                  ) : null}
                  {reactions.length > 0 && <div className="message-reactions">
                    {reactions.map(([reaction, ids]) => {
                      const option = CHAT_REACTIONS.find(item => item.key === reaction);
                      const Icon = option?.Icon ?? Check;
                      const names = ids.map(id => id === user._id ? "You" : (members?.find(m => m.userId === id) ? displayName(members.find(m => m.userId === id)!) : "")).filter(Boolean);
                      return <button
                        key={reaction}
                        className={ids.includes(user._id) ? "selected" : ""}
                        disabled={!canWrite}
                        aria-pressed={ids.includes(user._id)}
                        aria-label={`${option?.label ?? reaction}: ${names.join(", ") || ids.length}`}
                        title={names.join(", ")}
                        onClick={() => change(message.id, { reaction })}
                      >
                        <Icon size={12} />
                        {ids.length}
                      </button>;
                    })}
                  </div>}
                </div>
                {canWrite && (
                  <div className="message-tools">
                    {CHAT_REACTIONS.map(({ key, label, Icon }) => <button key={key} title={label} aria-label={label} aria-pressed={Boolean(message.reactions?.[key]?.includes(user._id))} onClick={() => change(message.id, { reaction: key })}><Icon size={14} /></button>)}
                    <i aria-hidden="true" />
                    <button title="Reply" aria-label="Reply" onClick={() => startReply(message)}><Reply size={14} /></button>
                    {own && <button aria-label="Edit message" title="Edit" onClick={() => startEdit(message)}><Pencil size={14} /></button>}
                    <button
                      aria-label="More actions"
                      title="More"
                      aria-haspopup="menu"
                      aria-expanded={menu?.message.id === message.id}
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        // Keyboard activation (detail 0) returns focus here on close; a mouse leaves it where the click went.
                        openMenu(message, { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, event.detail === 0 ? event.currentTarget : null);
                      }}
                    >
                      <Ellipsis size={14} />
                    </button>
                  </div>
                )}
              </article>
            </Fragment>
          );
        })}
      </div>
      {notice && (
        <div className="notice danger" role="alert">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <form className="rich-composer" onSubmit={submit}>
        {(newBelow || farFromBottom) && !trigger && (
          <button type="button" className={`new-messages ${newBelow ? "" : "is-icon"}`} aria-label={newBelow ? undefined : "Jump to latest"} onClick={scrollBottom}>
            <ArrowDown size={14} />
            {newBelow && "New messages"}
          </button>
        )}
        {trigger && (
          <div
            className="chat-suggestions"
            id="chat-suggestions"
            role="listbox"
            aria-label={
              trigger.kind === "member" ? "Teammates" : "Projects and issues"
            }
          >
            {suggestions.loading && !suggestions.options.length ? (
              <ContentSkeleton
                kind="chat"
                rows={2}
                label="Loading suggestions"
              />
            ) : (
              suggestions.options.map((option, index) => (
                <button
                  key={option.key}
                  id={`chat-suggestion-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeSuggestion}
                  disabled={
                    option.member
                      ? !activeTags.mentionIds.has(option.member.userId!) && activeTags.mentionIds.size >= 20
                      : Boolean(option.reference && !activeTags.referenceIds.has(option.reference.id) && activeTags.referenceIds.size >= 12)
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSuggestion(option)}
                >
                  <SuggestionRow
                    option={option}
                    avatar={option.member?.userId === user._id ? user : undefined}
                  />
                </button>
              ))
            )}
            {!suggestions.loading && !suggestions.options.length && (
              <div className="suggestion-empty">No matches</div>
            )}
          </div>
        )}
        {(reply || editing) && (
          <div className="composer-context">
            {editing ? <Pencil size={14} /> : <Reply size={14} />}
            <span>
              {editing
                ? "Editing your message"
                : `Replying to ${reply ? nameOf(reply) : ""}`}
            </span>
            <button
              type="button"
              aria-label="Cancel"
              onClick={() => { cancelContext(); inputRef.current?.focus(); }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((file) => (
              <span key={file.id} className={previews[file.id] ? "composer-image" : undefined} title={previews[file.id] ? file.name : undefined}>
                {previews[file.id] ? <img src={previews[file.id]} alt={file.name} /> : <><File size={13} />{file.name}</>}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((f) => f.id !== file.id),
                    )
                  }
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-composer-input">
        <div ref={highlightsRef} className="chat-composer-highlights" aria-hidden="true">{draftParts.map((part, index) => part.kind === "mention" || part.kind === "reference" ? <mark key={index} className={part.kind === "reference" ? "reference-highlight" : undefined}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>)}{"\n"}</div>
        <textarea
          ref={inputRef}
          autoFocus={canWrite && !focusMessageId}
          data-initial-focus={canWrite && !focusMessageId ? true : undefined}
          aria-label={conversation ? "Direct message" : "Message the team"}
          value={body}
          onScroll={(event) => { if (highlightsRef.current) highlightsRef.current.scrollTop = event.currentTarget.scrollTop; }}
          onChange={(e) => {
            setBody(e.target.value);
            updateTrigger(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) =>
            updateTrigger(e.currentTarget.value, e.currentTarget.selectionStart)
          }
          onBlur={(e) => {
            if (!e.currentTarget.closest("form")?.contains(e.relatedTarget))
              setTrigger(null);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (trigger) {
              if (e.key === "Escape") {
                e.preventDefault();
                setTrigger(null);
                return;
              }
              if (["ArrowDown", "ArrowUp"].includes(e.key)) {
                e.preventDefault();
                const count = suggestions.options.length;
                if (count)
                  setSuggestionIndex(
                    (activeSuggestion +
                      (e.key === "ArrowDown" ? 1 : -1) +
                      count) %
                      count,
                  );
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (suggestions.options[activeSuggestion])
                  chooseSuggestion(suggestions.options[activeSuggestion]);
                return;
              }
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                setTrigger(null);
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape" && (editing || reply)) {
              e.preventDefault();
              e.stopPropagation();
              cancelContext();
            } else if (e.key === "ArrowUp" && !body && !editing && !attachments.length && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
              const last = [...messages].reverse().find(m => m.authorUserId === user._id);
              if (last) { e.preventDefault(); startEdit(last); }
            }
          }}
          aria-autocomplete="list"
          aria-controls={trigger ? "chat-suggestions" : undefined}
          aria-activedescendant={
            trigger && suggestions.options.length
              ? `chat-suggestion-${activeSuggestion}`
              : undefined
          }
          onPaste={(e) => {
            const files = e.clipboardData.files;
            if (files.length && canWrite) {
              e.preventDefault();
              void upload(files);
            }
          }}
          placeholder={
            !online ? "Reconnect to send a message" : canWrite
              ? conversation
                ? `Message ${recipient ? memberName(recipient) : "teammate"}`
                : "Message the team"
              : "You have view-only access"
          }
          disabled={!canWrite || sending}
          rows={1}
          maxLength={8000}
        />
        </div>
        <footer>
          <div>
            <input
              ref={uploadRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
              }}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Attach files"
              title={!online ? RECONNECT_TO_CREATE : "Attach files"}
              disabled={
                !canWrite ||
                uploading ||
                sending ||
                Boolean(editing) ||
                attachments.length >= 8
              }
              onClick={() => uploadRef.current?.click()}
            >
              {uploading ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <Paperclip size={17} />
              )}
            </button>
            {!conversation && others?.length !== 0 && (
              <button
                type="button"
                className="icon-button"
                aria-label="Mention a teammate"
                title="Mention a teammate"
                disabled={!canWrite || sending || Boolean(editing)}
                onClick={() => openSuggestions("@")}
              >
                <AtSign size={17} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Tag a project or issue"
              title="Tag a project or issue"
              disabled={!canWrite || sending || Boolean(editing)}
              onClick={() => openSuggestions("#")}
            >
              <Hash size={17} />
            </button>
          </div>
          <button
            className="send-message"
            title={!online ? RECONNECT_TO_CREATE : editing ? "Save message" : "Send message"}
            aria-label={editing ? "Save message" : "Send message"}
            disabled={
              !canWrite ||
              sending ||
              uploading ||
              (!body.trim() && !attachments.length)
            }
          >
            {sending ? (
              <Loader2 className="spin" size={16} />
            ) : editing ? (
              <Check size={16} />
            ) : (
              <ArrowUp size={19} strokeWidth={2.2} />
            )}
          </button>
        </footer>
      </form>
      {menu && menuMessage && <MessageMenu
        anchor={menu.anchor}
        preview={plainText(menuMessage) || menuMessage.attachments?.[0]?.name || ""}
        own={menuMessage.authorUserId === user._id}
        pinned={Boolean(menuMessage.pinned)}
        reacted={key => Boolean(menuMessage.reactions?.[key]?.includes(user._id))}
        canCreateIssue={Boolean(menuMessage.body)}
        onAction={action => void act(menuMessage, action)}
        onClose={restore => {
          document.querySelectorAll(".conversation-message.is-pressed").forEach(element => element.classList.remove("is-pressed"));
          setMenu(null);
          if (restore && menu.anchor && menu.opener?.isConnected) menu.opener.focus({ preventScroll: true });
        }}
      />}
      {deleting && <Dialog title="Delete message" className="confirm-dialog" onClose={() => setDeleting(null)}>
        <div className="dialog-body">
          <p className="confirm-text chat-delete-preview">{plainText(deleting) || deleting.attachments?.map(file => file.name).join(", ")}</p>
          <div className="dialog-actions">
            <button type="button" className="ghost-button compact" onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="primary-button danger compact" autoFocus onClick={() => { const target = deleting; setDeleting(null); void change(target.id, { delete: true }); }}>Delete</button>
          </div>
        </div>
      </Dialog>}
      <IssueToastHost />
      {lightbox && <Dialog title={lightbox.name || "Image"} className="chat-lightbox" heading={<>
        <h2>{lightbox.name || "Image"}</h2>
        <a className="icon-button" href={lightbox.url} download={lightbox.name} aria-label={`Download ${lightbox.name}`} title="Download"><Download size={17} /></a>
      </>} onClose={() => setLightbox(null)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a local blob URL */}
        <div className="chat-lightbox-image"><img src={lightbox.url} alt={lightbox.name} /></div>
      </Dialog>}
      {issueMessage && projects && <IssueComposer sessionToken={sessionToken} projects={projects} activeProjectId={null} initialDraft={{ title: issueMessage.body.split("\n")[0].slice(0, 250) || "Follow up on chat", description: `${issueMessage.body}\n\nFrom ${nameOf(issueMessage)}, ${formatDateTime(issueMessage.createdAt)}` }} onClose={() => setIssueMessage(null)} onCreated={onOpenReference} />}
    </section>
  );
}
