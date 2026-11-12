import { ScheduleSheet } from "./ScheduleSheet";
import { track } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Clock, Mic, Paperclip, Square, X } from "lucide-react";
import { useStore, type Attachment, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { insertProjectMention, projectMentionQueryAt } from "@/lib/projectMentions";
import { insertTaskMention, taskMentionQueryAt } from "@/lib/taskMentions";
import { useProjects } from "@/state/projects";
import { ProjectSuggestionList } from "./ProjectSuggestionList";
import { StagedAttachmentsTray } from "./AttachmentViewer";
import { readFileAsAttachment } from "@/lib/attachments";
import { draftKey, getQueued, loadDraft, saveDraft, setQueued as setQueuedFor, subscribeQueue } from "@/lib/composerDrafts";

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

export function Composer({
  bot,
  group,
  members,
  onEditLast,
  pendingAttachment,
  onPendingAttachmentConsumed,
  pendingText,
  onPendingTextConsumed,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  /** An attachment produced outside the composer (e.g. a mobile-preview
   * screenshot) waiting to be staged. Cleared via onPendingAttachmentConsumed
   * once it's been added, so the caller can hand off a new one later. */
  pendingAttachment?: Attachment | null;
  onPendingAttachmentConsumed?: () => void;
  /** Text to drop into the composer for the user to edit and send (e.g. a
   * starter suggestion). Cleared via onPendingTextConsumed once staged. */
  pendingText?: string | null;
  onPendingTextConsumed?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { projects } = useProjects();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers the members (Buzz rule: only mentioned bots reply).
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? "A bot")
    : (bot?.name ?? "The bot");
  // Drafts are kept per conversation, so switching away and back restores them.
  const draftId = draftKey({ botId: bot?.id, groupId: group?.id });
  const [initialDraft] = useState(() => loadDraft(draftId));
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [text, setText] = useState(initialDraft.text);
  const [attachments, setAttachments] = useState<Attachment[]>(initialDraft.attachments);
  const [isDragging, setIsDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const botMention = mentionQueryAt(text, caret);
  const projectMention = projectMentionQueryAt(text, caret);
  const taskMention = taskMentionQueryAt(text, caret);
  // whichever trigger sits closest to the caret wins (matches typing order)
  const mentionKind: "bot" | "project" | "task" = (() => {
    const present: Array<readonly ["bot" | "project" | "task", number]> = [
      ...(botMention ? ([["bot", botMention.start]] as const) : []),
      ...(projectMention ? ([["project", projectMention.start]] as const) : []),
      ...(taskMention ? ([["task", taskMention.start]] as const) : []),
    ];
    if (!present.length) return "bot";
    return present.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
  })();
  const mention = mentionKind === "project" ? projectMention : mentionKind === "task" ? taskMention : botMention;
  const botCandidates = useMemo(() => {
    if (mentionKind !== "bot" || !botMention || dismissed === `bot:${botMention.start}`) return [];
    const pool = group ? (members ?? []) : state.bots.filter((b) => b.id !== bot?.id && !b.hidden);
    const q = botMention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (botMention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [botMention, dismissed, state.bots, bot?.id, group, members, mentionKind]);
  const projectCandidates = useMemo(() => {
    if (mentionKind !== "project" || !projectMention || dismissed === `project:${projectMention.start}`) return [];
    const q = projectMention.query.toLowerCase();
    return (projects ?? [])
      .filter((project) => !q || project.mention.includes(q) || project.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [dismissed, mentionKind, projectMention, projects]);
  const taskCandidates = useMemo(() => {
    if (mentionKind !== "task" || !taskMention || dismissed === `task:${taskMention.start}`) return [];
    const q = taskMention.query.toLowerCase();
    return state.tasks
      .filter((task) => !q || task.mention.includes(q) || task.title.toLowerCase().includes(q))
      .slice(0, 6);
  }, [dismissed, mentionKind, taskMention, state.tasks]);
  const candidateCount =
    mentionKind === "project" ? projectCandidates.length : mentionKind === "task" ? taskCandidates.length : botCandidates.length;
  const pickerOpen = candidateCount > 0;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  // grow the textarea with its content (capped by max-h in the className)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const pickBotMention = (peer: Bot) => {
    if (!botMention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, botMention.start)}@${peer.name} ${after}`;
    setText(next);
    const newCaret = botMention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissed(`bot:${botMention.start}`);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickProjectMention = (projectMentionHandle: string) => {
    if (!projectMention) return;
    const next = insertProjectMention(text, caret, projectMention, projectMentionHandle);
    setText(next.text);
    setCaret(next.caret);
    setDismissed(`project:${projectMention.start}`);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const pickTaskMention = (taskMentionHandle: string) => {
    if (!taskMention) return;
    const next = insertTaskMention(text, caret, taskMention, taskMentionHandle);
    setText(next.text);
    setCaret(next.caret);
    setDismissed(`task:${taskMention.start}`);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    try {
      const read = await Promise.all(list.map((f) => readFileAsAttachment(f)));
      setAttachments((prev) => [...prev, ...read]);
    } catch (e) {
      console.error("Failed to read attachments:", e);
    }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  useEffect(() => {
    if (!pendingAttachment) return;
    setAttachments((prev) => [...prev, pendingAttachment]);
    onPendingAttachmentConsumed?.();
  }, [pendingAttachment, onPendingAttachmentConsumed]);

  useEffect(() => {
    if (!pendingText) return;
    setText(pendingText);
    setCaret(pendingText.length);
    onPendingTextConsumed?.();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pendingText.length, pendingText.length);
    });
  }, [pendingText, onPendingTextConsumed]);

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      addFiles(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  // One message may be queued while the bot works; it auto-sends the moment
  // the turn settles. Enter during a turn queues instead of silently dying.
  // The queue lives in composerDrafts and is drained by the app shell, so it
  // still sends if the user switches to another conversation meanwhile.
  const queueTarget = useMemo(() => (group ? { groupId: group.id } : { botId: bot?.id ?? "" }), [group, bot?.id]);
  const queued = useSyncExternalStore(subscribeQueue, () => getQueued(draftId));
  const setQueued = (message: { text: string; attachments: Attachment[] } | null) => setQueuedFor(queueTarget, message);
  useEffect(() => saveDraft(draftId, { text, attachments }), [draftId, text, attachments]);
  const send = () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
    if (busy) {
      setQueued({ text: t, attachments: attachments });
      setText("");
      setAttachments([]);
      return;
    }
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, text: t, attachments: currentAttachments });
      track("message_sent", { room: true, hasAttachments: Boolean(currentAttachments?.length) });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, text: t, attachments: currentAttachments });
      track("message_sent", { driver: bot.modelSelection?.instanceId, hasAttachments: Boolean(currentAttachments?.length) });
    }
    setText("");
    setAttachments([]);
  };

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.gbs;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
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
  }, [recording]);

  const toggleMic = () => {
    if (!window.gbs) {
      setSpeechError("Voice input is available in the desktop app.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  const hasContent = Boolean(text.trim() || attachments.length > 0);

  return (
    <div
      className="px-5 pb-5 pt-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {speechError && (
        <div className="mx-auto mb-2 max-w-[900px] rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="relative mx-auto max-w-[900px]">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFilesSelected}
          className="hidden"
          aria-label="Upload files or images"
        />

        {/* Staged attachments tray */}
        <StagedAttachmentsTray attachments={attachments} onRemove={handleRemoveAttachment} />

        {queued && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Queued — sends when {busyName} finishes: “{queued.text || (queued.attachments.length ? `[${queued.attachments.length} attachment(s)]` : "")}”
            </span>
            <button
              onClick={() => setQueued(null)}
              aria-label="Discard queued message"
              className="rounded p-0.5 hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        )}
        {pickerOpen && mentionKind === "project" && (
          <ProjectSuggestionList
            projects={projectCandidates}
            highlight={highlight}
            onHighlight={setHighlight}
            onPick={(project) => pickProjectMention(project.mention)}
            className="absolute bottom-full left-2 mb-2"
          />
        )}
        {pickerOpen && mentionKind === "task" && (
          <div
            role="listbox"
            aria-label="Reference a task"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {taskCandidates.map((task, i) => (
              <button
                key={task.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickTaskMention(task.mention)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{task.title}</span>
                <span className="shrink-0 text-xs text-ink-secondary capitalize">{task.status}</span>
              </button>
            ))}
          </div>
        )}
        {pickerOpen && mentionKind === "bot" && (
          <div
            role="listbox"
            aria-label="Tag a bot"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {botCandidates.map((peer, i) => (
              <button
                key={peer.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickBotMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                <MausAvatar color={peer.color} state={normalizeState(peer.mascotExpression) ?? "happy"} size={24} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">Agent</span>
              </button>
            ))}
          </div>
        )}
        <div
          className={cn(
            "flex items-end gap-2 rounded-3xl border bg-raised/60 py-2 pl-2 pr-2 transition-all",
            isDragging ? "border-accent ring-2 ring-accent/30 bg-accent/5" : "border-hairline/40",
          )}
        >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach images or files"
          title="Attach files or images"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none"
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissed(null);
          }}
          onPaste={handlePaste}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidateCount) % candidateCount);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (mentionKind === "project") pickProjectMention(projectCandidates[highlight].mention);
                else if (mentionKind === "task") pickTaskMention(taskCandidates[highlight].mention);
                else pickBotMention(botCandidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(mention ? `${mentionKind}:${mention.start}` : null);
                return;
              }
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !text && !attachments.length && onEditLast) {
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
          placeholder={
            recording
              ? "Listening…"
              : isDragging
                ? "Drop files to attach…"
                : busy
                  ? `${busyName} is working — Enter queues your message`
                  : group
                    ? `Message ${group.name} — @ for bots, # for projects`
                    : `Message ${bot?.name ?? ""} — # for projects`
          }
          aria-label={`Message ${group ? group.name : (bot?.name ?? "")}`}
          className="max-h-40 w-full resize-none self-center bg-transparent py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {busy && (
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
        {!busy && !hasContent && (
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
        {hasContent && <button type="button" disabled={!text.trim() || attachments.length > 0} onClick={() => setScheduleOpen(true)} aria-label="Send later…" title={attachments.length ? "Scheduled messages currently support text only" : "Send later…"} className="rounded-full p-2 text-ink-secondary hover:bg-raised disabled:opacity-40"><Clock size={16} /></button>}
        {hasContent && (
          <button
            onClick={send}
            aria-label={busy ? "Queue message" : "Send message"}
            title={busy ? "Queue — sends when the bot finishes" : "Send"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full text-white",
              busy ? "bg-raised text-ink-secondary hover:bg-raised-hover" : "bg-accent hover:brightness-110",
            )}
          >
            {busy ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
        )}
        </div>
      </div>
      {scheduleOpen && <ScheduleSheet target={group ? { groupId: group.id } : { botId: bot!.id }} prompt={text} onClose={() => setScheduleOpen(false)} onSaved={() => { setText(""); saveDraft(draftId, { text: "", attachments: [] }); }} />}
    </div>
  );
}
