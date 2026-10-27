import { useState, type JSX } from "react";
import { Copy, Download, Gauge, MessagesSquare, MoreHorizontal, Search, SquarePen, Timer } from "lucide-react";

import { requestChatFind, useChatFindOpen } from "@/lib/chat-find";
import { cn } from "@/lib/cn";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { useShowThreads } from "@/lib/thread-preferences";
import { useStore, type Group } from "@/state/store";
import { PRESET_TURN_LIMITS, useConversationTurnLimit } from "./ConversationTurnLimit";
import { groupUsageSummary } from "./GroupUsageChip";
import { ShortcutHint } from "./ShortcutHint";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { orderedThreadList } from "./SidebarThreadRow";

function turnLimitLabel(minutes: number): string {
  if (minutes === 60) return t("room.panel.hour");
  if (minutes % 60 === 0) return t("room.panel.hours", { hours: minutes / 60 });
  return t("room.panel.minutes", { minutes });
}

function useRoomMoreItems(group: Group): { items: SidebarMenuItem[]; on: boolean } {
  const { dispatch } = useStore();
  const showThreads = useShowThreads();
  const findOpen = useChatFindOpen(group.threadId);
  const limit = useConversationTurnLimit(group);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const messages = group.messages;
  const hasMessages = messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: group.name, messages, isGroup: true });
  const threads = showThreads ? [] : orderedThreadList(group.tasks ?? []);
  const usage = groupUsageSummary(group.usage);
  const items: SidebarMenuItem[] = [
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      active: findOpen,
      trailing: <ShortcutHint id="find-conversation" />,
      onSelect: () => requestChatFind(group.threadId),
    },
    ...(showThreads ? [] : [{
      key: "new-thread",
      heading: t("task.list"),
      separatorBefore: true,
      label: t("task.newShort"),
      icon: <SquarePen size={16} />,
      onSelect: () => dispatch({ type: "newGroupTask", groupId: group.id }),
    } satisfies SidebarMenuItem]),
    ...(threads.length < 2 ? [] : [{
      key: "threads",
      label: t("task.switch"),
      icon: <MessagesSquare size={16} />,
      value: String(threads.length),
      submenu: threads.map((task) => ({
        key: `thread:${task.threadId}`,
        label: localizedTaskTitle(task.title || t("task.newShort")),
        active: task.threadId === group.threadId,
        onSelect: () => dispatch({ type: "switchGroupTask", groupId: group.id, threadId: task.threadId }),
      })),
      onSelect: () => {},
    } satisfies SidebarMenuItem]),
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
      onSelect: () => downloadMarkdownTranscript(slugifyTranscriptFilename(group.name), transcript()),
    },
    {
      key: "turn-limit",
      label: t("room.panel.turnLimit"),
      icon: <Timer size={16} />,
      separatorBefore: true,
      value: turnLimitLabel(limit.saved ?? limit.globalMinutes),
      submenu: [
        {
          key: "turn-limit:default",
          label: t("room.turnLimit.default", { minutes: limit.globalMinutes }),
          active: limit.saved === null,
          onSelect: () => limit.save(null),
        },
        ...PRESET_TURN_LIMITS.map((minutes) => ({
          key: `turn-limit:${minutes}`,
          label: turnLimitLabel(minutes),
          active: limit.saved === minutes,
          onSelect: () => limit.save(minutes),
        })),
      ],
      onSelect: () => {},
    },
    ...(usage ? [{
      key: "usage",
      label: t("chat.usage.menu"),
      icon: <Gauge size={16} />,
      keepOpen: true,
      trailing: <span title={usage.title} data-testid="group-usage-chip" className="tabular-nums text-[12px] text-ink-secondary">{usage.short}</span>,
      onSelect: () => {},
    } satisfies SidebarMenuItem] : []),
  ];
  return { items, on: findOpen };
}

function RoundRoomMoreMenu({ group }: { group: Group }) {
  const { items, on } = useRoomMoreItems(group);
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      triggerClassName="rounded-full"
      triggerTitle={t("chat.more")}
      renderTrigger={({ open }) => (
        <span
          data-testid="room-more"
          className={cn(
            "flex size-8 items-center justify-center rounded-full bg-raised/50 transition-colors hover:bg-raised",
            "max-md:size-9 max-md:border max-md:border-hairline max-md:bg-card",
            open || on ? "text-accent" : "text-ink",
          )}
        >
          <MoreHorizontal size={16} />
        </span>
      )}
    />
  );
}

export function RoomMoreMenu({ group }: { group: Group }): JSX.Element {
  // Keyed by thread so a "Copied" note never follows the panel into another conversation.
  return <RoundRoomMoreMenu key={group.threadId} group={group} />;
}
