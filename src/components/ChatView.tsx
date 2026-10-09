import { Component, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useCopyFeedback } from "@/lib/copy-text";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Bug,
  Copy,
  Crown,
  Download,
  Gauge,
  ListChecks,
  MessageSquareReply,
  Monitor,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Square,
  Webhook,
  X,
} from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { MessageActions, messageActionClass } from "@/components/MessageActions";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { computerStartLine } from "@/lib/computer-start";
import { useCaptionChrome, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { contextChip, contextDetail, contextShare, costCaption, formatUsd, hasFiniteCost, lastTurnDetail, usageChip, usageDetail } from "@/lib/usage";
import {
  api,
  currentTaskBot,
  useStore,
  formatTime,
  openNotificationTarget,
  openThread,
  visibleMessages,
  type Action,
  type Bot,
  type ConfigStatus,
  type InstanceInfo,
  type Message,
  type AppState,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL } from "./ChatGptPlanStatus";
import { openExternalLink } from "@/lib/app-links";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { failedTurnCause, signedOutEngine } from "@/lib/failed-turn";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { BotAvatar } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { normalizeState, stateForBot } from "@/lib/mascot";
import { peerLine, peerRequest, type PeerLine } from "@/lib/peer-message";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { ThreadChip } from "./ThreadChip";
import { VerifyCard } from "./VerifyCard";
import { askText, runSkill, runSteps, runSummary, showRun, skillPrompt } from "@/lib/verify-steps";
import { useShowRunCard } from "@/lib/run-card-preferences";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Composer } from "./Composer";
import { ChatErrorBanner } from "./ChatErrorBanner";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachmentGallery, collectMessageFiles, splitMessageAttachments } from "./AttachmentGallery";
import { ScreenFrame } from "./ScreenFrame";
import { CompactionChip, DigestChip } from "./DigestChip";
import { RenameTitle } from "./RenameTitle";
import { BotActivityPicker } from "./TaskPicker";
import { ModelPicker } from "./ModelPicker";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { ShortcutHint } from "./ShortcutHint";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import { CitationSelectionToolbar, SentCitations } from "./CitationUI";

