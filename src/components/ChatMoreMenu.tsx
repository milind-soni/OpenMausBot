import { useMemo, useState, type JSX } from "react";
import { Bug, Copy, Cpu, Download, Gauge, LayoutTemplate, ListChecks, MessagesSquare, Monitor, MoreHorizontal, RotateCcw, Search, Share, SquarePen, Star, UserPlus, UserRound, Users } from "lucide-react";
import { currentTaskBot, openBotThread, visibleMessages, type Bot } from "@/state/store";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useShowThreads } from "@/lib/thread-preferences";
import { requestChatFind, useChatFindOpen } from "@/lib/chat-find";
import { usageSummary } from "@/lib/chat-usage-summary";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import { conversationTranscript } from "@/lib/conversation-transcript";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { useContextAction } from "./ContextWarning";
import { ELEVATED_CONTROL, ELEVATED_HOVER, ELEVATED_OPEN } from "./elevated";
import { ShortcutHint } from "./ShortcutHint";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { MainThreadMark } from "./SidebarRowMarkers";
import { isArchived, mainThreadFirst, orderedThreadList, threadRowActions } from "./SidebarThreadRow";
import { openBotSettings } from "./bot-panel/panel-link";
import { ShareBotButton, useTeamName } from "./bot-access/ShareBotButton";
import { UsageBars } from "./EngineUsage";
import { useConversationSide } from "./TeamSideSwitch";
import { tasksOfSide } from "@/state/team-side";
import { openConversationDialog, shareChoices } from "./conversation-share/conversation-share";
import { askBot } from "@/lib/template-share";
import { TEMPLATE_SHARE_MESSAGE } from "../../shared/share-card";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select";

/** One item list for the chat's ⋯ menu wherever it sits; it lists the threads whenever the sidebar hides them. The
 * Simple bot panel draws the same items as rows, and its Share button holds the two that export. */
