import { useMemo, useState, type JSX } from "react";
import { Bug, Copy, Download, Gauge, ListChecks, MessagesSquare, MoreHorizontal, Search, SquarePen } from "lucide-react";
import { currentTaskBot, openBotThread, useStore, visibleMessages, type Bot } from "@/state/store";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useShowThreads } from "@/lib/thread-preferences";
import { requestChatFind, useChatFindOpen } from "@/lib/chat-find";
import { usageSummary } from "@/lib/chat-usage-summary";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { ShortcutHint } from "./ShortcutHint";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { orderedThreadList } from "./SidebarThreadRow";
import { openBotSettings } from "./bot-panel/panel-link";

/** One item list for the chat's ⋯ menu wherever it sits; it lists the threads whenever the sidebar hides them. */
function useChatMoreItems(profile: Bot): { items: SidebarMenuItem[]; on: boolean } {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const showThreads = useShowThreads();
  const findOpen = useChatFindOpen(bot.threadId);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const usage = usageSummary(bot, state.instances);
  const hasMessages = messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: bot.name, messages, botName: bot.name, isGroup: false });
  const threads = showThreads ? [] : orderedThreadList((profile.tasks ?? []).filter((task) => !task.routineRunId));
  const items: SidebarMenuItem[] = [
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      active: findOpen,
      trailing: <ShortcutHint id="find-conversation" />,
      onSelect: () => requestChatFind(bot.threadId),
    },
    ...(showThreads ? [] : [{
      key: "new-thread",
      heading: t("task.list"),
      separatorBefore: true,
      label: t("task.newShort"),
      icon: <SquarePen size={16} />,
      onSelect: () => dispatch({ type: "newTask", botId: profile.id }),
    } satisfies SidebarMenuItem]),
    // With one thread there is nothing to switch to.
    ...(threads.length < 2 ? [] : [{
      key: "threads",
      label: t("task.switch"),
      icon: <MessagesSquare size={16} />,
      value: String(threads.length),
      submenu: threads.map((task) => ({
        key: `thread:${task.threadId}`,
      label: localizedTaskTitle(task.title || t("task.newShort")),
        active: task.threadId === bot.threadId,
        onSelect: () => openBotThread(dispatch, profile, task.threadId, showThreads),
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
      onSelect: () => downloadMarkdownTranscript(slugifyTranscriptFilename(bot.name), transcript()),
    },
    ...(usage ? [{
      key: "usage",
      label: t("chat.usage.menu"),
      icon: <Gauge size={16} />,
      separatorBefore: true,
      trailing: <span title={usage.detail} data-testid="usage-chip" className={cn("tabular-nums text-[12px]", usage.tone === "danger" ? "text-danger" : usage.tone === "warning" ? "text-warning" : "text-ink-secondary")}>{usage.short}</span>,
      onSelect: () => openBotSettings(dispatch, "usage"),
    } satisfies SidebarMenuItem] : []),
    ...(remoteClient ? [] : [{
      key: "activity",
      label: t("activity.panel.title"),
      icon: <ListChecks size={16} />,
      active: state.activityOpen,
      separatorBefore: !usage,
      onSelect: () => dispatch({ type: "toggleActivity" }),
    } satisfies SidebarMenuItem, {
      key: "inspector",
      label: t("chat.inspector"),
      icon: <Bug size={16} />,
      active: state.inspectorOpen,
      // Simple mode keeps Activity and Inspector together, as the panel's menu draws them.
      separatorBefore: advanced,
      onSelect: () => dispatch({ type: "toggleInspector" }),
    } satisfies SidebarMenuItem]),
  ];
  return { items, on: findOpen || state.inspectorOpen || state.activityOpen };
}

function RoundChatMoreMenu({ bot }: { bot: Bot }) {
  const { items, on } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      triggerClassName="rounded-full"
      triggerTitle={t("chat.more")}
      renderTrigger={({ open }) => (
        <span
          data-testid="chat-more"
          className={cn(
            "flex size-8 items-center justify-center rounded-full bg-raised/50 transition-colors hover:bg-raised",
            open || on ? "text-accent" : "text-ink",
          )}
        >
          <MoreHorizontal size={16} />
        </span>
      )}
    />
  );
}

/**
 * The chat's ⋯ menu as a round button, for a spot outside the chat such as the bot panel's top bar: find in
 * conversation (opens the chat's find bar), threads the sidebar hides, share, usage, activity and the inspector.
 */
export function ChatMoreMenu({ bot }: { bot: Bot }): JSX.Element {
  // Keyed by thread so a "Copied" note never follows the panel into another conversation.
  return <RoundChatMoreMenu key={bot.threadId} bot={bot} />;
}

/** The same menu as the chat header's plain ⋯ in Advanced mode, opening on hover below the header. */
export function ChatHeaderMenu({ bot }: { bot: Bot }): JSX.Element {
  const { items, on } = useChatMoreItems(bot);
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
            open || on ? "text-accent" : "text-ink-secondary hover:text-ink",
          )}
          title={t("chat.more")}
        >
          <MoreHorizontal size={18} />
        </span>
      )}
    />
  );
}
