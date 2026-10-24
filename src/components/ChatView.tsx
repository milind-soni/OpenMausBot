import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { useAdvancedMode } from "@/lib/interface-mode";
import { ThreadLinkContext } from "@/components/ThreadLinkMenu";
import { useShowThreads } from "@/lib/thread-preferences";
import { AlertTriangle, ChevronLeft, ChevronRight, Crown, Monitor, RefreshCw, Square, Webhook } from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { CopyButton, MESSAGE_ROW, MessageActions, messageActionClass, ReplyAction } from "@/components/MessageActions";
import { ReactAction, ReactionChips } from "@/components/Reactions";
import { useBotMessageMenu, userMessageMenu } from "@/components/message-menu";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { computerStartLine } from "@/lib/computer-start";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";
import { useCaptionChrome, useDesktopCapabilities } from "@/components/DesktopCapabilities";
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
  awayFromMainThread,
  openBot,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL, ManageUsageLink } from "./ChatGptPlanStatus";
import { CODEX_USAGE_URL, codexUsageLimitReached } from "../../shared/codex-usage-limit";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { failedTurnCause, signedOutEngine } from "@/lib/failed-turn";
import { plainErrorLine } from "@/lib/plain-error";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { trialCreditKind, type TrialCreditRefusal } from "../../shared/trial-credit";
import { TrialCreditNotice } from "./TrialCreditNotice";
import { isPureLeakedSystemHarnessMessage, stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard.ts";
import { ConversationalReply, QuickModelNote, isConversational, useReplySegments, useThreadOpenedAt } from "./ConversationalReply";
import type { LocaleKey } from "@/locales";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { BotAvatar } from "./Avatar";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { normalizeState, stateForBot } from "@/lib/mascot";
import { peerLine, peerRequest, type PeerLine } from "@/lib/peer-message";
import { showWorkingDots } from "@/lib/turn-tail";
import { lastNonReceipt } from "@/lib/receipts";
import { turnNowPhrases } from "@/lib/live-activity"; import { useTurnLive } from "@/state/turn-status";
import { ChatMarkdown } from "./ChatMarkdown";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { ThreadChip } from "./ThreadChip";
import { VerifyCard } from "./VerifyCard";
import { askText, runSkill, runSteps, runSummary, showRun, skillPrompt } from "@/lib/verify-steps";
import { useShowRunCard } from "@/lib/run-card-preferences";
import { sendsMessage, useSendKey } from "@/lib/send-key";
import { useColorUserBubbles } from "@/lib/user-bubble-preference";
import { userBubbleStyle } from "@/lib/user-bubble-tone";
import { ToolActivity } from "./ToolActivity";
import { DataResultChip } from "./DataResultChip"; import { PublishedPageCard } from "./PublishedPageCard";
import { ThreadRefText } from "./ThreadRefs";
import { optionsCardRow } from "./OptionsCardRow";
import { MessageBoundary } from "./MessageBoundary";
import { RichMessageRow, UserLineNote, richRowKind } from "./RichMessageRow";
import { Composer } from "./Composer";
import { ChatErrorBanner, ChatNotice } from "./ChatErrorBanner";
import { ThreadContextWarning } from "./ContextWarning";
import { EngineLimitNotice, useLimitResetContinue } from "./LimitResetContinue";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";
import { AutomationCaption, RoutineRunRow } from "./RoutineRunCard";
import { CallRecordRow } from "./CallRecordRow";
import { AttachmentGallery, collectMessageFiles, replyAttachmentGroup, splitMessageAttachments } from "./AttachmentGallery";
import { ScreenFrame } from "./ScreenFrame";
import { CompactionChip, DigestChip } from "./DigestChip";
import { RenameTitle } from "./RenameTitle"; import { ChatHeadRole } from "./BotRole";
import { BotActivityPicker } from "./TaskPicker"; import { ChatHeadConversation } from "./ChatHeadConversation";
import { ModelPicker } from "./ModelPicker";
import { ChatHeaderMenu } from "./ChatMoreMenu"; import { TeamPrivateFirstLine, TeamPrivateHeader, TeamSharedHeader } from "./TeamPrivateChatsLine";
import { useChatFindRequests } from "@/lib/chat-find";
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
import { CancelledTurnRow } from "./CancelledTurnRow";
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
import { splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { EmptyChat } from "./ChatEmptyState";
import { PinnedBanner } from "./ChatPinnedBanner";
import { highlightCitationSource } from "@/lib/citations-dom";
import { useCanWriteIn, useReactor } from "@/lib/cloud-guest";
import { otherSpeaker } from "@/lib/own-profile";
import { latestFailure, latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { pendingApprovals } from "./PendingApproval";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { JumpToLatestButton } from "./JumpToLatestButton";

const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;
export const SIMPLE_BUBBLE = "rounded-[23px] font-normal";

interface ChatRows {
  botId: string;
  threadId: string;
  botName: string;
  voiceId?: string;
  tts: ConfigStatus["tts"];
  localVoice: boolean;
  busy: boolean;
  hasMore: boolean;
  bots: readonly Bot[];
  mentionPeers: readonly Bot[]; mentionPerson: { profileName?: string };
  /** On a Team Cloud, the viewer's person key: another person's line carries their name. */
  speakerViewer?: string | null;
  focus: AppState["focusMessage"];
  showToolCalls: boolean;
  locale: string;
  bubbleStyle?: ReturnType<typeof userBubbleStyle>;
  dispatch: Dispatch<Action>;
  onBranch: (messageId: string) => boolean;
  conversational: boolean; simple?: boolean; canReact: boolean;
  openedAt: number;
}

const ChatRowsContext = createContext<ChatRows | null>(null);

function useChatRows(): ChatRows {
  const rows = useContext(ChatRowsContext);
  if (!rows) throw new Error("a chat row outside ChatView");
  return rows;
}

const drawnBot = (bot: Bot) =>
  [bot.id, bot.name, bot.hidden, bot.color, bot.mascotBody, bot.mascotExpression, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY].join("\u0001");

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

export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  headline?: string;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void } | null;
  setupInstance?: InstanceInfo;
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
  const usageUrl = action ? null : message.includes("subscription_sharing_usage_limit_exceeded") ? CHATGPT_USAGE_URL : codexUsageLimitReached(message) ? CODEX_USAGE_URL : null;
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{headline}</span>
        </div>
        {headline !== message && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{macCuaReason ? t("computer.mac.permission.driverDetail") : t("chat.error.details")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {usageUrl ? (
          <ManageUsageLink href={usageUrl} className="ui-button ui-button-md mt-2 border-transparent bg-ink text-app hover:brightness-110" />
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
              className="ui-button ui-button-md mt-1.5 rounded-full border-danger/30 bg-transparent text-danger hover:bg-danger/15"
            >
              {action.label}
            </button>
          )
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="ui-button ui-button-md mt-1.5 rounded-full border-danger/30 bg-transparent text-danger hover:bg-danger/15"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

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

const TRIAL_CREDIT_LINE: Record<"paused" | "too_low", LocaleKey> = { paused: "engines.trialCreditPaused", too_low: "engines.trialCreditTooLow" };
function TrialCreditFailedRow({ kind, onRetry }: { kind: TrialCreditRefusal; onRetry?: () => void }) {
  const { dispatch } = useStore();
  if (kind === "used_up" || kind === "ended") return <TrialCreditNotice kind={kind} />;
  if (kind === "paused") return <ErrorRow message={t(TRIAL_CREDIT_LINE[kind])} onRetry={onRetry} />;
  return <ErrorRow message={t(TRIAL_CREDIT_LINE[kind])} action={{ label: t("chat.error.connectOwnAi"), onClick: () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" }) }} />;
}

export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}

export function FailedTurnRow({ tool, engine, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  engine: InstanceInfo | undefined;
  onRetry?: () => void;
  botId?: string;
  threadId?: string;
}) {
  const resume = useLimitResetContinue(botId, threadId, tool.limitResetsAt);
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  const credit = trialCreditKind(failedTurnCause(tool.name) ?? "");
  if (credit) return <TrialCreditFailedRow kind={credit} onRetry={onRetry} />;
  const signedOut = signedOutEngine(tool, engine);
  const cause = failedTurnCause(tool.name) ?? tool.name;
  return (
    <ErrorRow
      message={cause}
      headline={signedOut ? t("chat.error.signedOut", { name: signedOut.displayName }) : plainErrorLine(cause)}
      onRetry={onRetry}
      action={resume}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}

export { MessageBoundary };

function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
  bubbleStyle,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  bubbleStyle?: ReturnType<typeof userBubbleStyle>;
}) {
  const [draft, setDraft] = useState(initial);
  const sendKey = useSendKey();
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
    <div className={cn("w-full max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3", bubbleStyle && "user-bubble-colored")} style={bubbleStyle}>
      <textarea
        ref={ref}
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (sendsMessage(e.nativeEvent, sendKey)) {
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
  versions?: readonly Message[];
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (messageId: string, text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, voiceId, tts, localVoice, busy, bots, mentionPeers, mentionPerson, focus, dispatch, onBranch, bubbleStyle, conversational, simple, canReact, openedAt, speakerViewer } = useChatRows();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const peer = peerLine(message) ?? peerRequest(message, botId);
  const user = message.role === "user" && !peer;
  const speaker = user ? otherSpeaker(message, speakerViewer ?? null) : null;
  const [expanded, setExpanded] = useState(false);
  const focusedSearch = focus?.messageId === message.id && Boolean(focus.matchText);
  const [viewRaw, setViewRaw] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === message.id && speech.status !== "idle";
  const rawText = peer ? peer.body : (message.text ?? "");
  const text = user ? rawText : stripLeakedSystemHarnessMessages(rawText);
  const botMenu = useBotMessageMenu({
    text,
    botId,
    messageId: message.id,
    voiceId,
    tts,
    localVoice,
    canSpeak: message.kind === "text" && !peer,
    viewRaw,
    onToggleRaw: () => setViewRaw((raw) => !raw),
    onRegenerate: !busy ? onRegenerate : undefined,
    pin: remoteClient ? undefined : {
      pinned,
      onToggle: () => dispatch({ type: "updateTask", botId, threadId, patch: { pinnedMessageId: pinned ? "" : message.id } }),
    },
  });
  const attached = useMemo(() => splitMessageAttachments(message.attachments), [message.attachments]);
  const generatedPaths = attached.images;
  const linkedFiles = useMemo(
    () => user ? [] : [...attached.files, ...collectMessageFiles(text, [...attached.images, ...attached.files.map((file) => file.path)])],
    [user, text, attached],
  );
  const group = useMemo(
    () => !user && text.trim() ? replyAttachmentGroup(text, message.attachments) : null,
    [user, text, message.attachments],
  );
  const voiceNotes = useMemo(
    () => message.attachments?.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio") ?? [],
    [message.attachments],
  );
  const reply = useReplySegments(conversational && !user && !peer && !viewRaw && !replyTarget && message.kind === "text", text, message.at, openedAt);
  const split = reply.segments.length > 1;
  const webhookView = user ? webhookMessageView(text) : null;
  const cited = user && !webhookView ? splitTranscriptCitations(text) : null;
  const attachments = user && !webhookView ? splitTranscriptAttachments(cited?.display ?? text) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const hasAttachments = Boolean(cited?.citations.length || (attachments && (attachments.images.length || attachments.files.length)));
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
        <BubbleEditor initial={text} bubbleStyle={bubbleStyle} onCancel={onCancelEdit} onSubmit={(edited) => onSubmitEdit(message.id, edited)} />
      </div>
    );
  }

  const forks = user && versions ? versions : [message];
  const versionIndex = forks.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !busy && !v.id.startsWith("optimistic-")) dispatch({ type: "switchBranch", botId, threadId, messageId: v.id });
  };
  const togglePin = () =>
    dispatch({ type: "updateTask", botId, threadId, patch: { pinnedMessageId: pinned ? "" : message.id } });

  return (
    <div {...{ [MESSAGE_ROW]: "" }} className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      {peer && <PeerLabel peer={peer} />}
      {speaker && <div className="mb-0.5 px-1 text-[11.5px] font-medium text-ink-secondary">{speaker}</div>}
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions
            side="user"
            menu={userMessageMenu({
              messageId: message.id,
              onEdit: message.kind === "text" && !webhookView && !hasAttachments && !busy && !message.id.startsWith("optimistic-")
                ? () => onStartEdit(message.id) : undefined,
              pin: remoteClient ? undefined : { pinned, onToggle: togglePin },
            })}
          >
            <ReplyAction onReply={() => onReply(message)} />
            {Boolean(visibleText.trim()) && <CopyButton text={visibleText} className={messageActionClass} />}
          </MessageActions>
        )}
        <div
          data-chat-bubble
          className={cn(
            "w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))] rounded-2xl text-[15px] leading-relaxed",
            emerging && "turn-answer",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : attachmentsOnly || split
                ? "text-ink"
                : user
                  ? cn("bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink", bubbleStyle && "user-bubble-colored", simple && cn(SIMPLE_BUBBLE, bubbleStyle && "antialiased"))
                  : cn("bg-card px-4 py-2.5 text-ink", simple && SIMPLE_BUBBLE),
          )}
          style={user && !webhookView && !attachmentsOnly ? bubbleStyle : undefined}
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
                <div className="mt-1 text-[11px] text-ink-tertiary" title={t(message.steerUncertain ? "composer.delivery.uncertainHint" : "chat.sentMidTurnHint")}>
                  {t(message.steerUncertain ? "composer.delivery.uncertain" : "chat.sentMidTurn")}
                </div>
              )}
              {message.quickModel && <QuickModelNote model={message.quickModel} />}
              <UserLineNote message={message} />
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
              {!group && <AttachmentGallery images={generatedPaths} files={linkedFiles} message={{ threadId, messageId: message.id }} className={text ? undefined : "mb-0"} eager={eagerAttachments} />}
              {split ? (
                <ConversationalReply segments={reply.segments} firstNew={reply.firstNew} citation={{ messageId: message.id, botId, threadId }}
                  renderSegment={(segment) => <ChatMarkdown text={segment} mentionPeers={mentionPeers} mentionPerson={mentionPerson} message={{ threadId, messageId: message.id }} delivered={group?.delivered} />} />
              ) : viewRaw && text ? (
                <div data-citation-source={message.id} data-citation-owner-type="bot" data-citation-owner={botId} data-citation-thread={threadId}><RawMarkdownView text={text} /></div>
              ) : text ? (
                <div data-citation-source={message.id} data-citation-owner-type="bot" data-citation-owner={botId} data-citation-thread={threadId}><ChatMarkdown text={text} mentionPeers={mentionPeers} mentionPerson={mentionPerson} message={{ threadId, messageId: message.id }} delivered={group?.delivered} /></div>
              ) : null}
              {group && <AttachmentGallery images={group.images} files={group.files} message={{ threadId, messageId: message.id }} eager={eagerAttachments} beneath />}
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <MessageActions side="bot" forceOpen={viewRaw || speaking} menu={botMenu}>
            <ReplyAction onReply={() => onReply(message)} />
            {canReact && !peer && <ReactAction threadId={threadId} message={message} />}
            {text && <CopyButton text={text} className={messageActionClass} />}
            {text && viewRaw && <RawToggleAction active onToggle={() => setViewRaw(false)} className={messageActionClass} />}
            {text && speaking && (
              <SpeakButton text={text} botId={botId} messageId={message.id} voiceId={voiceId} tts={tts} localVoice={localVoice} className={cn(messageActionClass, "text-accent")} />
            )}
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
      <ReactionChips threadId={threadId} message={message} bots={bots} align={user ? "end" : "start"} canReact={canReact} />
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