export function useChatMoreItems(profile: Bot, phoneHeader = false): { items: SidebarMenuItem[]; on: boolean } {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  const state = useStoreSelector((s) => ({ activityOpen: s.activityOpen, computerOpen: s.computerOpen, inspectorOpen: s.inspectorOpen, instances: s.instances }), sameFields), dispatch = useStoreDispatch();
  const advanced = useAdvancedMode();
  const showThreads = useShowThreads();
  const findOpen = useChatFindOpen(bot.threadId);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const usage = usageSummary(bot, state.instances);
  const hasMessages = messages.length > 0;
  const contextAction = useContextAction();
  const atFreshStart = messages.at(-1)?.compaction?.fresh === true;
  const transcript = () => conversationTranscript({ threadId: bot.threadId, hasMore: bot.hasMore, activeLeafId: bot.activeLeafId, title: bot.name, messages, botName: bot.name, isGroup: false });
  const side = useConversationSide(profile);
  const threads = showThreads ? [] : mainThreadFirst(orderedThreadList((side ? tasksOfSide(profile, side) : profile.tasks ?? []).filter((task) => !task.routineRunId)), profile.mainThreadId);
  const openTask = profile.tasks?.find((task) => task.threadId === bot.threadId);
  const sharing = shareChoices(profile, openTask, Boolean(useTeamName()));
  const ownerOrAdmin = useOwnerOrAdmin();
  const canSetMain = ownerOrAdmin === true && !remoteClient && openTask !== undefined
    && !openTask.routineRunId && !openTask.private && !openTask.openedBy && !isArchived(openTask);
  const isMain = bot.threadId === profile.mainThreadId;
  const shareItems: SidebarMenuItem[] = [
    { key: TEMPLATE_ITEM, label: t("template.shareAsTemplate"), icon: <LayoutTemplate size={16} />,
      onSelect: () => askBot(dispatch, profile.id, bot.threadId, TEMPLATE_SHARE_MESSAGE) },
    ...(sharing.team ? [{ key: "share-team", label: t("conversationShare.withTeam"), icon: <Users size={16} />,
      onSelect: () => openConversationDialog({ kind: "team", botId: profile.id, threadId: bot.threadId }) }] : []),
    ...(sharing.person ? [{ key: "share-person", label: t("conversationShare.withPerson"), icon: <UserPlus size={16} />,
      onSelect: () => openConversationDialog({ kind: "person", botId: profile.id, threadId: bot.threadId }) }] : []),
  ].map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item));
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
      trailing: <UsageBars engine={selection?.instanceId} hover={false} />,
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
    ...(showThreads || side === "team" ? [] : [{
      key: "new-thread",
      heading: t("task.list"),
      separatorBefore: true,
      label: t("task.newShort"),
      icon: <SquarePen size={16} />,
      trailing: <ShortcutHint id="new-thread" />,
      onSelect: () => dispatch({ type: "newTask", botId: profile.id }),
    } satisfies SidebarMenuItem]),
    // With one thread there is nothing to switch to.
    ...(threads.length < 2 ? [] : [{
      key: "threads",
      ...(side === "team" ? { heading: t("task.list"), separatorBefore: true } : {}),
      label: t("task.switch"),
      icon: <MessagesSquare size={16} />,
      value: String(threads.length),
      submenu: threads.map((task) => ({
        key: `thread:${task.threadId}`,
      label: localizedTaskTitle(task.title || t("task.newShort")),
        active: task.threadId === bot.threadId,
        trailing: task.threadId === profile.mainThreadId ? <MainThreadMark /> : undefined,
        onSelect: () => openBotThread(dispatch, profile, task.threadId, showThreads),
      })),
      onSelect: () => {},
    } satisfies SidebarMenuItem]),
    {
      key: "start-fresh",
      label: t("chat.startFresh"),
      icon: <RotateCcw size={16} />,
      disabled: bot.busy || contextAction.pending || !hasMessages || atFreshStart,
      title: t(bot.busy ? "contextWarning.busy" : "chat.startFresh.hint"),
      onSelect: () => contextAction.run(`/api/bots/${profile.id}/start-fresh`, { threadId: bot.threadId }),
    },
    ...(canSetMain ? [{
      key: "set-main",
      label: t("sidebar.bot.simple.setMainThread"),
      icon: <Star size={16} />,
      disabled: isMain,
      title: isMain ? t("sidebar.bot.simple.isMainThread") : undefined,
      onSelect: () => threadRowActions(profile.id, dispatch).onSetMain({ threadId: bot.threadId }),
    } satisfies SidebarMenuItem] : []),
    ...shareItems,
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
      onSelect: () => {
        const content = transcript();
        const save = (markdown: string) => downloadMarkdownTranscript(slugifyTranscriptFilename(bot.name), markdown);
        if (typeof content === "string") save(content);
        else void content.then(save).catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
      },
    },
    ...(usage ? [{
      key: "usage",
      label: t("chat.usage.menu"),
      icon: <Gauge size={16} />,
      separatorBefore: true,
      trailing: <span title={usage.detail} data-testid="usage-chip" className="tabular-nums text-[12px] text-ink-secondary">{usage.short}</span>,
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
            "flex size-9 items-center justify-center rounded-full",
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
/** Asks the bot to make a shareable template of itself. */
export const TEMPLATE_ITEM = "as-template";

/** The bot panel's round Share button: on a team who has access, with copying or downloading this conversation under
 * the ⋯ of its header; anywhere else a menu of those two. */
export function ChatShareMenu({ bot, className }: { bot: Bot; className: string }): JSX.Element {
  return useTeamName() ? <ShareBotButton bot={bot} className={className} headerMenu={<ExportMore key={bot.threadId} bot={bot} />} />
    : <ShareMenu key={bot.threadId} bot={bot} className={className} />;
}

/** The Share button's items: the bot as a template, then this conversation copied or downloaded. */
const exportItems = (items: SidebarMenuItem[]): SidebarMenuItem[] => [
  ...items.filter((item) => item.key === TEMPLATE_ITEM).map((item) => ({ ...item, separatorBefore: false })),
  ...items.filter((item) => EXPORT_ITEMS.includes(item.key)).map((item, index) => ({
    ...item, heading: undefined, separatorBefore: index === 0, label: t(item.key === "copy" ? "chat.export.copyConversation" : "chat.export.downloadConversation"),
  })),
];

/** The ⋯ in a team bot's Share dialog: the bot as a template, and this conversation copied or downloaded. */
export function ExportMore({ bot }: { bot: Bot }) {
  const { items } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu items={exportItems(items)} ariaLabel={t("chat.more")} align="end" triggerTitle={t("chat.more")}
      triggerClassName="flex shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06]"
      renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />} />
  );
}

function ShareMenu({ bot, className }: { bot: Bot; className: string }) {
  const { items } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu
      items={exportItems(items)}
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
            "flex size-9 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]",
            open || on ? "text-accent" : "text-ink-secondary hover:text-ink",
          )}
          title={t("chat.more")}
        >
          <MoreHorizontal size={16} />
        </span>
      )}
    />
  );
}
