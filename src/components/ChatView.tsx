import { AutoResumeNoticeCard } from "./AutoResumeNoticeCard";
import { UsageRings } from "./UsageRings";
import { Component, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  Loader2,
  Monitor,
  Pencil,
  RefreshCw,
  Smartphone,
  Square,
  X,
} from "lucide-react";
import { useStore, useStreaming, formatTime, messageVersions, visibleMessages, type Bot, type Message } from "@/state/store";
import { TasksPanel } from "./TasksPanel";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { ReactionBar, ReactionChips } from "./Reactions";
import { cn } from "@/lib/cn";
import { ProjectMentionText } from "./ProjectMentionText";
import { botIntro } from "@/lib/botIntro";
import { AttachmentList } from "./AttachmentViewer";
import { MobilePreviewPanel } from "./MobilePreviewPanel";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useHeaderCollapse } from "@/lib/useHeaderCollapse";
import { HeaderMoreMenu } from "./HeaderMoreMenu";
import { SHARED_HEADER_HEIGHT_CLASS } from "@/lib/layoutTokens";
import type { Attachment } from "@/state/store";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at)} {formatTime(at)}
    </div>
  );
}

/** Hover/focus-revealed copy control shared by user + bot bubbles. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy message"
      title="Copy message"
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/** Live extended thinking: shimmer label + collapsible reasoning text.
 * Ephemeral — rendered only while the turn runs, dropped when it settles. */
