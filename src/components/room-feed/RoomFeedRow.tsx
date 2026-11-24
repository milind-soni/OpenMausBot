import { memo, useMemo } from "react";
import type { RoomThreadSpeaker } from "../../../shared/room-threads";
import { splitTranscriptCitations } from "@/lib/citations";
import { cn } from "@/lib/cn";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { intlLocale, t } from "@/lib/i18n";
import { MAUS_COLOR_NAMES } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { stripLeakedSystemHarnessMessages } from "../../../shared/system-message-guard.ts";
import { BotAvatar } from "../Avatar";
import { ChatMarkdown } from "../ChatMarkdown";
import { threadUpdatedLabel } from "../SidebarThreadRow";
import { PersonFace } from "../TeamOwner";
import { ThreadRefText } from "../ThreadRefs";

export interface FeedRowData {
  threadId: string;
  speaker: RoomThreadSpeaker;
  text: string;
  clipped?: boolean;
  at: number;
  replies: number;
  lastReplyAt: number | null;
  repliers: RoomThreadSpeaker[];
  /** Waiting for the person wins over unread. */
  mark: "waiting" | "unread" | null;
  /** The bot answering in it now. */
  workingBotId: string | null;
  working: boolean;
}

const FACES = 3;
const LONG_CHARS = 280;
const LONG_LINES = 4;

interface Who { key: string; name: string; bot?: Bot; personId?: string }

function who(speaker: RoomThreadSpeaker, bots: readonly Bot[], you: string): Who {
  if ("botId" in speaker) {
    const bot = bots.find((candidate) => candidate.id === speaker.botId);
    return { key: `bot:${speaker.botId}`, name: bot?.name ?? t("room.aBot"), bot };
  }
  const name = speaker.person.name?.trim() || you;
  return { key: `person:${speaker.person.id ?? name}`, name, personId: speaker.person.id };
}

function Face({ who: speaker, size }: { who: Who; size: number }) {
  if (speaker.key.startsWith("bot:")) {
    return <BotAvatar bot={speaker.bot ?? { name: speaker.name, color: "blue" }} state="happy" size={size} motion="none" motionKey={0} animated={false} />;
  }
  return <PersonFace person={{ email: speaker.personId ?? speaker.name, name: speaker.name, role: "member" }} size={size} />;
}

function Name({ who: speaker }: { who: Who }) {
  const color = speaker.bot?.color;
  const known = (MAUS_COLOR_NAMES as readonly string[]).includes(color ?? "");
  return <span dir="auto" data-bot-color={known ? color : undefined}
    className={cn("min-w-0 truncate text-[13px] font-semibold leading-[18px]", known ? "bot-identity" : "text-ink-secondary")}>{speaker.name}</span>;
}

/** What the first line says, without the markers an attachment or a quote leaves in a person's text. */
function previewText(row: FeedRowData, bot: boolean): string {
  const text = bot ? stripLeakedSystemHarnessMessages(row.text) : splitTranscriptAttachments(splitTranscriptCitations(row.text).display).display;
  const trimmed = text.trim();
  if (!trimmed) return "";
  return row.clipped ? `${trimmed.trimEnd()}…` : trimmed;
}

/** One thread in a room's feed: its first line and who said it, then how many replies it has, who wrote them and when
 * the last came. The whole row opens the thread beside the feed. */
export const RoomFeedRow = memo(function RoomFeedRow({ row, bots, you, now, open, onOpen }: {
  row: FeedRowData;
  bots: readonly Bot[];
  /** What a person whose lines carry no name is called: the profile's name. */
  you: string;
  now: number;
  open: boolean;
  onOpen: (threadId: string) => void;
}) {
  const speaker = who(row.speaker, bots, you);
  const fromBot = "botId" in row.speaker;
  const text = useMemo(() => previewText(row, fromBot), [row, fromBot]);
  const long = text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
  const repliers = useMemo(() => {
    const seen = new Set<string>();
    return row.repliers.map((one) => who(one, bots, you)).filter((one) => !seen.has(one.key) && Boolean(seen.add(one.key))).slice(0, FACES);
  }, [row.repliers, bots, you]);
  const workingBot = row.workingBotId ? bots.find((bot) => bot.id === row.workingBotId) : undefined;
  const replies = row.replies === 1 ? t("room.feed.replyOne") : t("room.feed.replyMany", { count: row.replies });
  const markLabel = row.mark === "waiting" ? t("sidebar.preview.waiting") : row.mark === "unread" ? t("task.unread") : null;
  const label = [speaker.name, text || t("room.feed.attachment"), row.replies > 0 ? replies : t("room.feed.noReplies"), markLabel].filter(Boolean).join(", ");
  return (
    <li data-feed-thread={row.threadId} className={cn("group relative flex gap-3 rounded-xl px-3 py-2.5 transition-colors duration-[120ms] motion-reduce:transition-none",
      open ? "bg-raised" : "hover:bg-ink/[0.06] active:bg-ink/[0.08]")}>
      <button type="button" aria-label={label} aria-current={open ? "true" : undefined} onClick={() => onOpen(row.threadId)}
        className="absolute inset-0 z-[1] rounded-xl" />
      <span className="mt-0.5 flex shrink-0"><Face who={speaker} size={32} /></span>
      <div inert className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 pe-5">
          <Name who={speaker} />
          <time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString(intlLocale())}
            className="shrink-0 text-[12px] font-medium leading-4 text-ink-tertiary tabular-nums">{threadUpdatedLabel(row.at, now)}</time>
        </div>
        <div dir="auto" className={cn("chat-text mt-0.5 max-h-[110px] overflow-hidden text-[15px] leading-[22px] text-ink [overflow-wrap:anywhere]",
          long && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]", !text && "text-ink-secondary")}>
          {!text ? t("room.feed.attachment")
            : fromBot ? <ChatMarkdown text={text} mentionPeers={bots} everyone />
              : <div className="whitespace-pre-wrap"><ThreadRefText text={text} peers={bots} everyone /></div>}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-4">
          {row.working ? (
            <span className="flex min-w-0 items-center gap-1.5 text-ink-secondary">
              {workingBot && <BotAvatar bot={workingBot} state="working" size={16} motion="none" motionKey={0} animated={false} />}
              <span className="truncate">{workingBot ? t("sidebar.preview.botWorking", { name: workingBot.name }) : t("sidebar.preview.working")}</span>
            </span>
          ) : row.replies > 0 ? (
            <>
              <span aria-hidden="true" data-feed-repliers="" className="flex shrink-0 items-center gap-0.5">
                {repliers.map((one) => <span key={one.key} className="inline-flex"><Face who={one} size={18} /></span>)}
              </span>
              <span className="shrink-0 font-medium text-ink-secondary tabular-nums">{replies}</span>
              {row.lastReplyAt !== null && <span className="min-w-0 truncate text-ink-tertiary">{t("room.feed.lastReply", { when: threadUpdatedLabel(row.lastReplyAt, now) })}</span>}
            </>
          ) : <span className="text-ink-tertiary">{t("room.feed.noReplies")}</span>}
        </div>
      </div>
      {markLabel && <span aria-hidden="true" data-feed-mark={row.mark} title={markLabel}
        className={cn("absolute end-3 top-3.5 size-2 rounded-full", row.mark === "waiting" ? "bg-warning" : "bg-accent")} />}
    </li>
  );
});
