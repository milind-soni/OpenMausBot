import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { openThread, useStore, type Message } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { activityText } from "@/lib/activity-text";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { HandoffConversationDialog } from "./HandoffConversationDialog";
import { HandoffReply } from "./HandoffReply";
import { HandoffStatusChip } from "./HandoffStatusChip";

const COMPOSER = '[data-tour="composer"] textarea';
/** The message box of the chat this line is in, or the only one open. */
const focusComposer = (line: HTMLElement | null) =>
  (line?.closest("main")?.querySelector<HTMLTextAreaElement>(COMPOSER) ?? document.querySelector<HTMLTextAreaElement>(COMPOSER))?.focus();

export function ThreadChip({ message, threadId }: { message: Message; threadId?: string }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [viewing, setViewing] = useState(false);
  const [talk, setTalk] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  // Runs after the pop-up has closed and handed focus back to this line.
  useEffect(() => {
    if (!talk) return;
    setTalk(false);
    focusComposer(chipRef.current);
  }, [talk]);
  const ref = message.threadRef;
  const tool = message.tool;
  if (!ref || !tool) return null;
  const bot = state.bots.find((candidate) => candidate.id === ref.botId);
  const direct = message.sentDirectly;
  const label = !direct ? activityText(tool, tool.name)
    : direct.room ? t("chat.sentDirectlyNotInRoom", { name: direct.name, room: direct.room }) : t("chat.sentDirectly", { name: direct.name });
  // A teammate's work for the bot that sent it is read here, over this chat; any other thread still opens in its own chat.
  const asker = message.from;
  // The helper's main chat is its talk with the person, not with the asker: that still opens there.
  const workThread = bot && ref.threadId !== bot.threadId && (bot.tasks ?? []).some((task) => task.threadId === ref.threadId);
  const conversation = !direct && asker && bot && asker.botId !== bot.id && workThread
    ? { asker, helper: { botId: bot.id, name: bot.name, color: bot.color } } : null;
  // A pop-up whose thread went away stays closed when it comes back.
  if (viewing && !conversation) setViewing(false);
  const open = () => openThread(dispatch, ref, state, showThreads);
  return (
    <HandoffReply message={message} threadId={threadId}>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        ref={chipRef}
        data-thread-chip={ref.threadId}
        onClick={conversation ? () => setViewing(true) : open}
        title={conversation ? t("chat.handoffConversation.view") : t("chat.openThread", { title: ref.title })}
        className={cn("ui-pill", tool.ok === false && "text-danger")}
      >
        {bot ? <BotAvatar bot={bot} state="happy" size={16} animated={false} /> : <MessagesSquare size={13} aria-hidden="true" />}
        <span className="max-w-[480px] truncate">{label}</span>
        {conversation && <span className="shrink-0 text-ink-secondary">· {t("chat.handoffConversation.view")}</span>}
        <ChevronRight size={13} />
      </button>
      {message.handoff && <HandoffStatusChip line={message.handoff} />}
      </span>
      {conversation && viewing && (
        <HandoffConversationDialog
          {...conversation}
          threadId={ref.threadId}
          request={ref.title || tool.output || ""}
          at={message.at}
          onClose={() => setViewing(false)}
          onTalk={() => { setViewing(false); setTalk(true); }}
          onOpenThread={() => { setViewing(false); open(); }}
        />
      )}
    </HandoffReply>
  );
}