import { SpeakButton } from "./SpeakButton";
import { CallOverlay } from "./CallView";
import { LiveCallBar } from "./LiveCallBar";
import { LiveCallChip } from "./LiveCallPill";
import { effectivePlace, toolPlace, type EffectivePlace } from "@/lib/place";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { groupTranscript, isStatusActivity } from "@/lib/activity-runs";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { ActivityRun } from "./ActivityRun";
import { TurnNarrationRun } from "./TurnNarrationRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { NewMessagesDivider } from "./NewMessagesDivider";
import { unreadMessageIds } from "@/lib/unread-divider";
import { appendComposerDraft, appendDraftAttachments, useReplyDraft } from "@/lib/drafts";
import { dayLabel, localDay, transcriptLookups, type TranscriptLookups } from "@/lib/transcript-derivations";
import { citationPreviewText, splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { highlightCitationSource } from "@/lib/citations-dom";
import { useCanWriteIn } from "@/lib/cloud-guest";
import { latestFailure, latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { pendingApprovals } from "./PendingApproval";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** What every row of the open chat reads besides its own message. The value
 * changes only when one of these does, so the memoized rows skip store
 * events that are not theirs: another bot's frame, a tool chip elsewhere in
 * the thread. The rosters keep their identity until a field a row draws
 * changes, the way ThreadRefsProvider keeps the thread list. */
interface ChatRows {
  botId: string;
  threadId: string;
  botName: string;
  voiceId?: string;
  /** Speech settings, for the read-aloud button. */
  tts: ConfigStatus["tts"];
  /** A paired Mac reads aloud with its own voices. That choice lives on the
   * device, not in the store, so it is read here once per store event. */
  localVoice: boolean;
  /** Editing, regenerating and switching versions wait for the turn. */
  busy: boolean;
  /** Every bot, for who wrote a relayed line or sits across a bot⇄bot chip. */
  bots: readonly Bot[];
  /** Every other bot, for @mentions. */
  mentionPeers: readonly Bot[];
  /** A search hit or jump target in this thread. */
  focus: AppState["focusMessage"];
  showToolCalls: boolean;
  /** Rows show catalog strings, so a language change re-renders them. */
  locale: string;
  dispatch: Dispatch<Action>;
  /** Whether a message is on the branch shown now (citation links). */
  onBranch: (messageId: string) => boolean;
}

const ChatRowsContext = createContext<ChatRows | null>(null);

function useChatRows(): ChatRows {
  const rows = useContext(ChatRowsContext);
  if (!rows) throw new Error("a chat row outside ChatView");
  return rows;
}

/** The fields of a bot that rows draw: its name and colour for @mentions,
 * its avatar for relayed lines and bot⇄bot chips. */
const drawnBot = (bot: Bot) =>
  [bot.id, bot.name, bot.hidden, bot.color, bot.mascotBody, bot.mascotExpression, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY].join("\u0001");

/** `bots`, holding the same array until a drawn field of one of them changes. */
function useDrawnBots(bots: readonly Bot[]): readonly Bot[] {
  const signature = bots.map(drawnBot).join("\u0002");
  const cache = useRef({ signature, bots });
  if (cache.current.signature !== signature) cache.current = { signature, bots };
  return cache.current.bots;
}

function DaySeparator({ at, today }: { at: number; today: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}

/** Hover/focus-revealed copy control shared by user + bot bubbles. Rooms use
 * the same button beside a message. */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const { state, copy } = useCopyFeedback(text);
  const label = t(state === "copied" ? "chat.copyMessageDone" : state === "failed" ? "chat.copyMessageFailed" : "chat.copyMessage");
  return (
    <button
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        state !== "idle" && "opacity-100",
        className,
      )}
    >
      {state === "copied" ? <Check size={14} className="text-success" /> : state === "failed" ? <X size={14} className="text-danger" /> : <Copy size={14} />}
    </button>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. When the headline is a plain sentence instead of the
 * engine's words (a signed-out engine, a Mac permission), those words stay
 * one click away under it. */
export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  /** A plain sentence to open with instead of `message` (FailedTurnRow's
   * signed-out line); `message` then moves under Details. */
  headline?: string;
  onRetry?: () => void;
  /** The one next action a failed place names (shared/place-view.ts), in
   * place of Retry; null for a place with nothing to do here. */
  action?: { label: string; onClick: () => void } | null;
  setupInstance?: InstanceInfo;
  /** The Claude engine to update when this turn failed because its Claude
   * Code is too old for the model. */
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    message.startsWith("CUA Driver is not ready for this computer — ") &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions)
    : null;
  const headline = macCuaReason ?? plainHeadline ?? message;
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{headline}</span>
        </div>
        {headline !== message && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{macCuaReason ? t("computer.mac.permission.driverDetail") : t("chat.error.details")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {message.includes("subscription_sharing_usage_limit_exceeded") ? (
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-app" onClick={(event) => {
            if (window.ogb?.openExternal) { event.preventDefault(); void openExternalLink(CHATGPT_USAGE_URL); }
          }}>{t("engineSetup.chatgpt.manageUsage")}</a>
        ) : claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline">About provider safety checks</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : action !== undefined ? (
          action && (
            <button
              type="button"
              onClick={action.onClick}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              {action.label}
            </button>
          )
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** A place that could not be used: its one line and its one next action
 * (shared/place-view.ts), never the provider's raw words or a second
 * button. Try again is the conversation's own retry, offered only where a
 * retry exists. */
function PlaceFailedRow({ place, botId, threadId, onRetry }: {
  place: PlaceRow;
  botId: string;
  threadId?: string;
  onRetry?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(state.config, capabilities.host.platform);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const view = placeRowViewFor(place, seat, worksOnSimpleLabel(bot?.computer, capabilities.host.platform));
  const id = view.action?.id;
  const onClick = !id ? undefined
    : id === "try-again" ? onRetry
    : () => { openPlaceAction(id, { botId, threadId }, dispatch); };
  return <ErrorRow message={view.line} action={view.action && onClick ? { label: view.action.label, onClick } : null} />;
}

/** Only a local, editable Claude Code engine can be updated from chat; a
 * company-managed one is the organisation's to update. */
export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}

/** A failed turn's stored row ("error: …", src/lib/failed-turn.ts), shown
 * the same in a 1:1 chat and a room: the server writes the same row for both,
 * so both read it here. `engine` is the one the turn ran on — what its
 * sign-in or update card acts on. A place that could not be used is worded
 * again from its stored state, in this reader's language and role. */
export function FailedTurnRow({ tool, engine, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  engine: InstanceInfo | undefined;
  onRetry?: () => void;
  /** The bot the turn ran as, and its conversation: where a place's next action goes. */
  botId?: string;
  threadId?: string;
}) {
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  const signedOut = signedOutEngine(tool, engine);
  return (
    <ErrorRow
      message={failedTurnCause(tool.name) ?? tool.name}
      headline={signedOut && t("chat.error.signedOut", { name: signedOut.displayName })}
      onRetry={onRetry}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. Rooms use the same boundary. */
export class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="chat-text w-fit max-w-[min(42rem,78%)] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
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
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          {t("common.cancel")}
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}

/** One message. Memoized: it renders when its own props change (the
 * message, whether it is pinned or being edited) or the chat's ChatRows do,
 * never for the rest of the store. The callbacks take the message they act
 * on, so every row shares the same ones. */
const Bubble = memo(function Bubble({
  message,
  emerging = false,
  eagerAttachments = false,
  editing,
  pinned,
  versions,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
}: {
  message: Message;
  emerging?: boolean;
  eagerAttachments?: boolean;
  editing: boolean;
  pinned: boolean;
  /** Every version of an edited question, oldest first; absent when it was never edited. */
  versions?: readonly Message[];
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (messageId: string, text: string) => void;
  /** Given to the last answer only. */
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, voiceId, tts, localVoice, busy, mentionPeers, focus, dispatch, onBranch } = useChatRows();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // A user-role line another bot delivered (ask_bot, delegate_bot,
  // start_thread) is that bot speaking, not the person: it takes the
  // bot side of the chat under the peer's name, with the model-facing
  // provenance note stripped from what the reader sees. A coordinate_bots
  // request is stored bot-role and gets the same label.
  const peer = peerLine(message) ?? peerRequest(message, botId);
  const user = message.role === "user" && !peer;
  const [expanded, setExpanded] = useState(false);
  const focusedSearch = focus?.messageId === message.id && Boolean(focus.matchText);
  const [viewRaw, setViewRaw] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === message.id && speech.status !== "idle";
  const text = peer ? peer.body : (message.text ?? "");
  const attached = useMemo(() => splitMessageAttachments(message.attachments), [message.attachments]);
  const generatedPaths = attached.images;
  const linkedFiles = useMemo(
    () => user ? [] : [...attached.files, ...collectMessageFiles(text, [...attached.images, ...attached.files.map((file) => file.path)])],
    [user, text, attached],
  );
  const voiceNotes = useMemo(
    () => message.attachments?.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio") ?? [],
    [message.attachments],
  );
  const webhookView = user ? webhookMessageView(text) : null;
  const cited = user && !webhookView ? splitTranscriptCitations(text) : null;
  const attachments = user && !webhookView ? splitTranscriptAttachments(cited?.display ?? text) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const hasAttachments = Boolean(cited?.citations.length || (attachments && (attachments.images.length || attachments.files.length)));
  // A message that is only attachments is just the files: no bubble around them.
  const attachmentsOnly = !webhookView && !replyTarget && !visibleText.trim() &&
    (user ? hasAttachments : generatedPaths.length + linkedFiles.length > 0);
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);
  useEffect(() => {
    if (focusedSearch && collapsible) setExpanded(true);
  }, [focusedSearch, collapsible, focus?.nonce]);

  if (user && editing && !webhookView && !hasAttachments) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={(edited) => onSubmitEdit(message.id, edited)} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const forks = user && versions ? versions : [message];
  const versionIndex = forks.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    // an edit still waiting for its server fork has no branch to switch to yet
    if (v && !busy && !v.id.startsWith("optimistic-")) dispatch({ type: "switchBranch", botId, threadId, messageId: v.id });
  };
  const togglePin = () =>
    dispatch({ type: "updateTask", botId, threadId, patch: { pinnedMessageId: pinned ? "" : message.id } });

  return (
    <div className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      {peer && <PeerLabel peer={peer} />}
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user">
            {/* editing rewinds the thread, so it waits for the turn to end —
                same rule as the version switcher below */}
            {message.kind === "text" && !webhookView && !hasAttachments && !busy && !message.id.startsWith("optimistic-") && (
              <button
                onClick={() => onStartEdit(message.id)}
                aria-label={t("chat.editMessage")}
                title={t("chat.editMessage")}
                className={messageActionClass}
              >
                <Pencil size={14} />
              </button>
            )}
            {Boolean(visibleText.trim()) && <CopyButton text={visibleText} className="opacity-100" />}
            <button
              type="button"
              onClick={() => onReply(message)}
              aria-label={t("chat.replyToMessage")}
              title={t("chat.reply")}
              className={messageActionClass}
            >
              <MessageSquareReply size={14} />
            </button>
            <button
              onClick={togglePin}
              aria-label={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
              title={pinned ? t("chat.unpinHint") : t("chat.pinHint")}
              className={cn(messageActionClass, remoteClient && "hidden")}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </MessageActions>
        )}
        <div
          data-chat-bubble
          className={cn(
            "w-fit max-w-[min(42rem,78%)] rounded-2xl text-[15px] leading-relaxed",
            emerging && "turn-answer",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : attachmentsOnly
                ? "text-ink"
                : user
                  ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                  : "bg-card px-4 py-2.5 text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={botName}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>{t("chat.webhookTask")}</span>
              </div>
              <div className="chat-text px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">{t("chat.viewPayload")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachments && <AttachmentGallery images={attachments.images} files={attachments.files} message={{ threadId, messageId: message.id }} eager={eagerAttachments} className={!visibleText ? "mb-0" : undefined} />}
              {visibleText && (
                <div
                  className={cn("chat-text", collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                  data-citation-source={message.id}
                  data-citation-owner-type="bot"
                  data-citation-owner={botId}
                  data-citation-thread={threadId}
                >
                  <ThreadRefText text={visibleText} peers={mentionPeers} />
                </div>
              )}
              {cited && <SentCitations
                citations={cited.citations}
                onNavigate={async (citation: CitationAttachment) => {
                  if (citation.source.ownerType !== "bot" || !onBranch(citation.source.messageId)) return false;
                  dispatch({ type: "focusMessage", threadId, messageId: citation.source.messageId });
                  return highlightCitationSource(citation);
                }}
              />}
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.sentMidTurnHint")}>
                  {t("chat.sentMidTurn")}
                </div>
              )}
              {message.via === "call" && (
                <span className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.viaCall")}>
                  {t("chat.viaCall")}
                </span>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary key={viewRaw ? "raw" : "rendered"} fallbackText={text || t("chat.generatedImage")}>
              {voiceNotes.length > 0 && (
                <div className={cn("flex flex-col", (text || generatedPaths.length > 0 || linkedFiles.length > 0) && "mb-2")}>
                  {voiceNotes.map((note) => (
                    <VoiceNoteBubble key={note.path} attachment={note} />
                  ))}
                </div>
              )}
              <AttachmentGallery images={generatedPaths} files={linkedFiles} message={{ threadId, messageId: message.id }} className={text ? undefined : "mb-0"} eager={eagerAttachments} />
              {viewRaw && text ? (
                <div data-citation-source={message.id} data-citation-owner-type="bot" data-citation-owner={botId} data-citation-thread={threadId}><RawMarkdownView text={text} /></div>
              ) : text ? (
                <div data-citation-source={message.id} data-citation-owner-type="bot" data-citation-owner={botId} data-citation-thread={threadId}><ChatMarkdown text={text} mentionPeers={mentionPeers} message={{ threadId, messageId: message.id }} /></div>
              ) : null}
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <MessageActions side="bot" forceOpen={viewRaw || speaking}>
            {text && <CopyButton text={text} className="opacity-100" />}
            {text && <RawToggleAction active={viewRaw} onToggle={() => setViewRaw((r) => !r)} className="opacity-100" />}
            {message.kind === "text" && text && !peer && (
              <SpeakButton text={text} botId={botId} messageId={message.id} voiceId={voiceId} tts={tts} localVoice={localVoice} className="opacity-100" />
            )}
            {!busy && onRegenerate && (
              <button
                onClick={onRegenerate}
                aria-label={t("chat.regenerate")}
                title={t("chat.regenerate")}
                className={messageActionClass}
              >
                <RefreshCw size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={() => onReply(message)}
              aria-label={t("chat.replyToMessage")}
              title={t("chat.reply")}
              className={messageActionClass}
            >
              <MessageSquareReply size={14} />
            </button>
            <button
              onClick={togglePin}
              aria-label={pinned ? t("chat.unpinMessage") : t("chat.pinMessage")}
              title={pinned ? t("chat.unpinHint") : t("chat.pinHint")}
              className={cn(messageActionClass, remoteClient && "hidden")}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </MessageActions>
        )}
        <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-tertiary opacity-0 transition-opacity group-hover:opacity-100",
            user ? "order-first mr-2" : "ml-2",
          )}
        >
          {formatTime(message.at)}
        </span>
      </div>
      {forks.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(forks[versionIndex - 1])}
            disabled={versionIndex <= 0 || busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.previousVersion")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{forks.length}
          </span>
          <button
            onClick={() => switchTo(forks[versionIndex + 1])}
            disabled={versionIndex >= forks.length - 1 || busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.nextVersion")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
});

/** Who wrote a relayed line and how it arrived, above the bubble — the
 * same shape as a room's cluster label. Looked up by id, then by name for
 * rows that predate Message.peerAsk; a peer since renamed or deleted still
 * shows the name the line carries. Renders with its bubble. */
function PeerLabel({ peer }: { peer: PeerLine }) {
  const { bots } = useChatRows();
  const author =
    bots.find((b) => b.id === peer.botId) ?? bots.find((b) => b.name === peer.name);
  const how =
    peer.delivery === "delegate_bot"
      ? t("chat.peer.delegated")
      : peer.delivery === "start_thread"
        ? t("chat.peer.openedThread")
        : peer.delivery === "coordinate_bots"
          ? t("chat.peer.requested")
          : t("chat.peer.asked");
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-testid="peer-label">
      <BotAvatar
        bot={author ?? { name: peer.name, color: "blue" }}
        state={normalizeState(author?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{peer.name}</span>
      <span className="text-[11px] text-ink-tertiary">· {how}</span>
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
const ActivityChip = memo(function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { bots, dispatch } = useChatRows();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    const withBot = bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("chat.openConversationWith", { name: comm.withName })}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  return <ToolActivity tool={tool} place={toolPlace(tool.name, place)} />;
});

/** A routine run's receipt. It opens the run's own thread, so it follows
 * the whole store to know whether that thread is still there. */
function RoutineRunRow({ message, botId }: { message: Message; botId: string }) {
  const { state, dispatch } = useStore();
  const executionThreadId = message.routineRun?.executionThreadId;
  const canOpen = executionThreadId && state.bots.some((candidate) =>
    candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
  );
  return (
    <RoutineRunCard
      message={message}
      onOpen={canOpen && executionThreadId
        ? () => openNotificationTarget(dispatch, { botId, threadId: executionThreadId }, state)
        : undefined}
    />
  );
}

/** A conversation with nothing in it yet: who it is with, and a prompt. */
function EmptyChat({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const advanced = useAdvancedMode();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <BotAvatar bot={bot} state="idle" size={64} motion="none" motionKey={0} />
      {/* Simple mode renames in the bot's settings only. */}
      {!advanced ? <div className="text-[17px] font-semibold text-ink">{bot.name}</div> : <RenameTitle
        value={bot.name}
        onCommit={(name) => {
          if (window.ogb?.remoteClient?.active) {
            void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
              .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
              .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
          } else {
            dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
          }
        }}
        className="text-[17px] font-semibold text-ink"
        inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
      />}
      <div className="max-w-[360px] text-[14px] text-ink-secondary">
        {bot.description || t("chat.emptyPrompt")}
      </div>
    </div>
  );
}

/** The settled transcript, memoized as one unit: it renders when any
 * message on the branch or the chat's ChatRows change. Each row inside is
 * memoized on its own message, so a patched tool chip renders that chip and
 * nothing else. */
const MessagesList = memo(function MessagesList({
  messages,
  transcript,
  lookups,
  place,
  pinnedMessageId,
  today,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  unreadDividerId,
  unreadDividerFading,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
}: {
  messages: Message[];
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  lookups: TranscriptLookups;
  /** Where this conversation works, for the place icon on screen and page tools. */
  place: EffectivePlace;
  pinnedMessageId?: string;
  /** localDay of now: Today and Yesterday move on at midnight. */
  today: number;
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  /** The New divider goes above the row holding this message. */
  unreadDividerId: string | null;
  unreadDividerFading: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, focus, showToolCalls, locale } = useChatRows();
  // Finished tool chips become compact runs; settled assistant narration
  // becomes one reversible turn row while the terminal answer stays visible.
  // The locale refreshes the turn labels when the language changes.
  const items = useMemo(() => groupTranscript(messages), [messages, locale]);
  const newestMessageId = messages.at(-1)?.id;
  let newestUserMessageId: string | undefined;
  for (let i = messages.length - 1; i >= 0 && !newestUserMessageId; i--) {
    if (messages[i]!.role === "user") newestUserMessageId = messages[i]!.id;
  }
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focusedId = focus && !focus.consumed ? focus.messageId : null;
  const unreadIds = useMemo(() => unreadMessageIds(messages, unreadDividerId), [messages, unreadDividerId]);
  let dividerPlaced = false;
  const dividerAbove = (rows: readonly Message[]) => {
    if (!unreadIds || dividerPlaced || !rows.some((row) => unreadIds.has(row.id))) return null;
    dividerPlaced = true;
    return <NewMessagesDivider fading={unreadDividerFading} />;
  };
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
        const first = item.kind === "message" ? item.message : item.messages[0];
        const newDay = !prev || localDay(prev.at) !== localDay(first.at);
        const divider = dividerAbove(item.kind === "message" ? [item.message] : item.messages);
        if (item.kind === "turn") {
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} today={today} />}
              {divider}
              <TurnNarrationRun
                label={item.label}
                forceOpen={item.messages.some((message) => message.id === focusedId)}
              >
                {item.messages.map((message) => (
                  <div key={message.id} className="contents" data-mid={message.id}>
                    <Bubble
                      message={message}
                      editing={false}
                      pinned={message.id === pinnedMessageId}
                      onStartEdit={onStartEdit}
                      onCancelEdit={onCancelEdit}
                      onSubmitEdit={onSubmitEdit}
                      replyTarget={lookups.replyTarget(message)}
                      onReply={onReply}
                    />
                  </div>
                ))}
              </TurnNarrationRun>
            </div>
          );
        }
        if (item.kind === "run") {
          // Hidden steps still carry the divider: the reply under them is new.
          if (!showToolCalls) return divider && <div key={item.id} className="contents">{divider}</div>;
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} today={today} />}
              {divider}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityChip message={step} place={place} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          switch (m.kind) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={botId} threadId={threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={botId} threadId={threadId} message={m} /> : null;
            case "options": {
              // a live permission ask gets the approval box; a structured
              // ask gets the question box; anything else keeps the list
              // card. The first-run quiz drops out once they talk.
              // Cards are bot-authored and persisted, so one that will not
              // draw must fall back to its text on every open, not take the
              // whole page down every time this chat is selected.
              const card = m.card?.requestId && m.card.questionRequest ? (
                <QuestionCard threadId={threadId} bot={{ name: botName }} message={m} />
              ) : m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={{ name: botName }} message={m} threadId={threadId} />
              ) : shouldHideOnboardingCard(m, transcript) ? null : (
                <OptionCard botId={botId} threadId={threadId} message={m} />
              );
              if (!card) return null;
              return (
                <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
                  {card}
                </MessageBoundary>
              );
            }
            case "routine.run":
              return <RoutineRunRow message={m} botId={botId} />;
            case "activity": {
              if (isStatusActivity(m)) return <StatusActivityRow message={m} />;
              // a failed turn is an error, not a tool run — render it as one.
              // bot⇄bot comm chips and opened-thread chips stay because they
              // link to another conversation.
              // plain tool runs stay out unless Settings → Tool calls is on.
              if (m.tool && failedTurnCause(m.tool.name) !== null) {
                return (
                  <FailedTurnRow
                    tool={m.tool}
                    engine={engine}
                    botId={botId}
                    threadId={threadId}
                    onRetry={m.id === lookups.retryableId && canRetryLast ? onRegenerate : undefined}
                  />
                );
              }
              if (!showToolCalls && !m.comm && !m.threadRef) return null;
              return <ActivityChip message={m} place={place} />;
            }
            case "digest":
              // the summary of the turn's tool chips: shown under the same setting
              return showToolCalls ? <DigestChip message={m} /> : null;
            case "compaction":
              return <CompactionChip message={m} />;
            case "screen":
              return <ScreenFrame threadId={threadId} message={m} />;
            default:
              return (
                <Bubble
                  message={m}
                  emerging={m.id === emergingId}
                  eagerAttachments={m.id === newestMessageId || m.id === newestUserMessageId}
                  editing={editingId === m.id}
                  pinned={m.id === pinnedMessageId}
                  versions={lookups.editVersions(m)}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
                  // only the last answer offers Regenerate; the others keep
                  // their props when this callback changes
                  onRegenerate={m.id === lastBotTextId ? onRegenerate : undefined}
                  replyTarget={lookups.replyTarget(m)}
                  onReply={onReply}
                />
              );
          }
        })();
        if (!row) return divider && <div key={m.id} className="contents">{divider}</div>;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} today={today} />}
            {divider}
            {row}
          </div>
        );
      })}
    </>
  );
});