const ActivityChip = memo(function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { bots, dispatch } = useChatRows();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />;
  const comm = message.comm;
  if (comm) {
    const withBot = bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("chat.openConversationWith", { name: comm.withName })}
          className="ui-pill"
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
  transcript: Message[];
  lookups: TranscriptLookups;
  place: EffectivePlace;
  pinnedMessageId?: string;
  today: number;
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  engine: InstanceInfo | undefined;
  unreadDividerId: string | null;
  unreadDividerFading: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, busy, hasMore, focus, showToolCalls, locale } = useChatRows();
  const items = useMemo(() => groupTranscript(messages), [messages, locale]);
  const newestMessageId = messages.at(-1)?.id;
  let newestUserMessageId: string | undefined;
  for (let i = messages.length - 1; i >= 0 && !newestUserMessageId; i--) {
    if (messages[i]!.role === "user") newestUserMessageId = messages[i]!.id;
  }
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
          if (isCancelledTranscriptRow(m)) {
            return (
              <CancelledTurnRow
                onRetry={m.id === lookups.retryableId && canRetryLast ? onRegenerate : undefined}
              />
            );
          }
          switch (richRowKind(m)) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={botId} threadId={threadId} message={m} /> : null;
            case "signin":
              return m.signIn ? <SignInRequestCard botId={botId} botName={botName} threadId={threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={botId} threadId={threadId} message={m} /> : null;
            case "options":
              return optionsCardRow({ message: m, transcript, botId, botName, threadId });
            case "widget":
            case "app":
              return <RichMessageRow botId={botId} botName={botName} threadId={threadId} message={m} />;
            case "routine.run":
              return <RoutineRunRow message={m} botId={botId} />;
            case "call":
              return m.call ? <CallRecordRow message={m} transcript={transcript} botName={botName} threadId={threadId} busy={busy} hasMore={hasMore} /> : null;
            case "activity": {
              if (m.dataResult) return <DataResultChip message={m} />;
              if (isStatusActivity(m)) return <StatusActivityRow message={m} />;
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
              if (!showToolCalls && !m.comm && !m.threadRef && !m.dataResult) return null;
              return <ActivityChip message={m} place={place} />;
            }
            case "digest":
              return showToolCalls ? <DigestChip message={m} /> : null;
            case "compaction":
              return <CompactionChip message={m} />;
            case "screen":
              return <ScreenFrame threadId={threadId} message={m} />;
            default: {
              if (m.publishedPage) return <PublishedPageCard message={m} />;
              const peer = peerLine(m) ?? peerRequest(m, botId);
              const user = m.role === "user" && !peer;
              if (!user && isPureLeakedSystemHarnessMessage(m.text) && !m.attachments?.length) return null;
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
                  onRegenerate={m.id === lastBotTextId && !m.automation ? onRegenerate : undefined}
                  replyTarget={lookups.replyTarget(m)}
                  onReply={onReply}
                />
              );
            }
          }
        })();
        if (!row) return divider && <div key={m.id} className="contents">{divider}</div>;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} today={today} />}
            {divider}
            {m.automation && <AutomationCaption message={m} line={m.automation} botId={botId} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

const CHATHEAD_PILL = "flex min-w-0 items-center gap-2 rounded-full border border-hairline/40 bg-control/60 py-0.5 pl-1.5 text-ink";

function chiefOfStaffBadge(bot: Bot) {
  if (!bot.chiefOfStaff) return null;
  return (
    <span title={t("chat.chiefOfStaff")} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent @max-4xl/chathead:px-1.5">
      <Crown size={11} aria-hidden="true" /> <span className="@max-4xl/chathead:sr-only">{t("chat.chiefOfStaff")}</span>
    </span>
  );
}

export function ChatView({ bot: profile }: { bot: Bot }) {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const { dragProps: headerDragProps, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const advanced = useAdvancedMode();
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
  useChatFindRequests(bot.threadId, findOpen, setFindOpen);
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

  const { messages: allMessages, activeLeafId } = bot;
  const messages = useMemo(() => visibleMessages({ messages: allMessages, activeLeafId }), [allMessages, activeLeafId]);
  const lookups = useMemo(() => transcriptLookups(allMessages, messages), [allMessages, messages]);
  const recordedRun = useMemo(() => runSteps(messages), [messages]);
  const recordedRunCounts = runSummary(recordedRun);
  const engineSupportsAgents = Boolean(
    state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.capabilities?.agentsMcp,
  );
  const canSaveRun =
    skillAuthoringEnabled(state.config) && engineSupportsAgents && recordedRunCounts.passed > 0 && recordedRunCounts.running === 0 && !bot.busy;
  const [runDismissed, setRunDismissed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const lastRunStep = recordedRun.at(-1);
  const showRunCard = useShowRunCard();

  const {
    scrollRef,
    transcriptRef,
    topSentinelRef,
    transcriptKey,
    following,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showLater,
    jumpToLatest,
    scrollHandlers,
  } = useTranscriptViewport({
    ownerId: bot.id,
    threadId: bot.threadId,
    messages,
    pinOn: [bot.busy, composerDock.pad],
    hasMore: bot.hasMore,
  });

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );
  const unreadDivider = useUnreadDivider({ threadId: bot.threadId, messages, following });

  const bots = useDrawnBots(state.bots);
  const mentionPeers = useMemo(() => bots.filter((peer) => peer.id !== bot.id), [bots, bot.id]);
  const focus = state.focusMessage?.threadId === bot.threadId ? state.focusMessage : null;
  const showToolCalls = showToolCallsEnabled(state.config);
  const tts = state.config?.tts;
  const localVoice = localSystemVoiceActive();
  const locale = activeLocale();
  const busy = Boolean(bot.busy);
  const openedAt = useThreadOpenedAt(bot.threadId);
  const headerAnimated = busy || (mascotMotion?.kind ?? "none") !== "none";
  const branch = useRef(messages);
  branch.current = messages;
  const onBranch = useCallback((messageId: string) => branch.current.some((m) => m.id === messageId), []);
  const colorMine = useColorUserBubbles();
  const bubbleStyle = useMemo(() => (colorMine ? userBubbleStyle(bot.color) : undefined), [colorMine, bot.color]);
  const hasMore = Boolean(bot.hasMore);
  const reactor = useReactor();
  const speakerViewer = state.config?.team && reactor !== "user" ? reactor : null;
  const rows = useMemo<ChatRows>(
    () => ({ botId: bot.id, threadId: bot.threadId, botName: bot.name, voiceId: bot.voice, tts, localVoice, busy, hasMore, bots, mentionPeers, mentionPerson: { profileName: state.config?.profile?.name }, focus, showToolCalls, locale, dispatch, onBranch, bubbleStyle, conversational: isConversational(bot.replyStyle), simple: !advanced, canReact: canWrite !== false, openedAt, speakerViewer }),
    [bot.id, bot.threadId, bot.name, bot.voice, tts, localVoice, busy, hasMore, bots, mentionPeers, state.config?.profile?.name, focus, showToolCalls, locale, dispatch, onBranch, bubbleStyle, bot.replyStyle, advanced, canWrite, openedAt, speakerViewer],
  );
  const currentTask = bot.tasks?.find((task) => task.threadId === bot.threadId), place = effectivePlace(bot, currentTask), team = state.config?.team, privateChat = Boolean(team) && currentTask?.private === true, sharedChat = Boolean(team) && !privateChat;

  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId, text });
    },
    [bot.id, bot.threadId, dispatch],
  );
  const [lastUserMessage, lastTypedMessage] = useMemo(() => {
    const said = messages.filter((m) => m.role === "user" && m.kind === "text" && !peerLine(m));
    return [said.at(-1), said.findLast((m) => !m.reaction)];
  }, [messages]);
  const lastTypedMessageHasAttachments = useMemo(() => {
    if (!lastTypedMessage?.text) return false;
    const cited = splitTranscriptCitations(lastTypedMessage.text);
    const attached = splitTranscriptAttachments(cited.display);
    return cited.citations.length > 0 || attached.images.length > 0 || attached.files.length > 0;
  }, [lastTypedMessage]);

  const lastMessage = lastNonReceipt(messages);
  const live = useTurnLive(bot.threadId), activity = turnNowPhrases(live.status, lastMessage);
  const toolInFlight = (lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined) || Boolean(live.status && live.status.activity !== "thinking" && live.status.activity !== "reply");
  // The mascot and its status line stay for the whole turn; only its end hides them, never a timer.
  const waiting = Boolean(bot.busy && bot.activity !== "waiting-on-you" && showWorkingDots(bot.busy, lastMessage, undefined, live.ended));
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
    wasWaiting.current = waiting;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
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
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(bot.busy ? bot.turnStartedAt ?? Date.now() : null);
  }, [bot.busy, bot.id, bot.threadId, bot.turnStartedAt]);

  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy && !lastUserMessage.id.startsWith("optimistic-")) {
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, bot.threadId, dispatch]);

  const currentLink = profile.tasks?.find((task) => task.threadId === bot.threadId)?.link;
  const threadLink = useMemo(() => canWrite !== false
    ? { link: currentLink, assign: (link: string | null) => dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { link } }) }
    : null, [canWrite, currentLink, bot.id, bot.threadId, dispatch]);

  const routineExecution = state.routineRuns.find((run) => run.target === "bot" && run.botId === bot.id && run.threadId === bot.threadId);
  const resultsThreadId = routineExecution?.resultsThreadId ?? routineExecution?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));

  return (
    <ThreadLinkContext value={threadLink}>
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <CallOverlay bot={bot} />
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* z-[25]: above the room set-up card (z-20), below the CallOverlay (z-30). */}
      <GlassBar edge="top" className="z-[25]">
      <div
        {...headerDragProps}
        className={cn(
          // A container query never matches the container itself, so the row that wraps is the child below.
          "@container/chathead px-5 py-3",
          "pl-11 md:pl-5",
        )}
      >
        <div data-chathead-row className="flex items-center justify-between @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:gap-y-1 @min-[30rem]/chathead:grid @min-[30rem]/chathead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]">
        <div data-chathead-identity className="flex min-w-0 items-center gap-2 @max-[30rem]/chathead:basis-full @min-[30rem]/chathead:col-start-2 @min-[30rem]/chathead:justify-self-center" style={headerNoDragStyle}>
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
            </div>
          ) : (
            <button
              type="button"
              data-chathead-pill data-tour="bot-pill"
              onClick={() => dispatch({ type: "toggleSettings", open: true })}
              title={t("chat.openProfile")}
              aria-label={t("chat.openProfileAria", { name: bot.name })}
              className={cn(CHATHEAD_PILL, "group h-9 gap-2.5 pl-2 pr-3.5 hover:bg-raised-hover")}
            >
              <BotAvatar bot={bot} state={stateForBot({ ...bot, messages })} size={24}
                motion={mascotMotion?.kind ?? "none"} motionKey={mascotMotion?.nonce ?? 0} animated={headerAnimated} />
              <span className="min-w-0 truncate text-[14px] font-medium text-ink">{bot.name}</span>
              {chiefOfStaffBadge(bot)}
              <ChevronRight size={14} aria-hidden="true" className="-ml-2.5 w-0 shrink-0 text-ink-secondary opacity-0 transition-[width,margin,opacity] duration-150 group-hover:ml-0 group-hover:w-3.5 group-hover:opacity-100 group-focus-visible:ml-0 group-focus-visible:w-3.5 group-focus-visible:opacity-100" />
            </button>
          )}{!advanced && !remoteClient && <ChatHeadConversation bot={profile} />}
          <ChatHeadRole bot={bot} /><span role="status" className="sr-only" data-chathead-status>{bot.busy ? t("sidebar.preview.working") : ""}</span>{privateChat && <TeamPrivateHeader />}{sharedChat && team && <TeamSharedHeader team={team} />}
          {!bot.busy && bot.waitingForTeammates && <span className="truncate text-[12px] text-ink-secondary" role="status">Teammates working</span>}
          {(advanced || remoteClient) && awayFromMainThread(profile, showThreads) && (
            <button
              type="button"
              data-chathead-back
              onClick={() => openBot(dispatch, profile, false)}
              className="shrink-0 whitespace-nowrap rounded-full bg-raised px-2.5 py-0.5 text-[12px] font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              {t("chat.backToMainThread")}
            </button>
          )}
        </div>
        <div
          data-chathead-controls
          className="flex shrink-0 items-center gap-2 @max-[30rem]/chathead:ml-auto @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:justify-end @min-[30rem]/chathead:col-start-3 @min-[30rem]/chathead:justify-self-end"
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
          <ThreadContextWarning bot={bot} messages={messages} />
          <EngineLimitNotice engine={bot.modelSelection?.instanceId} />
          {/* Simple mode moves the model, the computer and ⋯ into the bot panel; a remote client's panel has neither. */}
          {advanced && !remoteClient && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} />}
          <LiveCallChip currentBotId={bot.id} onOpen={(botId, threadId) => openThread(dispatch, { botId, threadId }, state, showThreads)} />
          {(advanced || remoteClient) && <button
            data-tour="computer"
            onClick={(event) => { if (!state.computerOpen) rememberComputerPanelOpen({ botId: bot.id, opener: event.currentTarget, tabs: event.detail === 0 }); dispatch({ type: "toggleComputer" }); }}
            className={cn(
              "relative rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")} aria-label={busy && place === "browser" ? `${t("chat.computer")}, ${t("place.live")}` : t("chat.computer")}
          >
            <Monitor size={18} />{busy && place === "browser" && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-success" data-testid="computer-button-live" />}
          </button>}
          {(advanced || remoteClient) && <ChatHeaderMenu key={`menu:${bot.threadId}`} bot={bot} />}
        </div>
        </div>
      </div>

      {(advanced || remoteClient) && <BotActivityPicker bot={bot} />}{privateChat && team && <TeamPrivateFirstLine key={team.id} team={team} />}
      {routineExecution && <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">{t("routines.executionDetails", { name: routineExecution.routineName })}</span>
        {canOpenResults && resultsThreadId && <button type="button" onClick={() => openNotificationTarget(dispatch, { botId: bot.id, threadId: resultsThreadId }, state, showThreads)} className="rounded px-2 py-1 text-accent hover:bg-raised">{t("routines.results.back")}</button>}
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", routineId: routineExecution.routineId, botId: bot.id })} className="rounded px-2 py-1 hover:bg-raised hover:text-ink">{t("routines.logs")}</button>
      </div>}
      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      <ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />
      <ChatNotice notice={state.notice} />

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

      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 [overflow-anchor:none]"
        {...scrollHandlers}
      >
        <div
          ref={transcriptRef}
          className="glass-scroller-content chat-column relative flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          // off: a polite log re-reads every tick and chip while the bot works; TranscriptAnnouncer speaks once when
          // done.
          aria-live="off"
          aria-label={t("chat.conversationWith", { name: bot.name })}
        >
          {olderPending ? (
            <div className="flex items-center justify-center gap-2 py-3 text-xs text-ink-tertiary">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <span>{t("chat.loadingEarlier")}</span>
            </div>
          ) : hiddenCount > 0 || bot.hasMore ? (
            <div ref={topSentinelRef} className="h-2 w-full pointer-events-none" aria-hidden="true" />
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
                className="ui-pill"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {computerStarting && (
            <div className="flex justify-start">
              <div className="ui-pill">
                <WorkingDots size={3.5} />
                {computerStarting}
              </div>
            </div>
          )}
          <TurnPresence
            avatar={
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
            phrases={activity?.phrases}
            phase={activity?.phase}
            size={activity?.size}
            seed={`${bot.id}:${bot.threadId ?? ""}:${busySince ?? ""}`}
            answering={popping !== null}
            since={busySince}
          />
        </div>
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      <div ref={composerDockRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] chat-column-dock">
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
      {!following && (
        <div className="relative">
          <JumpToLatestButton onClick={jumpToLatest} className="pointer-events-auto bottom-2" />
        </div>
      )}
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
        onEditLast={lastTypedMessage && !lastTypedMessageHasAttachments && !bot.busy && !lastTypedMessage.id.startsWith("optimistic-")
          ? () => setEditingId(lastTypedMessage.id)
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
    </ThreadLinkContext>
  );
}

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
