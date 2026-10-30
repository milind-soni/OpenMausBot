import { useMemo, useState, type JSX } from "react";
import { Bug, Copy, Cpu, Download, Gauge, ListChecks, MessagesSquare, Monitor, MoreHorizontal, Search, Share, SquarePen, UserRound } from "lucide-react";
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
import { ELEVATED_CONTROL, ELEVATED_HOVER, ELEVATED_OPEN } from "./elevated";
import { ShortcutHint } from "./ShortcutHint";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { orderedThreadList } from "./SidebarThreadRow";
import { openBotSettings } from "./bot-panel/panel-link";

/** One item list for the chat's ⋯ menu wherever it sits; it lists the threads whenever the sidebar hides them. The
 * Simple bot panel draws the same items as rows, and its Share button holds the two that export. */
export function useChatMoreItems(profile: Bot, phoneHeader = false): { items: SidebarMenuItem[]; on: boolean } {
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
  const selection = profile.modelSelection;
  const modelName = phoneHeader && selection
    ? state.instances.find((candidate) => candidate.instanceId === selection.instanceId)?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model
    : "";
  // On a phone the header drops the profile pill's click target, the model chip and the Bot's screen button; they live here.
  const phoneItems: SidebarMenuItem[] = phoneHeader ? [
    {
      key: "profile",
      label: t("chat.openProfile"),
      icon: <UserRound size={16} />,
      onSelect: () => dispatch({ type: "toggleSettings", open: true }),
    },
  ] : [];
  const phoneScreen: SidebarMenuItem[] = phoneHeader ? [
    ...(remoteClient ? [] : [{
      key: "model",
      label: t("model.simple.model"),
      icon: <Cpu size={16} />,
      value: modelName,
      onSelect: () => openBotSettings(dispatch, "model"),
    } satisfies SidebarMenuItem]),
    {
      key: "computer",
      label: t("chat.computer"),
      icon: <Monitor size={16} />,
      active: state.computerOpen,
      onSelect: () => dispatch({ type: "toggleComputer" }),
    },
  ] : [];
  const items: SidebarMenuItem[] = [
    ...phoneItems,
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      active: findOpen,
      trailing: <ShortcutHint id="find-conversation" />,
      onSelect: () => requestChatFind(bot.threadId),
    },
    ...phoneScreen,
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
      onSelect: () => advanced ? openBotSettings(dispatch, "usage") : dispatch({ type: "toggleAppSettings", open: true, section: "usage" }),
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

function RoundChatMoreMenu({ bot, phoneHeader }: { bot: Bot; phoneHeader: boolean }) {
  const { items, on } = useChatMoreItems(bot, phoneHeader);
  const advanced = useAdvancedMode();
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
            "flex size-8 items-center justify-center rounded-full",
            advanced ? "bg-raised/50 transition-colors hover:bg-raised" : cn(ELEVATED_CONTROL, ELEVATED_HOVER, open && ELEVATED_OPEN),
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

/**
 * The chat's ⋯ menu as a round button, for a spot outside the chat such as the bot panel's top bar: find in
 * conversation (opens the chat's find bar), threads the sidebar hides, share, usage, activity and the inspector.
 */
export function ChatMoreMenu({ bot, phoneHeader = false }: { bot: Bot; phoneHeader?: boolean }): JSX.Element {
  // Keyed by thread so a "Copied" note never follows the panel into another conversation.
  return <RoundChatMoreMenu key={bot.threadId} bot={bot} phoneHeader={phoneHeader} />;
}

export const EXPORT_ITEMS = ["copy", "download"];

/** The bot panel's round Share button: copy or download this conversation. */
export function ChatShareMenu({ bot, className }: { bot: Bot; className: string }): JSX.Element {
  return <ShareMenu key={bot.threadId} bot={bot} className={className} />;
}

function ShareMenu({ bot, className }: { bot: Bot; className: string }) {
  const { items } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu
      items={items.filter((item) => EXPORT_ITEMS.includes(item.key)).map((item) => ({
        ...item, heading: undefined, separatorBefore: false, label: t(item.key === "copy" ? "chat.export.copyConversation" : "chat.export.downloadConversation"),
      }))}
      ariaLabel={t("chat.export.heading")}
      triggerClassName="rounded-full"
      triggerTitle={t("chat.export.heading")}
      renderTrigger={({ open }) => (
        <span data-panel-share className={cn(className, open && ELEVATED_OPEN)}>
          <Share size={16} aria-hidden="true" />
        </span>
      )}
    />
  );
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
            "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]",
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