/** The one pinned message, above the transcript: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin?: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const pinnedPeer = peerLine(pinned);
  const sender =
    pinned.role === "user" ? (pinnedPeer?.name ?? t("chat.you")) : (pinned.from?.name ?? bot.name);
  const text = citationPreviewText(pinnedPeer?.body ?? pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={t("chat.pinnedJump")}
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span dir="auto" className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        {onUnpin && <button
          onClick={onUnpin}
          aria-label={t("chat.unpinMessage")}
          title={t("chat.unpin")}
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>}
      </div>
    </div>
  );
}

/** The chat header's bot pill: the model chip's shape and tint. */
const CHATHEAD_PILL = "flex min-w-0 items-center gap-2 rounded-full border border-hairline/40 bg-control/60 py-0.5 pl-1.5 text-ink";

function chiefOfStaffBadge(bot: Bot) {
  if (!bot.chiefOfStaff) return null;
  // One line, never shrinking with the name (it wrapped "Chief / of /
  // Staff", #1871); folds to the crown like the chips beside it do, so the
  // name keeps the room.
  return (
    <span title={t("chat.chiefOfStaff")} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent @max-4xl/chathead:px-1.5">
      <Crown size={11} aria-hidden="true" /> <span className="@max-4xl/chathead:sr-only">{t("chat.chiefOfStaff")}</span>
    </span>
  );
}

