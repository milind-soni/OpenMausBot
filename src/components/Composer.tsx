import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ArrowUp, Check, Clock, Hand, Mic, Paperclip, ShieldCheck, Square, Users, X } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  draftRevision,
  forgetFailedComposerSend,
  markDraftEdited,
  recoverFailedComposerSend,
  rememberFailedComposerSend,
  restoredSendId,
  useComposerDraft,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { MausAvatar } from "./Avatar";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  appendPastedText,
  composeMessage,
  imageAttachmentFromFile,
  intakeFiles,
  isImageFile,
  isLongPaste,
  pasteAttachment,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { normalizeState } from "@/lib/mascot";
import { groupComposerHint, roomRespondersForComposer } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ReplyQuote } from "./ReplyQuote";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

interface QueuedGroupSend {
  text: string;
  replyToId?: string;
  draft: ComposerDraftSnapshot;
}

/** Composer chip for Auto mode. Same `autoApprove` bit as the profile switch
 * — picking Auto mode here turns that on. The chip only changes its name,
 * not its color. */
function PermissionModeSelector({ bot, onSetAuto }: { bot: Bot; onSetAuto: (auto: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const on = Boolean(bot.autoApprove);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className="relative flex items-center" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={on ? "Auto mode" : "Ask for approval"}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline/20 bg-transparent px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {on ? <ShieldCheck size={14} className="opacity-70" /> : <Hand size={14} className="opacity-70" />}
        {on ? "Auto mode" : "Ask for approval"}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Permission mode for ${bot.name}`}
          className="absolute bottom-full left-0 z-30 mb-2 w-80 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
        >
          <div className="border-b border-hairline/20 px-4 py-3 text-[13px] font-medium text-ink-secondary">
            How should {bot.name} actions be approved?
          </div>
          <div className="flex flex-col py-1">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!on}
              onClick={() => {
                onSetAuto(false);
                setOpen(false);
              }}
              className="flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover"
            >
              <Hand size={16} className="mt-0.5 shrink-0 opacity-70" />
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-center justify-between text-[14px] text-ink">
                  Ask for approval
                  {!on && <Check size={14} />}
                </div>
                <div className="text-[13px] text-ink-secondary">Ask before actions that need your permission</div>
              </div>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => {
                onSetAuto(true);
                setOpen(false);
              }}
              className="flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover"
            >
              <ShieldCheck size={16} className="mt-0.5 shrink-0 opacity-70" />
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-center justify-between text-[14px] text-ink">
                  Auto mode
                  {on && <Check size={14} />}
                </div>
                <div className="text-[13px] text-ink-secondary">
                  Keep going automatically; destructive and sensitive actions still ask
                </div>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders the editable message composer and its pending attachments. */
export function Composer({
  bot,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  /** New rooms keep the composer inert until their setup is saved or skipped. */
  locked?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  // an engine with a live session takes a message INTO the running turn;
  // for those the composer never locks — the server steers instead of 409
  const canSteer =
    !group && Boolean(bot) && state.instances.find((i) => i.instanceId === bot!.modelSelection.instanceId)?.capabilities?.queueing === true;
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? "A bot")
    : (bot?.name ?? "The bot");
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const failedSends = useFailedComposerSends(draftId);
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
      // Shared recovery reaches a newly mounted view after navigation and
      // falls back to a separate retry item when a newer draft already exists.
      if (recoverFailedComposerSend(sent) === "restored" && sent.reply) {
        onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => editAttachments((prev) => [...prev, ...next]),
    [editAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => editAttachments((prev) => prev.filter((a) => a.id !== id)),
    [editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
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
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // image paste is offered only when every bot that will actually answer
  // can open one. sendGroup routes to mentions, else the room default —
  // `members.some` would let a mixed room send <attached-image> to Grok.
  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string) => {
    if (!group) return botSupportsImages(bot);
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const engineSupportsImages = imageTargetsSupport(text);

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  // one line at rest, then grow with the draft — hard cap at six lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const cap = line * 6;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [text]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // Rooms hold one message client-side while a member speaks; it auto-sends
  // the moment the room settles. 1:1 mid-turn sends still POST (the harness
  // queue), but stay off the transcript until drain — the chip here is the
  // pending row so they cannot become the active leaf mid-turn.
  const [queued, setQueued] = useState<QueuedGroupSend | null>(null);
  const queuedRef = useRef(queued);
  const clearQueued = useCallback(() => {
    queuedRef.current = null;
    setQueued(null);
  }, []);
  useEffect(
    () => () => {
      const unsent = queuedRef.current;
      if (unsent) restoreDraft(unsent.draft);
    },
    [draftId, restoreDraft],
  );
  const pendingChip = group
    ? queued?.text
    : bot
      ? state.pendingQueued?.[bot.threadId]?.map((entry) => entry.text).join("\n")
      : undefined;
  // a chip on its own is a message: the send control has to appear for it
  const fileInput = useRef<HTMLInputElement>(null);
  const [autoWarn, setAutoWarn] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  // Auto mode belongs to one bot; a room has several, each with its own.
  const autoBot = group ? undefined : bot;
  const pickFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const { attachments: added, notice } = await intakeFiles(Array.from(picked), {
      allowImages: engineSupportsImages,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    if (added.length) addAttachments(added);
    // Keep file-specific failures beside the attachments. A successful
    // overlapping intake must not erase an earlier failure before it is read.
    if (notice) setAttachmentNotice(notice);
  };
  const setAuto = (auto: boolean) => {
    if (!autoBot) return;
    // Turning it on for a bot that drives THIS computer is the one case that
    // has to be acknowledged first. The flag the dialog sends is stripped by
    // the reducer rather than stored, so — exactly like the settings panel —
    // the warning is shown on every switch-on, not just the first.
    if (auto && !autoBot.autoApprove && autoBot.computer === "local") {
      setAutoWarn(true);
      return;
    }
    dispatch({ type: "updateBot", botId: autoBot.id, patch: { autoApprove: auto } });
  };

  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const retryFailedSend = (failed: FailedComposerSend) => {
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText)) {
      dispatch({ type: "error", message: "The selected responder does not support image attachments." });
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
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
  };
  const send = () => {
    // A busy channel already has one locally held send. Keep any newer text
    // as an editable draft until that send is dispatched; replacing the slot
    // here would silently lose the first message.
    if (locked || (group && queued)) return;
    if (attachments.some((attachment) => attachment.kind === "image") && !imageTargetsSupport(text)) {
      dispatch({ type: "error", message: "The selected responder does not support image attachments." });
      return;
    }
    const t = composeMessage(text, attachments);
    if (!t) return;
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? crypto.randomUUID(),
      text,
      requestText: t,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
    };
    if (busy && group) {
      const pending = { text: t, replyToId: replyTo?.id, draft: sentDraft };
      queuedRef.current = pending;
      setQueued(pending);
      setText("");
      setAttachments([]);
      onConsumeReply?.();
      return;
    }
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: t,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { room: true });
    } else if (bot) {
      dispatch({
        type: "send",
        botId: bot.id,
        text: t,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer });
    }
    setText("");
    setAttachments([]);
    onConsumeReply?.();
  };
  useEffect(() => {
    if (busy || !queued) return;
    if (group) {
      if (queued.text.includes("<attached-image ") && !imageTargetsSupport(queued.text)) {
        dispatch({ type: "error", message: "The selected responder does not support image attachments." });
        clearQueued();
        restoreDraft(queued.draft);
        return;
      }
      clearQueued();
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: queued.text,
        sendId: queued.draft.sendId,
        replyToId: queued.replyToId,
        threadId: queued.draft.threadId,
        onError: () => restoreDraft(queued.draft),
      });
      track("message_sent", { room: true, queued: true });
    }
  }, [busy, queued, group, members, state.instances, dispatch, clearQueued, restoreDraft]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        editText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError("Dictation is only available on macOS for now.");
      } else if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording, editText]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError("Dictation isn't available in this build.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  return (
    <div className="pointer-events-none relative px-5 pb-3">
      {/* No fill or hairline on this wrapper — those were the black frame
          in the pill's top corners. The dock overlays the transcript. */}
      {speechError && (
        <div className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="pointer-events-auto relative w-full">
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
          >
            <span className="min-w-0 flex-1 truncate">
              Not sent: “{failed.text.trim() || "attachment"}”
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label="Dismiss failed message"
              title="Dismiss"
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        {pendingChip && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Queued — sends when {busyName} finishes: “{pendingChip}”
            </span>
            <button
              type="button"
              onClick={() => {
                if (group) {
                  clearQueued();
                  return;
                }
                if (!bot) return;
                for (const entry of state.pendingQueued?.[bot.threadId] ?? []) {
                  dispatch({ type: "cancelQueued", botId: bot.id, queueId: entry.queueId });
                }
              }}
              aria-label="Cancel queued message"
              title="Cancel queued message"
              className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        )}
        {pickerOpen && (
          <div
            role="listbox"
            aria-label="Tag a bot"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {peer.bot ? (
                  <MausAvatar
                    color={peer.bot.color}
                    state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">{peer.bot ? "Agent" : "Channel"}</span>
              </button>
            ))}
          </div>
        )}
        {/* An approval takes over the composer: you answer it before you
            can type again, so a waiting bot is impossible to miss. */}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              onCancelTurn={() => {
                if (group) dispatch({ type: "interruptGroup", groupId: group.id });
                else if (bot) dispatch({ type: "interrupt", botId: bot.id });
              }}
            />
          </div>
        )}
        {replyTo && (
          <div className="mb-2 px-1">
            <ReplyQuote
              message={replyTo}
              fallbackName={bot?.name}
              onClear={onClearReply}
            />
          </div>
        )}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
        />
        <div className="relative">
          {/* App-ground from the pill's bottom radius down, full-bleed.
              Bubbles may tuck into the pill; they must not paint under it. */}
          <div
            aria-hidden
            className="absolute -left-5 -right-5 top-[calc(100%-1.5rem)] h-[50vh] bg-app"
          />
        <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-3xl bg-raised px-3 pb-2 pt-1">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickFiles(e.target.files);
              // same file twice in a row still fires onChange
              e.target.value = "";
            }}
          />
          {!locked && (
            <div className="col-start-1 row-start-2 mt-1 flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                aria-label="Attach a file"
                title="Attach a file"
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <Paperclip size={17} />
              </button>
              {autoBot && <PermissionModeSelector bot={autoBot} onSetAuto={setAuto} />}
            </div>
          )}
          <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            editText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onPaste={(e) => {
            // an image from the clipboard becomes an uploaded attachment —
            // but only for engines that can open one; a grok bot politely
            // refuses instead of receiving a path it cannot read
            const imageFiles = Array.from(e.clipboardData.files).filter(isImageFile);
            if (imageFiles.length && engineSupportsImages) {
              e.preventDefault();
              void (async () => {
                for (const file of imageFiles) {
                  try {
                    const attachment = await imageAttachmentFromFile(file);
                    if (attachment) editAttachments((prev) => [...prev, attachment]);
                  } catch (err) {
                    dispatch({
                      type: "error",
                      message: err instanceof Error ? err.message : "image upload failed",
                    });
                  }
                }
              })();
              return;
            }
            // a wall of text becomes a chip instead of burying the input
            const pasted = e.clipboardData.getData("text/plain");
            if (!isLongPaste(pasted)) return;
            e.preventDefault();
            // Preserve native paste replacement semantics: if text was
            // selected, the attachment replaces that selection.
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            if (start !== end) {
              editText(`${text.slice(0, start)}${text.slice(end)}`);
              setCaret(start);
            }
            editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (pickerOpen) {
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
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Shift+Enter inserts a newline; plain Enter sends
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          disabled={Boolean(approval) || locked}
          placeholder={
            locked
              ? "Finish room setup to start chatting"
              : approval
              ? "Answer the approval above to continue"
              : recording
              ? "Listening…"
              : busy && canSteer
                ? `${busyName} is working — Enter sends this into the running turn`
              : busy
                ? group
                  ? `${busyName} is working — Enter queues your message`
                  : `${busyName} is working — sends when this turn finishes`
                : group
                  ? `Message ${group.name} — ${groupComposerHint(group, members ?? [])}`
                  : `Message ${bot?.name ?? ""}`
          }
          aria-label={`Message ${group ? group.name : (bot?.name ?? "")}`}
            className="col-span-full row-start-1 max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto self-center bg-transparent px-1 py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <div className="col-start-3 row-start-2 mt-1 flex items-center gap-1">
          {busy && !locked && (
          <button
            onClick={() => {
              if (group) dispatch({ type: "interruptGroup", groupId: group.id });
              else if (bot) dispatch({ type: "interrupt", botId: bot.id });
            }}
            aria-label="Stop this turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {!locked && !busy && !hasContent && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? "Stop dictation" : "Start dictation"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
          >
            <Mic size={18} />
          </button>
        )}
        {hasContent && !locked && (
          <button
            onClick={send}
            disabled={Boolean(group && queued)}
            aria-label={
              group && queued
                ? "Waiting for queued message"
                : busy && canSteer
                  ? "Send into the running turn"
                  : busy
                    ? "Queue message"
                    : "Send message"
            }
            title={
              group && queued
                ? "Your earlier message will send when the current turn finishes"
                : busy && canSteer
                  ? "Send into the running turn"
                  : busy
                    ? "Sends when the current turn finishes"
                    : "Send"
            }
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full text-white",
              group && queued
                ? "cursor-not-allowed bg-raised text-ink-secondary"
                : busy && !canSteer
                  ? "bg-raised text-ink-secondary hover:bg-raised-hover"
                  : "bg-accent hover:brightness-110",
            )}
          >
            {busy && !canSteer ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
          )}
          </div>
        </div>
        </div>
      </div>
      <div className="pointer-events-auto">
      <LocalComputerAutoWarning
        open={autoWarn}
        onCancel={() => setAutoWarn(false)}
        onConfirm={() => {
          if (autoBot) {
            dispatch({
              type: "updateBot",
              botId: autoBot.id,
              patch: { autoApprove: true, acknowledgeLocalAuto: true },
            });
          }
          setAutoWarn(false);
        }}
      />
      </div>
    </div>
  );
}
