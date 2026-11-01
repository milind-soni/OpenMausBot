import { directMessageSent, roomMessageSent } from "@/lib/product-events";
import { useComposerDictation } from "@/lib/use-composer-dictation";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ArrowUp, Clock, Mic, Paperclip, Square, X } from "lucide-react";
import { useStore, visibleMessages, currentTaskBot, type Bot, type Group, type InstanceInfo, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { useMenuMotion } from "./MenuMotion";
import { ELEVATED_CARD, ELEVATED_FLOAT } from "./elevated";
import { activeLocale, t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { imeComposing, sendKeyLabel, sendsMessage, useSendKey } from "@/lib/send-key";
import {
  draftRevision,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  forgetFailedComposerSend,
  markDraftEdited,
  prependComposerDraft,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  replaceDraftAttachment,
  restoredSendId,
  restoredRequestText,
  useComposerDraft,
  useComposerChannelMode,
  useDraftAttachmentPending,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { DEVS_CHOICE, MentionMenu, teammateChoices, type MentionChoice } from "./MentionMenu"; import { useTeammates } from "@/state/team-people"; import { hiddenFromSidebar, useViewerEmail } from "@/lib/default-bot";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { MentionTextarea } from "./MentionTextarea";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { PointedChips } from "./app/PointedChips"; import { SetupRequestChip, setupRequestPlaceholder } from "./SetupOffer";
import { takePointedChips } from "@/lib/pointed-chips";
import { splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { PlaceChip } from "./PlaceChip";
import { ApprovalModeSelector } from "./ApprovalModeSelector";
import { approvalModeFor } from "../../shared/approval-mode";
import { useOnCall } from "@/lib/call";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import {
  appendPastedText,
  handoffAttachmentImagePreview,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  dataContextFor,
  discardUnsentUpload,
  composerShouldRefocus,
  composerTakesFocusOnOpen,
  imageAttachmentFromFile,
  replyTargetTakesFocus,
  intakeFiles,
  isLongPaste,
  optimisticImageAttachment,
  pasteAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { goalCoordinatorForComposer, jevRoomRoutingOn, openTaskWorking, roomRespondersForComposer } from "@/lib/group-routing";
import { composerPlaceholder, sendLabels, SIMPLE_CONTROL, slotColors } from "./composer-simple";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { CallButton } from "./CallView";
import { GroupCallButton } from "./GroupCallView";
import { ApprovalChip, ComposerPlusMenu, GoalToggle } from "./ComposerPlusMenu";
import { PhonePlus } from "./PhonePlus";
import { useThreadApproval } from "./thread-approval";
import { useStackedField, useTallPill } from "./composer-wrap";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ComposerReplyStrip } from "./ReplyQuote";
import { escapeCancelsReply } from "@/lib/replies";
import { useThreadRefs } from "./ThreadRefs";
import {
  QueuedComposerMessages,
  composerCanSteerQueuedMessages,
  doubleEnterSteerWindowExpiresAt,
  doubleEnterSteersQueue,
} from "./ComposerQueuedMessages";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { mentionChoicesForQuery, mentionQueryAt } from "@/lib/mentions";
import { serializeThreadRefs, threadTokenFromPaste, threadTokenSpacing } from "@/lib/thread-refs";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  skillSlashCommands,
  slashCommandMatches,
  type ComposerSlashCommand,
} from "@/lib/composer-commands";
import { useSlashSkills } from "@/lib/use-slash-skills";

const SIMPLE_COMPOSER = "bg-composer p-2 ring-[0.5px] ring-ink/10 hover:ring-ink/[0.22] focus-within:ring-ink/[0.22] shadow-[0_2px_8px_-1px_rgb(0_0_0/0.05),0_1px_2px_rgb(0_0_0/0.03),0_0_0_1px_rgb(228_228_228/0.04)] [transition:border-radius_300ms,box-shadow_150ms]";

const supportsAgents = (instances: InstanceInfo[], candidate?: Bot) =>
  Boolean(candidate && instances.find((instance) => instance.instanceId === candidate.modelSelection.instanceId)?.capabilities?.agentsMcp);

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

export function Composer({
  bot: profile,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked: setupLocked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  locked?: boolean;
}) {
  const bot = profile ? currentTaskBot(profile) : undefined;
  const locked = setupLocked || Boolean(bot?.awaitingThreadSnapshot);
  const { state, dispatch } = useStore();
  const { threads, currentBotId } = useThreadRefs();
  const { capabilities } = useDesktopCapabilities();
  const advanced = useAdvancedMode();
  // On a phone the composer is a dock: a round + (attach and every other tool), then one pill with the field, the mic and the voice button.
  const singleRow = useMediaQuery(PHONE_LAYOUT);
  // Simple mode on a wider screen: one pill holding a round +, the field, the mic and one round button in the bot's colour.
  const simpleDock = !advanced && !singleRow;
  const sendKey = useSendKey();
  const sendLabel = sendKeyLabel(sendKey);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  const currentGroupTask = group?.tasks?.find((task) => task.threadId === threadId);
  const groupBusyBotId = currentGroupTask?.busyBotId ?? (currentGroupTask?.working ? group?.busyBotId : (group?.threadId === threadId ? group?.busyBotId : null));
  const groupWorking = group ? openTaskWorking(group) : false;
  const busy = group ? Boolean(groupWorking || groupBusyBotId) : Boolean(bot?.busy);
  const steerInstanceId = group
    ? members?.find((member) => member.id === groupBusyBotId)?.modelSelection.instanceId
    : bot?.modelSelection.instanceId;
  const canSteer =
    state.instances.find((i) => i.instanceId === steerInstanceId)?.capabilities?.queueing === true;
  const composerTask = profile?.tasks?.find((task) => task.threadId === threadId);
  // Visible branch only: an approval left on an abandoned branch must not block the composer.
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  // A Turn on card can wait while the person walks to their computer: they can still write meanwhile.
  const blocking = Boolean(approval && !approval.message.card?.computerAsk);
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === groupBusyBotId)
    : state.bots.find((one) => one.id === approval?.message.inbox?.from.botId) ?? bot;
  const busyName = group
    ? (members?.find((b) => b.id === groupBusyBotId)?.name ??
      (groupWorking ? t("composer.busy.team") : t("composer.busy.aBot")))
    : (bot?.name ?? t("composer.busy.theBot"));
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const attachmentPending = useDraftAttachmentPending(draftId);
  const failedSends = useFailedComposerSends(draftId);
  const [channelMode, setChannelMode] = useComposerChannelMode(draftId);
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      if (recoverFailedComposerSend(sent) === "restored") {
        if (sent.reply) onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => appendDraftAttachments(draftId, next),
    [draftId],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      if (removed?.kind === "image") releaseAttachmentImagePreview(removed);
      if (removed) discardUnsentUpload(removed);
      editAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    },
    [attachments, editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const { recording, speechError, toggle: toggleMic, stop: stopDictation } = useComposerDictation({
    draftId, text, onText: editText, available: capabilities.dictation.available,
  });
  const [caret, setCaret] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const tall = useTallPill(shellRef, simpleDock);
  const multiline = simpleDock && (tall || text.includes("\n"));
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stacked = useStackedField(inputRef, advanced && !singleRow, text);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const caretRef = useRef(0);
  caretRef.current = caret;
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerShouldRefocus(document.activeElement, input)) return;
      const at = Math.min(caretRef.current, input.value.length);
      input.focus();
      input.setSelectionRange(at, at);
    });
  }, []);
  // Touch screens are skipped: focusing there pops the on-screen keyboard over the conversation.
  useEffect(() => {
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const replyToId = replyTo?.id ?? null;
  const focusedReplyRef = useRef(replyToId);
  useEffect(() => {
    const previous = focusedReplyRef.current;
    focusedReplyRef.current = replyToId;
    if (!replyTargetTakesFocus(previous, replyToId)) return;
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [replyToId]);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string, mode: "chat" | "goal") => {
    if (!group) return botSupportsImages(bot);
    if (mode === "goal") {
      return botSupportsImages(goalCoordinatorForComposer(message, members ?? [], group) ?? undefined);
    }
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const typedGoalText = !group?.dm ? goalTextFromComposer(text) : null;
  const effectiveText = typedGoalText ?? text;
  const effectiveChannelMode = typedGoalText !== null ? "goal" : channelMode;
  const engineSupportsImages = imageTargetsSupport(effectiveText, effectiveChannelMode);

  const slash = composerSlashTrigger(text, caret);
  const locale = activeLocale();
  const slashSkills = useSlashSkills(group ? undefined : bot?.id, threadId, Boolean(slash) && slash?.start !== dismissedSlashAt);
  const canLearn = skillAuthoringEnabled(state.config) &&
    (group ? (members ?? []).some((member) => supportsAgents(state.instances, member)) : supportsAgents(state.instances, bot));
  const commandCandidates = useMemo(() => {
    if (!slash || slash.start === dismissedSlashAt) return [];
    const available: ComposerSlashCommand[] = [];
    if (!group?.dm) available.push({
      kind: "command",
      id: "goal",
      label: "/goal",
      description: t(group ? "composer.command.goalDesc" : "composer.command.goalBotDesc"),
    });
    if (canLearn) {
      available.push({
        kind: "command",
        id: "learn",
        label: "/learn",
        description: t("composer.command.learnDesc"),
      });
    }
    if (!group && supportsAgents(state.instances, bot)) available.push({
      kind: "command",
      id: "setup",
      label: "/setup",
      description: t("composer.command.setupDesc"),
    });
    available.push(...skillSlashCommands(slashSkills));
    return available.filter((command) => slashCommandMatches(command, slash.query));
  }, [slash, dismissedSlashAt, group, bot, canLearn, state.instances, locale, slashSkills]);
  const commandPickerOpen = commandCandidates.length > 0;

  const mention = mentionQueryAt(text, caret); const teammates = useTeammates(); const viewer = useViewerEmail();
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          ...(!group.dm ? [{ id: "__everyone__", name: "everyone" }] : []),
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden && !hiddenFromSidebar(member, viewer))
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    return mentionChoicesForQuery([...pool, ...teammateChoices(teammates.people), DEVS_CHOICE], mention.query);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members, teammates, viewer]);
  const mentionEveryoneCount = (members ?? []).filter((member) => !member.hidden).length;
  const mentionPickerOpen = candidates.length > 0;
  const commandMotion = useMenuMotion(commandPickerOpen);
  const mentionMotion = useMenuMotion(mentionPickerOpen);

  useEffect(
    () => setHighlight(0),
    [mention?.start, mention?.query, slash?.start, slash?.query],
  );

  useEffect(() => {
    if (!commandPickerOpen) return;
    setHighlight((current) => Math.min(current, commandCandidates.length - 1));
  }, [commandCandidates.length, commandPickerOpen]);

  useEffect(() => {
    if (!commandPickerOpen) return;
    commandListRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, commandPickerOpen]);

  useEffect(() => {
    if (!mentionPickerOpen) return;
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickCommand = (command: ComposerSlashCommand | undefined) => {
    if (!slash || !command) return;
    const replacement = command.kind === "skill" ? `${command.label} `
      : command.id === "learn" ? "/learn " : command.id === "setup" ? "/setup " : "";
    const next = replaceComposerSlashTrigger(text, slash, replacement);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    setChannelMode(command.kind === "command" && command.id === "goal" ? "goal" : "chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const teachTask = () => {
    const learn = "/learn ";
    editText(learn + text.replace(/^\/learn\s*/, "").trimStart());
    setCaret(learn.length);
    setChannelMode("chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(learn.length, learn.length);
    });
  };

  const pendingCount = (state.pendingQueued[threadId] ?? []).length;
  const queuedMessages = state.pendingQueued[threadId] ?? [];
  const canSteerQueued = composerCanSteerQueuedMessages(
    busy,
    locked,
    pendingCount,
    blocking,
  );
  const [steering, setSteering] = useState(false);
  const interruptTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
  };
  const queueHeadId = queuedMessages[0]?.queueId;
  const steerQueued = () => {
    if (!queueHeadId) return;
    setSteering(true);
    const settle = () => setSteering(false);
    if (group && canSteer) {
      dispatch({ type: "steerGroupQueued", groupId: group.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (group) {
      dispatch({ type: "interruptGroup", groupId: group.id, threadId, onError: settle });
    } else if (bot && canSteer) {
      dispatch({ type: "steerQueued", botId: bot.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (bot) {
      dispatch({ type: "interrupt", botId: bot.id, threadId, onError: settle });
    }
  };
  useEffect(() => setSteering(false), [threadId, queueHeadId]);
  // Only a confirmed removal hands the words back, so a message that already drained into a turn is never resent.
  const editQueued = (queueId: string) => {
    const queued = queuedMessages.find((item) => item.queueId === queueId);
    if (!queued) return;
    const targetDraftId = draftId;
    const onCancelled = () => {
      const cited = splitTranscriptCitations(queued.text);
      if (cited.display) prependComposerDraft(targetDraftId, cited.display);
      appendDraftAttachments(targetDraftId, cited.citations);
      if (targetDraftId !== draftIdRef.current) return;
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(cited.display.length, cited.display.length);
      });
    };
    if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId, onCancelled });
    else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId, onCancelled });
  };
  const steerAgainUntilRef = useRef(0);
  const prevPendingCountRef = useRef(pendingCount);
  useEffect(() => {
    const expiresAt = doubleEnterSteerWindowExpiresAt(
      prevPendingCountRef.current,
      pendingCount,
      busy,
      canSteer,
    );
    if (expiresAt !== null) steerAgainUntilRef.current = expiresAt;
    prevPendingCountRef.current = pendingCount;
  }, [pendingCount, busy, canSteer]);
  useEffect(() => {
    if (!busy || pendingCount === 0) {
      setSteering(false);
      return;
    }
    if (!steering) return;
    const timeout = window.setTimeout(() => setSteering(false), 20_000);
    return () => window.clearTimeout(timeout);
  }, [busy, pendingCount, steering]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const modeBot = group ? undefined : bot;
  const { choice: approvalChoice, dialogs: approvalDialogs } = useThreadApproval(modeBot);
  const uploadImage = useCallback(async (file: File): Promise<Attachment | null> => {
    const optimistic = optimisticImageAttachment(file);
    if (!optimistic) return null;
    appendDraftAttachments(draftId, [optimistic]);
    try {
      const completed = await imageAttachmentFromFile(file, optimistic);
      if (!completed) {
        replaceDraftAttachment(draftId, optimistic.id, null);
        releaseAttachmentImagePreview(optimistic);
        return null;
      }
      handoffAttachmentImagePreview(completed.path, completed.previewUrl);
      if (!replaceDraftAttachment(draftId, optimistic.id, completed)) {
        releaseAttachmentImagePreview(completed);
      }
      return null;
    } catch (error) {
      replaceDraftAttachment(draftId, optimistic.id, null);
      releaseAttachmentImagePreview(optimistic);
      throw error;
    }
  }, [draftId]);
  const pickFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    changeDraftAttachmentPending(draftId, true);
    try {
      const { attachments: added, notice } = await intakeFiles(Array.from(picked), {
        allowImages: engineSupportsImages,
        getPath: pathForFile,
        uploadImage,
      });
      if (added.length) addAttachments(added);
      if (notice) setAttachmentNotice(notice);
    } finally {
      changeDraftAttachmentPending(draftId, false);
    }
    refocusInput();
  };

  const hasContent = Boolean(effectiveText.trim()) || attachments.length > 0;
  const onCall = useOnCall();
  const media = useLiveMedia();
  const callTarget = group?.id ?? bot?.id;
  const calling = callTarget !== undefined && (onCall === callTarget || (isLiveCallRunning(media.phase) && media.botId === callTarget));
  const stoppable = busy || Boolean(!group && bot?.waitingForTeammates);
  // Simple mode's round button is the call, Send while there is text, and Stop while the bot works.
  const stopInSlot = simpleDock && stoppable && !locked && !hasContent && !calling;
  const callShown = !simpleDock || (!hasContent && !stopInSlot);
  const slot = slotColors(bot?.color, Boolean(group));
  const sendNames = sendLabels({ simple: !advanced, busy, canSteer, name: busyName, sendLabel });
  const retryFailedSend = (failed: FailedComposerSend) => {
    const failedMode = failed.channelMode ?? "chat";
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText, failedMode)) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
          channelMode: failed.channelMode,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, mode: failedMode, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, mode: failedMode, ...retry });
    }
  };
  const send = () => {
    if (locked || attachmentPending) return;
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !imageTargetsSupport(effectiveText, effectiveChannelMode)
    ) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    const composed = composeMessage(serializeThreadRefs(effectiveText, threads, currentBotId), attachments);
    if (!composed) return;
    stopDictation();
    const body = restoredRequestText(draftId) ?? composed;
    const dataContext = dataContextFor(body, state.computerOpen ? state.dataView : null, !group && bot ? { botId: bot.id, threadId } : undefined);
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? crypto.randomUUID(),
      text,
      requestText: body,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
      channelMode: effectiveChannelMode,
    };
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        mode: effectiveChannelMode,
        onError: () => restoreDraft(sentDraft),
      });
      roomMessageSent(effectiveChannelMode, busy);
    } else if (bot) {
      const points = effectiveChannelMode === "goal" ? null : takePointedChips(threadId);
      dispatch({
        type: "send", botId: bot.id, text: body, sendId: sentDraft.sendId, replyToId: replyTo?.id, threadId, dataContext, mode: effectiveChannelMode,
        ...(points ? { pointed: points.pointed } : {}),
        onError: () => { points?.restore(); restoreDraft(sentDraft); },
      });
      directMessageSent(state.instances, bot.modelSelection?.instanceId, busy && !canSteer);
    }
    setText("");
    setAttachments([]);
    onConsumeReply?.();
    setChannelMode("chat");
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = clipboardImageFiles(e.clipboardData);
    if (imageFiles.length > 0 || clipboardHasImages(e.clipboardData)) {
      e.preventDefault();
      if (!engineSupportsImages) {
        dispatch({
          type: "error",
          message: t("composer.error.noImages"),
        });
        return;
      }
      if (!imageFiles.length) {
        dispatch({ type: "error", message: t("composer.error.clipboardImage") });
        return;
      }
      if (imageFiles.length > 0) {
        changeDraftAttachmentPending(draftId, true);
        void (async () => {
          try {
            const results = await Promise.allSettled(imageFiles.map(uploadImage));
            for (const result of results) {
              if (result.status === "rejected") {
                dispatch({
                  type: "error",
                  message: result.reason instanceof Error ? result.reason.message : "image upload failed",
                });
              }
            }
          } finally {
            changeDraftAttachmentPending(draftId, false);
          }
        })();
        return;
      }
    }
    const pasted = e.clipboardData.getData("text/plain");
    const reference = threadTokenFromPaste(pasted, threads, currentBotId);
    if (reference) {
      e.preventDefault();
      const start = e.currentTarget.selectionStart ?? text.length;
      const end = e.currentTarget.selectionEnd ?? start;
      const { lead, trail } = threadTokenSpacing(text, start, end);
      const token = lead + reference.token + trail;
      editText(text.slice(0, start) + token + text.slice(end));
      const at = start + token.length;
      setCaret(at);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(at, at);
      });
      return;
    }
    if (!isLongPaste(pasted)) return;
    e.preventDefault();
    const start = e.currentTarget.selectionStart;
    const end = e.currentTarget.selectionEnd;
    if (start !== end) {
      editText(`${text.slice(0, start)}${text.slice(end)}`);
      setCaret(start);
    }
    editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
  };

  const toggleGoal = () => {
    markDraftEdited(draftId);
    if (typedGoalText !== null) {
      const nextCaret = Math.max(0, caret - (text.length - typedGoalText.length));
      editText(typedGoalText);
      setCaret(nextCaret);
      setChannelMode("chat");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
      return;
    }
    setChannelMode((current) => current === "goal" ? "chat" : "goal");
  };
  const goal = !group?.dm ? { on: effectiveChannelMode === "goal", onToggle: toggleGoal, solo: !group } : undefined;

  return (
    <div className={cn("pointer-events-none relative px-5", simpleDock ? "pb-4" : "pb-3")}>
      {speechError && (
        <div className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="pointer-events-auto relative w-full">
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
          >
            <span className="min-w-0 flex-1 truncate">
              {t("composer.failed.notSent", {
                text: failed.text.trim() || t("composer.failed.attachment"),
              })}
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
            >
              {t("chat.retry")}
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label={t("composer.failed.dismissAria")}
              title={t("composer.failed.dismiss")}
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        <SlashCommandMenu listRef={commandListRef} motion={commandMotion} commands={commandCandidates} highlight={highlight}
          onPick={pickCommand} onHighlight={setHighlight} />
        <MentionMenu listRef={mentionListRef} motion={mentionMotion} choices={candidates} highlight={highlight}
          everyoneCount={mentionEveryoneCount} onPick={pickMention} onHighlight={setHighlight} />
        {approval && (
          <div className={cn("mb-2 overflow-hidden rounded-[20px]", ELEVATED_CARD)}>
            <PendingApprovalPanel
              key={approval.requestId}
              pending={approval}
              botName={approvalBot?.name} asker={approvalBot}
              count={approvals.length}
              index={0}
              locale={activeLocale()}
              actions={<PendingApprovalActions part="primary" pending={approval} threadId={threadId} bot={approvalBot} onCancelTurn={interruptTurn} />}
              more={approval.message.inbox ? undefined : <PendingApprovalActions part="more" pending={approval} threadId={threadId} bot={approvalBot} onCancelTurn={interruptTurn} />}
            />
          </div>
        )}
        {!group && <PointedChips threadId={threadId} />}{!group && bot && <SetupRequestChip bot={bot} threadId={threadId} />}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onChangeCitation={(citation: CitationAttachment) => editAttachments((current) => current.map((attachment) => attachment.id === citation.id ? citation : attachment))}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
          onPendingChange={(pending) => changeDraftAttachmentPending(draftId, pending)}
          uploadImage={uploadImage}
        />
        <QueuedComposerMessages
          items={queuedMessages}
          onSteer={canSteerQueued ? steerQueued : undefined}
          steerInterrupts={!canSteer}
          steerMode={group ? "next" : "all"}
          steering={steering}
          onCancel={(queueId) => {
            if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId });
            else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId });
          }}
          onEdit={locked ? undefined : editQueued}
        />
        <div className="relative">
          {/* Plain canvas behind the composer and the strip below it, so the transcript ends at the composer
              with no fade. Simple mode starts it at the composer's top edge, Advanced at its middle. */}
          <div
            aria-hidden
            data-composer-backdrop
            className={cn("pointer-events-none absolute -left-5 -right-5 bg-app", advanced ? "-bottom-3 top-1/2" : cn("top-0", simpleDock ? "-bottom-4" : "-bottom-3"))}
          />
        <div ref={shellRef} data-tour="composer" data-multiline={multiline ? "" : undefined} className={cn("@container/composer relative z-[1]", singleRow ? "flex items-end gap-2" : simpleDock ? cn(SIMPLE_COMPOSER, multiline ? "rounded-[18px]" : "rounded-[22px]") : cn("rounded-2xl px-2 py-1.5", ELEVATED_FLOAT))}>
        {singleRow && !locked && (
          <div className="flex shrink-0 items-center">
            <PhonePlus
              onAttach={() => fileInput.current?.click()}
              goal={goal}
              teach={!advanced && canLearn ? teachTask : undefined}
              approval={approvalChoice && modeBot && { name: modeBot.name, choice: approvalChoice }}
              callBotId={bot && !group ? bot.id : undefined}
              place={modeBot && !remoteClient && advanced ? {
                bot: modeBot,
                task: composerTask,
                disabled: Boolean(modeBot.busy),
                onPin: (surface) => dispatch({ type: "updateTask", botId: modeBot.id, threadId: modeBot.threadId, patch: { surface } }),
              } : undefined}
            />
          </div>
        )}
        <div className={singleRow ? cn("min-w-0 flex-1 rounded-[26px] px-3 py-1.5", ELEVATED_FLOAT) : "contents"}>
        {replyTo && <ComposerReplyStrip message={replyTo} fallbackName={bot?.name} onClear={onClearReply} />}
        <div data-composer-row className={cn("flex items-end", simpleDock ? "gap-1.5" : "gap-1", !singleRow && !simpleDock && "@max-[30rem]/composer:flex-wrap", stacked && "flex-wrap")}>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickFiles(e.target.files);
              // Reset so picking the same file again still fires onChange.
              e.target.value = "";
            }}
          />
          {!locked && !singleRow && (
            <div className={cn("flex items-center gap-1", simpleDock ? "shrink-0" : "flex-wrap")}>
              {simpleDock && <ComposerPlusMenu onAttach={() => fileInput.current?.click()} goal={goal} teach={canLearn ? teachTask : undefined} />}
              {advanced && <button
                type="button"
                onClick={() => fileInput.current?.click()}
                aria-label={t("composer.attach")}
                title={t("composer.attach")}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <Paperclip size={16} strokeWidth={1.75} absoluteStrokeWidth />
              </button>}
              {/* Simple mode shows a mode's chip only while it is on, so a choice made in the + menu or the bot panel stays in view. */}
              {goal && (advanced || goal.on) && <GoalToggle {...goal} compact={simpleDock} />}
              {advanced && approvalChoice && <ApprovalModeSelector {...approvalChoice} />}
              {simpleDock && approvalChoice && profile && bot && approvalModeFor(bot) !== approvalModeFor(profile) && <ApprovalChip choice={approvalChoice} />}
              {modeBot && !remoteClient && advanced && (
                <PlaceChip
                  bot={modeBot}
                  task={composerTask}
                  live={Boolean(modeBot.busy)}
                  disabled={Boolean(modeBot.busy)}
                  onPin={(surface) => dispatch({ type: "updateTask", botId: modeBot.id, threadId: modeBot.threadId, patch: { surface } })}
                />
              )}
            </div>
          )}
          <MentionTextarea
          wrapperClassName={singleRow || simpleDock ? undefined : cn("@max-[30rem]/composer:order-first @max-[30rem]/composer:basis-full", stacked && "order-first basis-full")}
          inputRef={inputRef}
          peers={[...(group ? members ?? [] : state.bots.filter((member) => member.id !== bot?.id)), ...teammates.peers]}
          everyone={Boolean(group && !group.dm)}
          dir="auto"
          rows={1}
          value={text}
          onChange={(e) => {
            if (recording) stopDictation();
            editText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            setDismissedSlashAt(null);
          }}
          onPaste={handlePaste}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // An input method's confirming Enter and arrows pick its own candidates, not a mention or command.
            if (imeComposing(e.nativeEvent)) return;
            if (commandPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((current) =>
                  (current + delta + commandCandidates.length) % commandCandidates.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCommand(commandCandidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedSlashAt(slash?.start ?? null);
                return;
              }
            }
            if (mentionPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            if (onClearReply && escapeCancelsReply(e.nativeEvent, { replying: Boolean(replyTo), recording })) {
              e.preventDefault();
              onClearReply();
              return;
            }
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            if (sendsMessage(e.nativeEvent, sendKey)) {
              e.preventDefault();
              if (
                canSteer &&
                doubleEnterSteersQueue(steerAgainUntilRef.current, Date.now(), pendingCount, hasContent)
              ) {
                steerAgainUntilRef.current = 0;
                steerQueued();
                return;
              }
              send();
            }
            if (e.key === "Escape" && recording) stopDictation();
          }}
          // Not disabled during an upload: a disabled element drops keyboard focus for good. send() refuses while one
          // is pending.
          disabled={blocking || locked}
          aria-busy={bot?.awaitingThreadSnapshot || undefined}
          placeholder={composerPlaceholder({
            simple: !advanced, locked: setupLocked, approval: blocking, attaching: attachmentPending, listening: recording,
            replying: Boolean(replyTo), busy, canSteer, queued: pendingCount > 0, busyName, sendLabel, group, members: members ?? [],
            jevOn: jevRoomRoutingOn(state.config), goal: channelMode === "goal", botName: bot?.name ?? "",
            setupHint: group ? null : setupRequestPlaceholder(bot, threadId),
          })}
          aria-label={t("composer.placeholder.bot", { name: group ? group.name : (bot?.name ?? "") })}
            className={cn(
              "block max-h-[9rem] w-full resize-none overflow-y-auto bg-transparent placeholder:text-ink-tertiary focus:outline-none",
              !simpleDock && "px-1 text-[15px]",
              simpleDock ? "min-h-7 px-0.5 py-1 text-[14px] leading-5" : "min-h-6 py-1 leading-6",
            )}
          />
          <div data-composer-actions className={cn("flex items-center", simpleDock ? "gap-2" : "gap-1", !singleRow && !simpleDock && "@max-[30rem]/composer:ml-auto", stacked && "ml-auto")}>
          {(simpleDock ? stoppable : busy) && !locked && (
          <button
            onClick={interruptTurn}
            aria-label={t("chat.stopTurn")}
            data-composer-stop={simpleDock ? (stopInSlot ? "slot" : "beside") : undefined}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full",
              !simpleDock ? "size-8 text-ink-secondary hover:bg-raised hover:text-ink"
                : stopInSlot ? cn("size-7", slot.button.className)
                : SIMPLE_CONTROL,
            )}
            style={stopInSlot ? slot.button.style : undefined}
            title={t("chat.stop")}
          >
            <Square size={simpleDock ? 10 : 14} className="fill-current" />
          </button>
        )}
        {!locked && !busy && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full",
              simpleDock ? "size-7" : "size-8",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : advanced || singleRow ? "text-ink-secondary hover:bg-raised hover:text-ink" : SIMPLE_CONTROL,
            )}
            title={recording ? t("composer.dictation.stopHint") : t("composer.dictation.hint")}
          >
            <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />
          </button>
        )}
        {callShown && bot && !group && <CallButton bot={bot} placement="composer" fill={advanced || singleRow ? undefined : slot.fill} ink={slot.ink} inverse={singleRow} />}
        {callShown && group && !advanced && <GroupCallButton group={group} members={members ?? []} placement="composer" fill={slot.fill} ink={slot.ink} />}
        {hasContent && !locked && (
          <button
            onClick={send}
            disabled={attachmentPending}
            aria-label={sendNames.label}
            title={sendNames.title}
            style={busy && !canSteer ? undefined : slot.button.style}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full disabled:cursor-default",
              simpleDock ? "size-7 animate-[slot-fade-in_120ms_ease-out]" : "size-8",
              busy && !canSteer ? "bg-raised text-ink-secondary hover:bg-raised-hover" : slot.button.className,
            )}
          >
            {busy && !canSteer ? <Clock size={simpleDock ? 14 : 15} /> : <ArrowUp size={16} strokeWidth={1.75} absoluteStrokeWidth />}
          </button>
          )}
          </div>
        </div>
        </div>
        </div>
        </div>
      </div>
      <div className="pointer-events-auto">
      {approvalDialogs}
      </div>
    </div>
  );
}