export function ChatView({ bot: profile }: { bot: Bot }) {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // Simple mode reaches other threads from the sidebar; the header picker is Advanced only.
  // Windows has no native caption buttons (renderer-drawn, see
  // WindowCaptionButtons); this header is the window drag region, and the
  // icon row shifts below the 26px-tall corner the buttons occupy.
  const { dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const advanced = useAdvancedMode();
  // A guest on an OMB Cloud home writes only in conversations it opened.
  const canWrite = useCanWriteIn(bot.threadId);

  const computerStarting = computerStartLine(state.computerStarts[bot.id], bot.name);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // only the active branch is rendered; forks stay reachable via ‹ › nav.
  // Keyed on the transcript alone: a bot frame that leaves it untouched
  // keeps this array, and the rows memoized on it.
  const { messages: allMessages, activeLeafId } = bot;
  const messages = useMemo(() => visibleMessages({ messages: allMessages, activeLeafId }), [allMessages, activeLeafId]);
  // edit versions, reply targets, the Retry row: once per list, not per row
  const lookups = useMemo(() => transcriptLookups(allMessages, messages), [allMessages, messages]);
  // The bot's run in the current ask — every command it ran, the control-CLI
  // ones verified — for the run card. Saving mirrors the /learn gate: the
  // flag, an engine with the agents tools, and a bot that can take a message
  // now — plus a run with something to keep.
  const recordedRun = useMemo(() => runSteps(messages), [messages]);
  const recordedRunCounts = runSummary(recordedRun);
  const engineSupportsAgents = Boolean(
    state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp,
  );
  const canSaveRun =
    skillAuthoringEnabled(state.config) && engineSupportsAgents && recordedRunCounts.passed > 0 && recordedRunCounts.running === 0 && !bot.busy;
  // A dismissal is pinned to the run's last step, per thread: the card comes
  // back when the bot runs another command, not merely when a step settles,
  // and stays away across a switch to another thread and back.
  const [runDismissed, setRunDismissed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const lastRunStep = recordedRun.at(-1);
  const showRunCard = useShowRunCard();

  // Only a tail of the thread mounts; everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const {
    scrollRef,
    transcriptRef,
    transcriptKey,
    following,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showEarlier,
    showLater,
    loadOlder,
    jumpToLatest,
    scrollHandlers,
  } = useTranscriptViewport({
    ownerId: bot.id,
    threadId: bot.threadId,
    messages,
    pinOn: [bot.busy, composerDock.pad],
  });

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );
  const unreadDivider = useUnreadDivider({ threadId: bot.threadId, messages, following });

  // What the rows read besides their own message (see ChatRows).
  const bots = useDrawnBots(state.bots);
  const mentionPeers = useMemo(() => bots.filter((peer) => peer.id !== bot.id), [bots, bot.id]);
  const focus = state.focusMessage?.threadId === bot.threadId ? state.focusMessage : null;
  const showToolCalls = showToolCallsEnabled(state.config);
  const tts = state.config?.tts;
  const localVoice = localSystemVoiceActive();
  const locale = activeLocale();
  const busy = Boolean(bot.busy);
  // The header face moves only while the bot works or plays a motion beat,
  // as in the sidebar: a resting face left open would redraw at display rate.
  const headerAnimated = busy || (mascotMotion?.kind ?? "none") !== "none";
  // read when a citation is clicked, so the rows need not change per message
  const branch = useRef(messages);
  branch.current = messages;
  const onBranch = useCallback((messageId: string) => branch.current.some((m) => m.id === messageId), []);
  const rows = useMemo<ChatRows>(
    () => ({ botId: bot.id, threadId: bot.threadId, botName: bot.name, voiceId: bot.voice, tts, localVoice, busy, bots, mentionPeers, focus, showToolCalls, locale, dispatch, onBranch }),
    [bot.id, bot.threadId, bot.name, bot.voice, tts, localVoice, busy, bots, mentionPeers, focus, showToolCalls, locale, dispatch, onBranch],
  );
  // Where this conversation works, for the place icon on screen and page tools.
  const place = effectivePlace(bot, bot.tasks?.find((task) => task.threadId === bot.threadId));

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId, text });
    },
    [bot.id, bot.threadId, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text" && !peerLine(m)),
    [messages],
  );
  const lastUserMessageHasAttachments = useMemo(() => {
    if (!lastUserMessage?.text) return false;
    const cited = splitTranscriptCitations(lastUserMessage.text);
    const attached = splitTranscriptAttachments(cited.display);
    return cited.citations.length > 0 || attached.images.length > 0 || attached.files.length > 0;
  }, [lastUserMessage]);

  // Mascot while the turn works. Streaming stays invisible — when the reply
  // is finished, the whole bubble pops in above the mascot.
  const lastMessage = messages.at(-1);
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined;
  const activityLabel = liveActivityLabel(lastMessage);
  const waiting = Boolean(
    bot.busy &&
      bot.activity !== "waiting-on-you" &&
      showWorkingDots(bot.busy, lastMessage),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<string | null>(null);
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [bot.id]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    const messageId = lastMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    setPopping(messageId);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current === messageId ? null : current);
    }, 520);
  }, [lastMessage?.id, lastMessage?.role, lastMessage?.kind]);
  const presenceVisible = waiting || popping !== null;
  const announcement = useMemo((): TranscriptSnapshot => {
    const approval = pendingApprovals(messages)[0];
    return {
      busy: Boolean(bot.busy),
      reply: latestReply(messages, () => bot.name),
      failure: latestFailure(messages, () => bot.name),
      approval: approval ? { id: approval.requestId, name: bot.name } : undefined,
    };
  }, [messages, bot.busy, bot.name]);
  // Wall-clock anchor for the working row's elapsed readout — the server
  // stamps the turn's real start (turnStartedAt), so switching threads keeps
  // the count truthful; Date.now() only covers servers without the stamp.
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(bot.busy ? bot.turnStartedAt ?? Date.now() : null);
  }, [bot.busy, bot.id, bot.threadId, bot.turnStartedAt]);

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy && !lastUserMessage.id.startsWith("optimistic-")) {
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, bot.threadId, dispatch]);

  const routineExecution = state.routineRuns.find((run) => run.target === "bot" && run.botId === bot.id && run.threadId === bot.threadId);
  const resultsThreadId = routineExecution?.resultsThreadId ?? routineExecution?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* A take-turns call covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* The transcript scrolls on under the header (and the banners that
          hang from it), which is liquid glass tinted with the chat's own
          background, and under the composer, which already floats. */}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* Above anything raised inside the transcript (the room set-up card
          is z-20 so its menus clear the composer), below the CallOverlay (z-30). */}
      <GlassBar edge="top" className="z-[25]">
      {/* Header */}
      <div
        style={headerDragStyle}
        className={cn(
          // @container so the chips on the right can fold to icon bubbles
          // when the column is narrow (side panel open, small window). A
          // container query never matches the container itself, so the row
          // that has to wrap is the child below, not this element.
          "@container/chathead px-5 py-3",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        {/* The chip group does not shrink, so in a narrow column (a phone,
            or a panel beside the chat) the name truncated to nothing and the
            rename pencil landed under the export button. Below 30rem the
            header wraps: name line on top, chips underneath on the right.
            From 30rem the bot sits in the middle of the header: three
            columns, the left one empty, so the name is centred on the chat
            itself. The controls' column never goes below their own width;
            when room is short it takes it from the empty side, which slides
            the name left rather than under the controls. */}
        <div data-chathead-row className="flex items-center justify-between @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:gap-y-1 @min-[30rem]/chathead:grid @min-[30rem]/chathead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]">
        <div data-chathead-identity className="flex min-w-0 items-center gap-2 @max-[30rem]/chathead:basis-full @min-[30rem]/chathead:col-start-2 @min-[30rem]/chathead:justify-self-center" style={headerNoDragStyle}>
          {/* The bot as one pill, the same shape as the model chip across the
              header: avatar and name together, opening the bot's settings.
              Simple mode makes the whole pill that one button; Advanced keeps
              the rename pencil inside it, so the avatar and the name stay
              their own buttons (a button cannot hold another). */}
          {advanced ? (
            <div data-chathead-pill className={cn(CHATHEAD_PILL, "pr-1")}>
              <button
                type="button"
                onClick={() => dispatch({ type: "toggleSettings", open: true })}
                className="flex shrink-0 items-center justify-center rounded-full"
                title={t("chat.openProfile")}
                aria-label={t("chat.openProfileAria", { name: bot.name })}
              >
                <BotAvatar
                  bot={bot}
                  state={stateForBot({ ...bot, messages })}
                  size={24}
                  motion={mascotMotion?.kind ?? "none"}
                  motionKey={mascotMotion?.nonce ?? 0}
                  animated={headerAnimated}
                />
              </button>
              <RenameTitle
                value={bot.name}
                onCommit={(name) => {
                  if (window.ogb?.remoteClient?.active) {
                    void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
                      .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
                      .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
                  } else {
                    dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
                  }
                }}
                onActivate={() => dispatch({ type: "toggleSettings", open: true })}
                showEditButton
                className="truncate text-[14px] font-semibold text-ink"
                editButtonClassName="size-6 rounded-full"
                inputClassName="max-w-[220px] rounded-full bg-inset px-2 py-0.5 text-[14px] font-semibold"
              />
              {chiefOfStaffBadge(bot)}
              {bot.busy && <WorkingDots className="pr-2 text-ink-secondary" />}
            </div>
          ) : (
            <button
              type="button"
              data-chathead-pill
              onClick={() => dispatch({ type: "toggleSettings", open: true })}
              title={t("chat.openProfile")}
              aria-label={t("chat.openProfileAria", { name: bot.name })}
              className={cn(CHATHEAD_PILL, "pr-3.5 hover:bg-raised-hover")}
            >
              <BotAvatar
                bot={bot}
                state={stateForBot({ ...bot, messages })}
                size={24}
                motion={mascotMotion?.kind ?? "none"}
                motionKey={mascotMotion?.nonce ?? 0}
                animated={headerAnimated}
              />
              <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{bot.name}</span>
              {chiefOfStaffBadge(bot)}
              {bot.busy && <WorkingDots className="text-ink-secondary" />}
            </button>
          )}
          {!bot.busy && bot.waitingForTeammates && <span className="truncate text-[12px] text-ink-secondary" role="status">Teammates working</span>}
        </div>
        <div
          data-chathead-controls
          className="flex shrink-0 items-center gap-2 @max-[30rem]/chathead:ml-auto @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:justify-end @min-[30rem]/chathead:col-start-3 @min-[30rem]/chathead:justify-self-end"
          // The caption buttons sit over the header's right end; drop this
          // icon row 16px (visual only — the header keeps its height) so the
          // buttons clear the 26px overlay while the rest of the layout stays.
          style={controlsShiftStyle}
        >
          {(bot.busy || bot.waitingForTeammates) && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
                COMPACT_BUBBLE,
              )}
              title={t("chat.stopTurn")}
            >
              <Square size={12} className="fill-current" />
              <span className="@max-4xl/chathead:hidden">{t("chat.stop")}</span>
            </button>
          )}
          {!remoteClient && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} />}
          {/* below md the sidebar (and its Live call pill) is hidden */}
          <LiveCallChip currentBotId={bot.id} onOpen={(botId, threadId) => openThread(dispatch, { botId, threadId }, state)} />
          <button
            data-tour="computer"
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")}
          >
            <Monitor size={18} />
          </button>
          {/* Keep threads reachable even when the sidebar is collapsed.
              Less frequent actions share one menu. */}
          <ChatHeaderMenu key={`menu:${bot.threadId}`} bot={bot} messages={messages} findOpen={findOpen} onFind={() => setFindOpen((open) => !open)} />
        </div>
        </div>
      </div>

      <BotActivityPicker bot={bot} />
      {routineExecution && <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">{t("routines.executionDetails", { name: routineExecution.routineName })}</span>
        {canOpenResults && resultsThreadId && <button type="button" onClick={() => openNotificationTarget(dispatch, { botId: bot.id, threadId: resultsThreadId }, state)} className="rounded px-2 py-1 text-accent hover:bg-raised">{t("routines.results.back")}</button>}
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", routineId: routineExecution.routineId, botId: bot.id })} className="rounded px-2 py-1 hover:bg-raised hover:text-ink">{t("routines.logs")}</button>
      </div>}
      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      <ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />
      {state.notice && (
        <div className="w-full px-5">
          <div role="status" className="mb-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
            {state.notice.botName ? t("thread.goneShowing", { name: state.notice.botName }) : t("thread.gone")}
          </div>
        </div>
      )}

      {/* Pinned message banner */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={remoteClient ? undefined : () =>
          dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { pinnedMessageId: "" } })
        }
      />


      </GlassBar>

      {/* Messages + composer share one pane so bubbles scroll into the pill
          instead of dying on a rectangular clip above a black dock. */}
      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 [overflow-anchor:none]"
        {...scrollHandlers}
      >
        <div
          ref={transcriptRef}
          className="glass-scroller-content flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          // off: a polite log re-reads every tick and chip while the bot
          // works; TranscriptAnnouncer below speaks once when it is done
          aria-live="off"
          aria-label={t("chat.conversationWith", { name: bot.name })}
        >
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showEarlier", { count: hiddenCount })}
              </button>
            </div>
          ) : bot.hasMore ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={loadOlder}
                disabled={olderPending}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
              >
                {olderPending ? t("chat.loadingEarlier") : t("chat.loadEarlier")}
              </button>
            </div>
          ) : null}
          {windowedMessages.length === 0 && !bot.busy && <EmptyChat bot={bot} />}
          <ChatRowsContext.Provider value={rows}>
            <MessagesList
              messages={windowedMessages}
              transcript={messages}
              lookups={lookups}
              place={place}
              pinnedMessageId={bot.pinnedMessageId}
              today={localDay(Date.now())}
              editingId={editingId}
              lastBotTextId={lastBotTextId}
              emergingId={popping}
              canRetryLast={!bot.busy && Boolean(lastUserMessage)}
              engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
              unreadDividerId={unreadDivider.messageId}
              unreadDividerFading={unreadDivider.fading}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSubmitEdit={submitEdit}
              onRegenerate={regenerate}
              onReply={selectReply}
            />
          </ChatRowsContext.Provider>
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {computerStarting && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <WorkingDots size={3.5} />
                {computerStarting}
              </div>
            </div>
          )}
          <TurnPresence
            avatar={
              // BotAvatar, not a bare MausAvatar: an uploaded profile image
              // (and a chosen mascot body) must match the sidebar row.
              <BotAvatar
                bot={bot}
                state={toolInFlight ? "working" : "thinking"}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={presenceVisible}
            label={activityLabel}
            answering={popping !== null}
            since={busySince}
          />
        </div>
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!following && (
        <button
          onClick={jumpToLatest}
          aria-label={t("chat.jumpToLatestAria")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      {/* Keyed by task: each conversation keeps its own draft and a failed
          request can restore the old task without spilling into the newly
          selected one. ArrowUp-to-edit stays gated on busy because editing
          rewinds the thread, which a live turn forbids (the server 409s it). */}
      <div ref={composerDockRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-[2]">
      {/* The bot's run in this ask as a checklist, once it is worth one (a
          verified step, or more than one command). Save fills this thread's
          composer with the run and the person's request and hands the caret
          over; the person adds context and sends — nothing is sent from
          here. In the dock so its height is measured with the composer's:
          the transcript pad, the jump pill and bottom-follow all move with
          it. */}
      {lastRunStep && showRun(recordedRun) && showRunCard && runDismissed.get(transcriptKey) !== lastRunStep.id && (
        <div className="flex justify-end px-5 pb-2">
          <VerifyCard
            key={transcriptKey}
            steps={recordedRun}
            canSave={canSaveRun}
            skill={runSkill(messages, recordedRun)}
            onDismiss={() => setRunDismissed((current) => new Map(current).set(transcriptKey, lastRunStep.id))}
            onSave={() => {
              appendComposerDraft(`bot:${bot.id}:${bot.threadId}`, skillPrompt(recordedRun, askText(messages)));
              composerDockRef.current?.querySelector("textarea")?.focus();
            }}
          />
        </div>
      )}
      {/* A Live call on this chat: its controls and captions sit above the
          composer so the transcript stays in view. In the dock, so the
          transcript pad grows with it. */}
      <LiveCallBar bot={bot} />
      {canWrite === false ? (
        <NewConversationInstead onNew={() => dispatch({ type: "newTask", botId: bot.id })} />
      ) : (
      <Composer
        key={bot.threadId}
        bot={profile}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
        onEditLast={lastUserMessage && !lastUserMessageHasAttachments && !bot.busy && !lastUserMessage.id.startsWith("optimistic-")
          ? () => setEditingId(lastUserMessage.id)
          : undefined}
      />
      )}
      {canWrite !== false && (
      <CitationSelectionToolbar
        key={`${bot.id}:${bot.threadId}`}
        viewportRef={scrollRef}
        onAdd={(citation) => appendDraftAttachments(`bot:${citation.source.ownerId}:${citation.source.threadId}`, [citation])}
      />
      )}
      </div>
      </GlassScrollFrame>

    </main>
  );
}

/** In place of the composer, for a guest on an OMB Cloud home in a
 * conversation it did not open: it can only start its own. One click, no
 * dialog. */
export function NewConversationInstead({ onNew }: { onNew: () => void }) {
  return (
    <div className="pointer-events-auto mx-5 mb-4 flex items-center justify-between gap-3 rounded-2xl border border-hairline/60 bg-raised px-4 py-3" data-testid="cloud-guest-composer">
      <p className="text-[13px] text-ink-secondary">{t("chat.cloudGuest.notYours")}</p>
      <button type="button" onClick={onNew} className="shrink-0 rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white">
        {t("chat.cloudGuest.newConversation")}
      </button>
    </div>
  );
}

/** The thread's usage, folded to one figure for the header menu — cost when
 * the engine reports one, else new tokens — with the full breakdown as the
 * tooltip. Null while the thread has no usage yet. */
function usageSummary(bot: Bot, instances: AppState["instances"]): { short: string; detail: string; tone?: "danger" | "warning" } | null {
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  if (!usage || !usageChip(usage)) return null;
  const billing = instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const share = contextShare(usage);
  const detail = [
    usage.turns === 1 ? t("chat.usage.turnsOne") : t("chat.usage.turnsMany", { count: usage.turns }),
    usageDetail(usage),
    lastTurnDetail(usage),
    contextDetail(usage),
    // the whole thread rides along on every turn, so most of "in" is the
    // model re-reading what it already saw — say so, or the figure reads as
    // a bug (issue #527); past 80% of the window the fix is a new thread
    share?.tone === "danger" ? t("chat.usage.contextNudge") : null,
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  // Keep the unit visible in the compact header too.
  const short = usageChip(usage);
  const ctx = contextChip(usage);
  return { short: ctx ? `${short} · ${ctx}` : short, detail, tone: share?.tone === "danger" ? "danger" : share?.tone === "warning" ? "warning" : undefined };
}

/** The header's "more" menu: find, export, usage and the inspector, behind
 * one button that opens on hover. */
function ChatHeaderMenu({ bot, messages, findOpen, onFind }: {
  bot: Bot;
  messages: readonly Message[];
  findOpen: boolean;
  onFind: () => void;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const usage = usageSummary(bot, state.instances);
  // Simple mode keeps these in sight but locked, so people know where they
  // live without being handed builder tools by default.
  const advanced = useAdvancedMode();
  const advancedOnly = advanced ? undefined : t("chat.advancedOnly");
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const hasMessages = messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: bot.name, messages, botName: bot.name, isGroup: false });
  const items: SidebarMenuItem[] = [
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      active: findOpen,
      trailing: <ShortcutHint id="find-conversation" />,
      onSelect: onFind,
    },
    {
      key: "copy",
      heading: t("chat.export.heading"),
      separatorBefore: true,
      label: t("chat.export.copy"),
      icon: <Copy size={16} />,
      disabled: !hasMessages,
      keepOpen: true,
      trailing: copyStatus && <span role="status" className="text-[11px] text-ink-secondary">{t(copyStatus === "copied" ? "chat.export.copied" : "chat.export.copyFailed")}</span>,
      onSelect: () => { void copyTranscriptToClipboard(transcript()).then((ok) => setCopyStatus(ok ? "copied" : "failed")); },
    },
    {
      key: "download",
      label: t("chat.export.download"),
      icon: <Download size={16} />,
      disabled: !hasMessages,
      onSelect: () => downloadMarkdownTranscript(slugifyTranscriptFilename(bot.name), transcript()),
    },
    ...(usage ? [{
      key: "usage",
      label: t("chat.usage.menu"),
      icon: <Gauge size={16} />,
      separatorBefore: true,
      heading: advancedOnly,
      disabled: !advanced,
      trailing: <span title={usage.detail} data-testid="usage-chip" className={cn("tabular-nums text-[12px]", usage.tone === "danger" ? "text-danger" : usage.tone === "warning" ? "text-warning" : "text-ink-secondary")}>{usage.short}</span>,
      onSelect: () => dispatch({ type: "toggleSettings", open: true, section: "usage" }),
    } satisfies SidebarMenuItem] : []),
    ...(remoteClient ? [] : [{
      key: "activity",
      label: "Activity",
      icon: <ListChecks size={16} />,
      active: state.activityOpen,
      separatorBefore: !usage,
      onSelect: () => dispatch({ type: "toggleActivity" }),
    } satisfies SidebarMenuItem, {
      key: "inspector",
      label: t("chat.inspector"),
      icon: <Bug size={16} />,
      active: advanced && state.inspectorOpen,
      separatorBefore: true,
      heading: usage ? undefined : advancedOnly,
      disabled: !advanced,
      onSelect: () => dispatch({ type: "toggleInspector" }),
    } satisfies SidebarMenuItem]),
  ];
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      openOnHover
      placement="below"
      renderTrigger={({ open }) => (
        <span
          data-testid="chat-more"
          className={cn(
            "flex rounded-md p-1.5 hover:bg-raised",
            open || findOpen || state.inspectorOpen || state.activityOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
          )}
          title={t("chat.more")}
        >
          <MoreHorizontal size={18} />
        </span>
      )}
    />
  );
}
