import { openBot } from "@/state/thread-navigation";
import { directMessageSent, roomMessageSent } from "@/lib/product-events";
import { TeamAudienceLabel } from "./TeamSideSwitch";
import { useComposerDictation } from "@/lib/use-composer-dictation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type SetStateAction } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Eye, Mic, Pencil, Square, X } from "lucide-react";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select"; import { useStoreRef } from "@/state/store-ref"; import { sameDrawnBots } from "@/lib/drawn-bots";
import { visibleMessages, currentTaskBot, type Bot, type Group, type InstanceInfo, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { useMenuMotion } from "./MenuMotion";
import { ELEVATED_CARD, ELEVATED_FLOAT } from "./elevated";
import { uploadDraftImage } from "@/lib/composer-uploads";
import { intakeFilesWithNotice } from "@/lib/attach-notice";
import { activeLocale, t } from "@/lib/i18n";
import { imeComposing, sendKeyLabel, sendsMessage, useSendKey } from "@/lib/send-key";
import {
  draftRevision,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  forgetFailedComposerSend,
  markDraftEdited,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  restoredSendId,
  restoredRequestText,
  useComposerDraft,
  useComposerChannelMode,
  useDraftAttachmentPending,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { DEVS_CHOICE, MentionMenu, teammateChoices, type MentionChoice } from "./MentionMenu"; import { useTeammates } from "@/state/team-people"; import { hiddenFromSidebar, useViewerEmail } from "@/lib/default-bot"; import { useMayAct } from "./shared-run";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { MentionTextarea } from "./MentionTextarea";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { PointedChips } from "./app/PointedChips"; import { SetupRequestChip, setupRequestPlaceholder } from "./SetupOffer";
import { takePointedChips } from "@/lib/pointed-chips";
import { openPageFor } from "@/lib/open-page";
import type { CitationAttachment } from "@/lib/citations";
import {
  appendPastedText,
  clipboardFilesToAttach,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  dataContextFor,
  discardUnsentUpload,
  composerShouldRefocus,
  composerTakesFocusOnOpen,
  imageBytesLeft,
  imageSlotsLeft,
  imagesThatFit,
  replyTargetTakesFocus,
  isLongPaste,
  pasteAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { goalCoordinatorForComposer, jevRoomRoutingOn, openTaskWorking, roomRouteForComposer } from "@/lib/group-routing";
import { composerPlaceholder } from "./composer-simple"; import { ComposerSendButton } from "./ComposerSendButton"; import { ComposerContextMenu } from "./ComposerContextMenu";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { CallButton } from "./CallView";
import { PhonePlus } from "./PhonePlus";
import { useThreadApproval } from "./thread-approval";
import { useStackedField } from "./composer-wrap";
import { ComposerReplyStrip } from "./ReplyQuote";
import { escapeCancelsReply } from "@/lib/replies";
import { useThreadRefs } from "./ThreadRefs";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { mentionChoicesForQuery, mentionQueryAt } from "@/lib/mentions"; import { mentionPicksFor, restoreMentionPicks } from "@/lib/mention-picks";
import { serializeThreadRefs, threadTokenFromPaste, threadTokenSpacing } from "@/lib/thread-refs";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  builtInCommandText,
  replaceComposerSlashTrigger,
  skillSlashCommands,
  slashCommandMatches,
  type ComposerSlashCommand,
} from "@/lib/composer-commands";
import { useSlashSkills } from "@/lib/use-slash-skills";
import { randomUuid } from "@/lib/random-uuid";

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
  smoothHeight = false,
  onSendFrom,
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
  smoothHeight?: boolean;
  onSendFrom?: (sendId: string, input: HTMLTextAreaElement) => void;
}) {
  const bot = profile ? currentTaskBot(profile) : undefined;
  const locked = setupLocked || Boolean(bot?.awaitingThreadSnapshot);
  const state = useStoreSelector((s) => ({ instances: s.instances, config: s.config }), sameFields), dispatch = useStoreDispatch(), store = useStoreRef(), bots = useStoreSelector((s) => s.bots, sameDrawnBots);
  const { threads, currentBotId } = useThreadRefs();

  // On a phone the composer is a dock: a round + (attach and every other tool), then one pill with the field, the mic and the voice button.
  const singleRow = useMediaQuery(PHONE_LAYOUT);

  const sendKey = useSendKey();
  const sendLabel = sendKeyLabel(sendKey);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  const currentGroupTask = group?.tasks?.find((task) => task.threadId === threadId);
  const groupBusyBotId = currentGroupTask?.busyBotId ?? (currentGroupTask?.working ? group?.busyBotId : (group?.threadId === threadId ? group?.busyBotId : null));
  const groupWorking = group ? openTaskWorking(group) : false;
  const busy = group ? Boolean(groupWorking || groupBusyBotId) : Boolean(bot?.busy);
  const composerTask = profile?.tasks?.find((task) => task.threadId === threadId);
  // Visible branch only: an approval left on an abandoned branch must not block the composer.
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  // A Turn on card can wait while the person walks to their computer: they can still write meanwhile.
  const blocking = Boolean(approval && !approval.message.card?.computerAsk);
  const asker = useStoreSelector((s) => s.bots.find((one) => one.id === approval?.message.inbox?.from.botId)), approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === groupBusyBotId)
    : asker ?? bot;
  const busyName = group
    ? (members?.find((b) => b.id === groupBusyBotId)?.name ??
      (groupWorking ? t("composer.busy.team") : t("composer.busy.aBot")))
    : (bot?.name ?? t("composer.busy.theBot"));
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot && !state.config?.team ? `bot:${bot.id}` : undefined,
  );
  const [previewDraft, setPreviewDraft] = useState<string | null>(null);
  const attachmentPending = useDraftAttachmentPending(draftId);
  const failedSends = useFailedComposerSends(draftId); const picks = mentionPicksFor(draftId);
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
        restoreMentionPicks(sent.draftId, sent.mentions); if (sent.reply) onRestoreReply?.(sent.reply, sent.threadId);
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
  const { recording, ready: micReady, speechError, toggle: toggleMic, stop: stopDictation } = useComposerDictation({ draftId, text, onText: editText });
  const [caret, setCaret] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const frame = shell?.parentElement;
    if (!smoothHeight || singleRow || !shell || !frame || typeof ResizeObserver === "undefined") return;
    const resize = () => frame.style.setProperty("--composer-height", `${shell.getBoundingClientRect().height}px`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      frame.style.removeProperty("--composer-height");
    };
  }, [smoothHeight, singleRow]);

  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stacked = useStackedField(inputRef, !singleRow, text);
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
      return botSupportsImages(goalCoordinatorForComposer(message, members ?? [], group, picks.ids(message)) ?? undefined);
    }
    const route = roomRouteForComposer(message, members ?? [], group, picks.ids(message));
    return route.ambiguous || (route.responders.length > 0 && route.responders.every(botSupportsImages));
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
    const builtIns = slash.start === 0; // Built-in commands only work at the start of a message; skills can be named anywhere.
    if (builtIns && !group?.dm) available.push({
      kind: "command",
      id: "goal",
      label: "/goal",
      description: t(group ? "composer.command.goalDesc" : "composer.command.goalBotDesc"),
    });
    if (builtIns && canLearn) {
      available.push({
        kind: "command",
        id: "learn",
        label: "/learn",
        description: t("composer.command.learnDesc"),
      });
    }
    if (builtIns && !group && supportsAgents(state.instances, bot)) available.push({
      kind: "command",
      id: "setup",
      label: "/setup",
      description: t("composer.command.setupDesc"),
    }, { kind: "command", id: "burst", label: "/burst", description: t("composer.command.burstDesc") });
    available.push(...skillSlashCommands(slashSkills));
    return available.filter((command) => slashCommandMatches(command, slash.query));
  }, [slash, dismissedSlashAt, group, bot, canLearn, state.instances, locale, slashSkills]);
  const preview = previewDraft === draftId && Boolean(text.trim());
  const commandPickerOpen = !preview && commandCandidates.length > 0;

  const mention = mentionQueryAt(text, caret); const teammates = useTeammates(); const viewer = useViewerEmail();
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          ...(!group.dm ? [{ id: "__everyone__", name: "everyone" }] : []),
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : bots
          .filter((member) => member.id !== bot?.id && !member.hidden && !hiddenFromSidebar(member, viewer))
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    return mentionChoicesForQuery([...pool, ...teammateChoices(teammates.people), DEVS_CHOICE], mention.query);
  }, [mention, dismissedAt, bots, bot?.id, group, members, teammates, viewer]);
  const mentionEveryoneCount = (members ?? []).filter((member) => !member.hidden).length;
  const mentionPickerOpen = !preview && candidates.length > 0;
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
    picks.pick(peer); editText(next);
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
    const spaceAfter = /^\s/.test(text.slice(slash.end)) ? "" : " ";
    const replacement = command.kind === "skill" ? `${command.label}${spaceAfter}`
      : builtInCommandText(command.id);
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
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(learn.length, learn.length); });
  };

  const sharedChat = Boolean(state.config?.team && !group && profile?.tasks?.some((task) => task.threadId === threadId && !task.private));
  const interruptTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
  };
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const modeBot = group ? undefined : bot;
  const { choice: approvalChoice, dialogs: approvalDialogs } = useThreadApproval(modeBot);
  const uploadImage = useCallback((file: File) => uploadDraftImage(draftId, file), [draftId]);
  const pickFiles = async (picked: FileList | readonly File[] | null) => {
    if (!picked?.length) return;
    changeDraftAttachmentPending(draftId, true);
    try {
      const { attachments: added, notice } = await intakeFilesWithNotice(Array.from(picked), {
        allowImages: engineSupportsImages,
        getPath: pathForFile,
        uploadImage,
        imageSlots: imageSlotsLeft(attachments),
        imageBytes: imageBytesLeft(attachments),
      });
      if (added.length) addAttachments(added);
      if (notice) setAttachmentNotice(notice);
    } finally {
      changeDraftAttachmentPending(draftId, false);
    }
    refocusInput();
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void pickFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  };
  const hasContent = Boolean(effectiveText.trim()) || attachments.length > 0;
  const showSend = hasContent && !locked;
  const mayAct = useMayAct(), mayStop = !sharedChat || mayAct(profile?.tasks?.find((task) => task.threadId === threadId)?.askedBy);


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
      threadId: failed.threadId, mentions: failed.mentions,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId, mentions: failed.mentions,
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
    const dataContext = dataContextFor(body, store.state().computerOpen ? store.state().dataView : null, !group && bot ? { botId: bot.id, threadId } : undefined);
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? randomUuid(),
      text,
      requestText: body,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
      channelMode: effectiveChannelMode, mentions: picks.ids(body),
    };
    if (group) {
      const points = effectiveChannelMode === "goal" ? null : takePointedChips(threadId);
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        mode: effectiveChannelMode, mentions: sentDraft.mentions,
        ...(points ? { pointed: points.pointed } : {}),
        onError: () => { points?.restore(); restoreDraft(sentDraft); },
      });
      roomMessageSent(effectiveChannelMode, false);
    } else if (bot) {
      const points = effectiveChannelMode === "goal" ? null : takePointedChips(threadId);
      const page = effectiveChannelMode === "goal" ? undefined : openPageFor(threadId);
      if (inputRef.current) onSendFrom?.(sentDraft.sendId, inputRef.current);
      dispatch({
        type: "send", botId: bot.id, text: body, sendId: sentDraft.sendId, replyToId: replyTo?.id, threadId, dataContext, mode: effectiveChannelMode, mentions: sentDraft.mentions,
        ...(points ? { pointed: points.pointed } : {}), ...(page ? { openPage: page } : {}),
        onError: () => { points?.restore(); restoreDraft(sentDraft); },
      });
      directMessageSent(state.instances, bot.modelSelection?.instanceId, false);
    }
    setPreviewDraft(null);
    setText("");
    setAttachments([]); picks.clear();
    onConsumeReply?.();
    setChannelMode("chat");
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = clipboardFilesToAttach(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void pickFiles(pastedFiles);
      return;
    }
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
      const kept = imagesThatFit(imageFiles, imageSlotsLeft(attachments), setAttachmentNotice, imageBytesLeft(attachments));
      changeDraftAttachmentPending(draftId, true);
      void (async () => {
        try {
          const results = await Promise.allSettled(kept.map(uploadImage));
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

  const toolsMenu = !locked && (
    <PhonePlus
      onAttach={() => fileInput.current?.click()}
      onChoosePhoto={singleRow ? () => photoInput.current?.click() : undefined}
      onTakePhoto={singleRow ? () => cameraInput.current?.click() : undefined}
      goal={goal}
      teach={canLearn ? teachTask : undefined}
      approval={approvalChoice && modeBot && { name: modeBot.name, choice: approvalChoice }}
      callBotId={bot && !group ? bot.id : undefined}
      place={modeBot && !remoteClient ? {
        bot: modeBot,
        task: composerTask,
        disabled: Boolean(modeBot.busy),
        onPin: (surface) => dispatch({ type: "updateTask", botId: modeBot.id, threadId: modeBot.threadId, patch: { surface } }),
      } : undefined}
    />
  );

  return (
    <div data-composer-footer className="pointer-events-none relative px-5 pb-3 max-md:px-3 [[data-phone-keyboard]_&]:pb-0">
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
              className="shrink-0 rounded px-2 py-1 font-medium interaction:bg-danger/10"
            >
              {t("chat.retry")}
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label={t("composer.failed.dismissAria")}
              title={t("composer.failed.dismiss")}
              className="flex size-5 shrink-0 items-center justify-center rounded interaction:bg-danger/10"
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
          <div className={cn("mb-2 overflow-hidden rounded-[18px]", ELEVATED_CARD)}>
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
        <PointedChips threadId={threadId} />{!group && bot && <SetupRequestChip bot={bot} threadId={threadId} />}
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
        <TeamAudienceLabel bot={bot} group={group} />
        <div className={cn("relative", smoothHeight && !singleRow && "v2-composer-frame")}>
          {/* Plain canvas behind the composer and the strip below it, so the transcript ends at the composer
              with no fade. */}
          <div
            aria-hidden
            data-composer-backdrop
            className={cn("pointer-events-none absolute -left-5 -right-5 bg-app", "-bottom-3 top-1/2")}
          />
        <div ref={shellRef} data-tour="composer" data-look="composer" className={cn("@container/composer relative z-[1]", singleRow ? "flex min-w-0 items-center gap-2 pb-1 [[data-phone-keyboard]_&]:pb-0" : cn("rounded-2xl px-2 py-1.5", !smoothHeight && ELEVATED_FLOAT))}>
        {singleRow && toolsMenu}
        <div className={singleRow ? cn("min-w-0 flex-1 rounded-[26px] px-3 py-1.5 [--composer-reply-gap:6px]", ELEVATED_FLOAT) : "contents"}>
        {replyTo && <ComposerReplyStrip message={replyTo} fallbackName={bot?.name} onClear={onClearReply} />}
        <div data-composer-row className={cn("flex items-center gap-1", !singleRow && "@max-[30rem]/composer:flex-wrap", stacked && "flex-wrap")}>
          {singleRow && !locked && <>
            <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,image/bmp,image/tiff,image/svg+xml" multiple hidden onChange={onPickFiles} />
            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onPickFiles} />
          </>}
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={onPickFiles}
          />
          {!singleRow && toolsMenu}
          {preview && <div data-composer-markdown-preview tabIndex={0} aria-label={t("composer.markdown.preview")} dir="auto"
            className="chat-md max-h-36 min-w-0 flex-1 overflow-auto px-1 py-1 text-[15px] [overflow-wrap:anywhere] [&>*+*]:mt-2">
            <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
              a: ({ children }) => <span>{children}</span>,
              img: ({ alt }) => <span>{alt}</span>,
            }}>{text}</Markdown>
          </div>}
          <MentionTextarea
          smoothHeight={smoothHeight && singleRow}
          singleLinePlaceholder={singleRow}
          wrapperClassName={cn(preview && "hidden", !singleRow && cn("@max-[30rem]/composer:order-first @max-[30rem]/composer:basis-full", stacked && "order-first basis-full"))}
          inputRef={inputRef}
          onOpenBot={(id) => {
            const mentioned = store.state().bots.find(candidate => candidate.id === id && !candidate.hidden);
            if (mentioned) openBot(dispatch, mentioned, false);
          }}
          peers={[...(group ? members ?? [] : bots.filter((member) => member.id !== bot?.id)), ...teammates.peers]}
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
              send();
            }
            if (e.key === "Escape" && recording) stopDictation();
          }}
          // Not disabled during an upload: a disabled element drops keyboard focus for good. send() refuses while one
          // is pending.
          disabled={blocking || locked}
          aria-busy={bot?.awaitingThreadSnapshot || undefined}
          placeholder={composerPlaceholder({
            locked: setupLocked, approval: blocking, attaching: attachmentPending, listening: recording,
            replying: Boolean(replyTo), busy, busyName, sendLabel, group, members: members ?? [],
            jevOn: jevRoomRoutingOn(state.config), goal: channelMode === "goal", botName: bot?.name ?? "",
            setupHint: group ? null : setupRequestPlaceholder(bot, threadId),
          })}
          aria-label={t("composer.placeholder.bot", { name: group ? group.name : (bot?.name ?? "") })}
            className={cn(
              "block max-h-[9rem] w-full resize-none overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-transparent placeholder:text-ink-tertiary focus:outline-none",
              "px-1 text-[15px]",
              "min-h-6 py-1 leading-6",
            )}
          />
          <div data-composer-actions className={cn("flex items-center", "gap-1", !singleRow && "@max-[30rem]/composer:ml-auto", stacked && "ml-auto")}>
        {!locked && Boolean(text.trim()) && (
          <button type="button" aria-label={t(preview ? "composer.markdown.edit" : "composer.markdown.preview")}
            title={t(preview ? "composer.markdown.edit" : "composer.markdown.preview")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary interaction:bg-raised/50 hover:text-ink"
            onClick={() => {
              setPreviewDraft(preview ? null : draftId);
              if (preview) requestAnimationFrame(() => inputRef.current?.focus());
            }}>
            {preview ? <Pencil size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        )}
        {!locked && <ComposerContextMenu bot={bot} group={group} members={members} className={cn("size-8", "text-ink-secondary interaction:bg-raised/50 hover:text-ink")} />}
        {!locked && !busy && micReady && (
          <button
            onClick={toggleMic}
            aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full",
              "size-8",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary interaction:bg-raised/50 hover:text-ink",
            )}
            title={recording ? t("composer.dictation.stopHint") : t("composer.dictation.hint")}
          >
            <Mic size={16} strokeWidth={1.75} absoluteStrokeWidth className="[&_rect]:fill-current" />
          </button>
        )}
        {!showSend && (busy && mayStop && !locked ? (
          <button type="button" onClick={interruptTurn} aria-label={t("chat.stopTurn")} title={t("chat.stop")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black text-white">
            <Square size={11} fill="currentColor" aria-hidden="true" />
          </button>
        ) : bot && !group && <CallButton bot={bot} placement="composer" inverse />)}

        {showSend && (
          <ComposerSendButton label={t("composer.send.message")} title={`${t("chat.send")} (${sendLabel})`}
            disabled={attachmentPending} onSend={send} />
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