function ThinkingStrip({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [text, open]);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] min-w-[200px]">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] hover:bg-raised/40"
        >
          <Brain size={13} className="text-ink-secondary" />
          <span className={cn(active ? "thinking-shimmer animate-shimmer" : "text-ink-secondary")}>
            {active ? "Thinking…" : "Thought process"}
          </span>
          <ChevronDown size={12} className={cn("text-ink-secondary transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div
            ref={tailRef}
            className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-hairline/30 bg-panel px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary"
          >
            {text}
          </div>
        ) : (
          active && (
            <div className="mt-0.5 truncate pl-6 text-[12px] text-ink-secondary/70">
              {text.slice(-120).split("\n").pop()}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill. */
function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
          >
            <RefreshCw size={12} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  attachments,
  onCancel,
  onSubmit,
}: {
  initial: string;
  attachments?: Attachment[];
  onCancel: () => void;
  onSubmit: (text: string, attachments?: Attachment[]) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(draft.length, draft.length);
  }, []);
  const submit = () => {
    const t = draft.trim();
    if (t || (attachments && attachments.length > 0)) onSubmit(t, attachments);
  };
  return (
    <div className="w-full max-w-[70%] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <AttachmentList attachments={attachments} />
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim() && (!attachments || attachments.length === 0)}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string, attachments?: Attachment[]) => void;
  onRegenerate?: () => void;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} attachments={message.attachments} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div className={cn("group animate-msg-in flex w-full flex-col", user ? "items-end" : "items-start")}>
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {/* editing rewinds the thread, so it waits for the turn to end —
            same rule as the version switcher below */}
        {user && message.kind === "text" && !bot.busy && (
          <button
            onClick={onStartEdit}
            aria-label="Edit message"
            className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            title="Edit message"
          >
            <Pencil size={14} />
          </button>
        )}
        {user && message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
        {user && text && <CopyButton text={text} />}
        <div
          className={cn(
            "max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
            user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
        >
          {user ? (
            <>
              <AttachmentList attachments={message.attachments} />
              {message.scheduled && <span className="mb-1 block text-[11px] text-ink-secondary">⏰ Scheduled</span>}
              {text && (
                <div
                  className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                >
                  <ProjectMentionText text={text} />
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full message
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : (
            <>
              <AttachmentList attachments={message.attachments} />
              <MessageBoundary fallbackText={text}>
                <ChatMarkdown text={text} />
              </MessageBoundary>
            </>
          )}
        </div>
        {!user && (
          <div className="flex flex-col gap-0.5 self-end pb-0.5">
            {text && <CopyButton text={text} />}
            {isLastBotText && !bot.busy && onRegenerate && (
              <button
                onClick={onRegenerate}
                aria-label="Regenerate response"
                title="Regenerate response"
                className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        )}
        {!user && message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
        <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100",
            user && "order-first",
          )}
        >
          {formatTime(message.at)}
        </span>
      </div>
      <ReactionChips threadId={bot.threadId} message={message} align={user ? "right" : "left"} />
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous version"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next version"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open the conversation with ${comm.withName}`}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <MausAvatar color={comm.withColor} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  // markdown re-parses on a deferred value: when tokens arrive faster than
  // the parser keeps up, React lags the parse instead of janking the frame
  const deferred = useDeferredValue(text);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <MessageBoundary fallbackText={deferred}>
          <ChatMarkdown text={deferred} streaming />
        </MessageBoundary>
        <span className="animate-caret ml-0.5 inline-block h-[14px] w-[2px] bg-ink align-middle" />
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  editingId,
  lastBotTextId,
  canRetryLast,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onStarter,
}: {
  bot: Bot;
  messages: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  canRetryLast: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string, attachments?: Attachment[]) => void;
  onRegenerate: () => void;
  onStarter: (text: string) => void;
}) {
  const intro = messages.length === 0 && !bot.busy ? botIntro(bot) : null;
  return (
    <>
      {intro && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <MausAvatar color={bot.color} state="idle" size={64} motion="none" motionKey={0} />
          <div className="text-[17px] font-semibold text-ink">{bot.name}</div>
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {intro.summary ? <ProjectMentionText text={intro.summary} /> : "Send a message to start the conversation."}
          </div>
          <div className="mt-2 flex max-w-[480px] flex-wrap justify-center gap-2">
            {intro.starters.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => onStarter(starter)}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
              >
                {starter}
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
        const row = (() => {
          switch (m.kind) {
            case "options":
              return <OptionCard botId={bot.id} message={m} />;
            case "activity":
              // a failed turn is an error, not a tool run — render it as one
              return m.tool?.name.startsWith("error:") ? (
                <ErrorRow
                  message={m.tool.name.slice(6).trim()}
                  onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                />
              ) : (
                <ActivityChip message={m} />
              );
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text, attachments) => onSubmitEdit(m.id, text, attachments)}
                  onRegenerate={onRegenerate}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents">
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string, attachments?: Attachment[]) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text, attachments });
    },
    [bot.id, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );
  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if ((lastUserMessage?.text || (lastUserMessage?.attachments && lastUserMessage.attachments.length > 0)) && !bot.busy) {
      dispatch({
        type: "editMessage",
        botId: bot.id,
        messageId: lastUserMessage.id,
        text: lastUserMessage.text ?? "",
        attachments: lastUserMessage.attachments,
      });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(
    () => localStorage.getItem("chat-mobile-preview-open") === "true",
  );
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [starterText, setStarterText] = useState<string | null>(null);
  const clearStarterText = useCallback(() => setStarterText(null), []);
  const [tasksOpen, setTasksOpen] = useState(() => localStorage.getItem("chat-tasks-open") === "true");
  const botTasks = useMemo(() => state.tasks.filter((task) => task.assigneeBotId === bot.id), [state.tasks, bot.id]);
  const isLargeScreen = useMediaQuery("(min-width: 1180px)");
  const isDualPanelWide = useMediaQuery("(min-width: 1400px)");
  const previewAsDrawer = !isDualPanelWide && tasksOpen;

  const [lastRequestedDrawer, setLastRequestedDrawer] = useState<"preview" | "tasks">("preview");

  const togglePreview = useCallback(() => {
    setMobilePreviewOpen((open) => {
      const next = !open;
      if (!isLargeScreen) {
        if (next) {
          setLastRequestedDrawer("preview");
          setTasksOpen(false);
        } else {
          setTasksOpen(false);
        }
      }
      return next;
    });
  }, [isLargeScreen]);

  const toggleTasks = useCallback(() => {
    setTasksOpen((open) => {
      const next = !open;
      if (!isLargeScreen) {
        if (next) {
          setLastRequestedDrawer("tasks");
          setMobilePreviewOpen(false);
        } else {
          setMobilePreviewOpen(false);
        }
      }
      return next;
    });
  }, [isLargeScreen]);

  const activeMobileDrawer: "preview" | "tasks" | null = useMemo(() => {
    if (isLargeScreen) return null;
    if (mobilePreviewOpen && tasksOpen) return lastRequestedDrawer;
    if (mobilePreviewOpen) return "preview";
    if (tasksOpen) return "tasks";
    return null;
  }, [isLargeScreen, mobilePreviewOpen, tasksOpen, lastRequestedDrawer]);

  // Escape key closes drawers at narrow viewports (<1180px)
  useEffect(() => {
    if (isLargeScreen) return;
    if (!mobilePreviewOpen && !tasksOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        setMobilePreviewOpen(false);
        setTasksOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isLargeScreen, mobilePreviewOpen, tasksOpen]);

  const estimatedInitialWidth = useMemo(() => {
    if (typeof window === "undefined") return 1024;
    const sidebarWidth = 320;
    const previewWidth = isDualPanelWide && mobilePreviewOpen ? 380 : 0;
    const tasksWidth = isDualPanelWide && tasksOpen ? 320 : 0;
    return window.innerWidth - sidebarWidth - previewWidth - tasksWidth;
  }, [isDualPanelWide, mobilePreviewOpen, tasksOpen]);

  const headerRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  const collapse = useHeaderCollapse({
    headerRef,
    nameRef,
    actionsRef,
    estimatedInitialWidth,
  });

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => localStorage.setItem("chat-mobile-preview-open", String(mobilePreviewOpen)), [mobilePreviewOpen]);
  useEffect(() => localStorage.setItem("chat-tasks-open", String(tasksOpen)), [tasksOpen]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, follow]);

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) setFollow(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  // on Windows the frameless window's min/max/close overlay sits at the
  // top-right: the header becomes the drag strip and clears room for it
  const isWin = window.gbs?.platform === "win32";
  const drag = isWin ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  const noDrag = isWin ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  return (
    <main className="relative flex h-full min-w-0 flex-1 bg-app">
      <section className="relative flex h-full min-w-[360px] flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div
        ref={headerRef}
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 px-3.5 min-[1600px]:px-5 border-b border-transparent min-w-0 max-w-full",
          SHARED_HEADER_HEIGHT_CLASS,
          isWin && "pr-[148px]",
        )}
        style={drag}
      >
        <button
          ref={nameRef}
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex min-w-0 shrink items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-raised/50"
          title="Bot settings"
          style={noDrag}
        >
          <MausAvatar
            color={bot.color}
            state={stateForBot({ ...bot, messages })}
            size={28}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
          <span className="max-w-[10rem] truncate text-[15px] font-semibold text-ink">{bot.name}</span>
          {bot.busy && <Loader2 size={14} className="shrink-0 animate-spin text-ink-secondary" />}
        </button>
        <div ref={actionsRef} className="flex shrink-0 items-center gap-1.5" style={noDrag}>
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              title="Stop this turn"
            >
              <Square size={12} className="shrink-0 fill-current text-danger" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}

          {!collapse.collapseSecondaryToMenu && (
            <button
              type="button"
              title="Schedule run…"
              aria-label="Schedule run…"
              onClick={() => dispatch({ type: "openSchedule", target: { botId: bot.id } })}
              className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"
            >
              ⏰
            </button>
          )}

          <UsageRings compact={collapse.isTight || !isDualPanelWide || tasksOpen} />

          <ModelPicker
            bot={bot}
            compact={collapse.modelMode === "compact"}
            iconOnly={collapse.modelMode === "iconOnly"}
          />

          {!collapse.collapseSecondaryToMenu && (
            <button
              onClick={() => dispatch({ type: "toggleComputer" })}
              className={cn(
                "rounded-md p-1.5 hover:bg-raised",
                state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
              )}
              title="Bot's computer"
            >
              <Monitor size={18} />
            </button>
          )}

          {collapse.collapseSecondaryToMenu && (
            <HeaderMoreMenu
              items={[
                {
                  id: "schedule",
                  label: "Schedule run…",
                  icon: "⏰",
                  onClick: () => dispatch({ type: "openSchedule", target: { botId: bot.id } }),
                },
                {
                  id: "computer",
                  label: "Bot's computer",
                  icon: <Monitor size={14} />,
                  onClick: () => dispatch({ type: "toggleComputer" }),
                },
              ]}
            />
          )}

          <button
            type="button"
            onClick={togglePreview}
            aria-label={mobilePreviewOpen ? "Hide mobile preview" : "Show mobile preview"}
            aria-pressed={mobilePreviewOpen}
            title={mobilePreviewOpen ? "Hide mobile preview" : "Show mobile preview"}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]",
              mobilePreviewOpen ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            <Smartphone size={14} />
            {collapse.showButtonsText && <span>Preview</span>}
          </button>

          <button
            type="button"
            onClick={toggleTasks}
            aria-label={tasksOpen ? "Hide tasks" : "Show tasks"}
            aria-pressed={tasksOpen}
            title={tasksOpen ? "Hide tasks" : "Show tasks"}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]",
              tasksOpen ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            <ClipboardList size={14} />
            {collapse.showButtonsText && <span>Tasks</span>}
            {botTasks.length > 0 && (
              <span className="flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
                {botTasks.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div
          className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4"
          role="log"
          aria-live="polite"
          aria-label={`Conversation with ${bot.name}`}
        >
          <MessagesList
            bot={bot}
            messages={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            onStarter={setStarterText}
          />
          {reasoning && bot.busy && <ThinkingStrip text={reasoning} active={!streaming} />}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            bot.busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                  </span>
                  <WorkingTimer since={lastUserMessage?.at ?? Date.now()} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          className="animate-pop-in absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      {/* keyed by bot: a draft belongs to the conversation it was typed in.
          Switching bots remounts the composer, which restores that bot's own
          saved draft (src/lib/composerDrafts.ts) instead of carrying the
          previous bot's half-written message over */}
      <AutoResumeNoticeCard threadId={bot.threadId} />
      <Composer
        key={bot.id}
        bot={bot}
        onEditLast={lastUserMessage ? () => setEditingId(lastUserMessage.id) : undefined}
        pendingAttachment={previewAttachment}
        onPendingAttachmentConsumed={() => setPreviewAttachment(null)}
        pendingText={starterText}
        onPendingTextConsumed={clearStarterText}
      />
      </section>

      {/* Drawer mode: Single backdrop for narrow viewports (< 1180px) */}
      {!isLargeScreen && activeMobileDrawer && (
        <button
          type="button"
          aria-label={activeMobileDrawer === "preview" ? "Close mobile preview panel" : "Close tasks panel"}
          onClick={() => {
            if (activeMobileDrawer === "preview") setMobilePreviewOpen(false);
            else setTasksOpen(false);
          }}
          className="absolute inset-0 z-20 bg-black/55"
        />
      )}

      {/* Preview drawer below 1180px */}
      {!isLargeScreen && mobilePreviewOpen && activeMobileDrawer === "preview" && (
        <MobilePreviewPanel
          onClose={() => setMobilePreviewOpen(false)}
          onScreenshot={setPreviewAttachment}
          className="absolute inset-y-0 right-0 z-30 flex max-w-[88vw] shadow-2xl"
        />
      )}

      {/* Tasks drawer below 1180px */}
      {!isLargeScreen && tasksOpen && activeMobileDrawer === "tasks" && (
        <TasksPanel
          tasks={botTasks}
          emptyLabel="No tasks assigned to this agent yet."
          onClose={() => setTasksOpen(false)}
          className="absolute inset-y-0 right-0 z-30 flex max-w-[88vw] shadow-2xl"
        />
      )}

      {/* Large screen (>= 1180px): Preview (docked or overlay drawer) */}
      {isLargeScreen && mobilePreviewOpen && (
        <>
          {previewAsDrawer && (
            <button
              type="button"
              aria-label="Close mobile preview panel"
              onClick={() => setMobilePreviewOpen(false)}
              className="absolute inset-0 z-20 bg-black/55"
            />
          )}
          <MobilePreviewPanel
            onClose={() => setMobilePreviewOpen(false)}
            onScreenshot={setPreviewAttachment}
            className={cn(
              previewAsDrawer
                ? "absolute inset-y-0 right-0 z-30 flex max-w-[88vw] shadow-2xl"
                : "static inset-auto z-auto max-w-none shadow-none flex",
            )}
          />
        </>
      )}

      {/* Large screen (>= 1180px): Tasks docks statically */}
      {isLargeScreen && tasksOpen && (
        <TasksPanel
          tasks={botTasks}
          emptyLabel="No tasks assigned to this agent yet."
          onClose={() => setTasksOpen(false)}
          className="flex"
        />
      )}
    </main>
  );
}
