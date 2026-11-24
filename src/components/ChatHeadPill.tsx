import { localizedTaskTitle } from "@/lib/task-title";
import { ChevronRight, Lock, UserRound, Users } from "lucide-react";
import { useMemo, type ComponentProps } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store"; import { useStoreSelector } from "@/state/store-select";
import { awayFromMainThread } from "@/state/thread-navigation";
import { WorkspaceThreadPicker } from "./WorkspaceThreadPicker";
import { BotAvatar } from "./Avatar";
import { ELEVATED_FLOAT } from "./elevated";
import { sidebarBotActivityTasks } from "./SidebarBotActivity";
import { sharedChatAudience } from "./TeamPrivateChatsLine";
import { showsTabs, threadTabs } from "./thread-tabs";
import { ThreadSwitcherPill } from "./ThreadSwitcherPill";

/** The factory title a new conversation starts with. */
const UNTITLED = "New thread";
const CHEVRON_MOTION = "duration-[140ms] ease-[cubic-bezier(.22,1,.36,1)]";

export type ChatHeadPrivacy = { kind: "private" } | { kind: "ownHelper" } | { kind: "shared"; team: string; onlyPeopleAdded?: boolean; sharedWith?: string } | null;

const PRIVACY_ICONS = { private: Lock, ownHelper: UserRound, shared: Users } as const;

function privacyLabelOf(privacy: ChatHeadPrivacy): string | null {
  switch (privacy?.kind) {
    case "private": return t("team.privateHeader");
    case "ownHelper": return t("team.ownHelperHeader");
    case "shared": return sharedChatAudience(privacy.team, privacy.onlyPeopleAdded, privacy.sharedWith);
    default: return null;
  }
}

export function ChatHeadPill({ bot, avatar, privacy, onToggle, threadTitle, switcher = false }: {
  bot: Bot;
  switcher?: boolean;
  avatar: Pick<ComponentProps<typeof BotAvatar>, "state" | "motion" | "motionKey" | "animated">;
  privacy: ChatHeadPrivacy;
  threadTitle?: string;
  onToggle: (open: boolean) => void;
}) {
  const open = useStoreSelector((state) => state.settingsOpen);
  const pendingQueued = useStoreSelector((state) => state.pendingQueued);
  const elsewhere = sidebarBotActivityTasks(bot, pendingQueued).filter((task) => task.threadId !== bot.threadId).length;
  const privacyLabel = privacyLabelOf(privacy);
  const PrivacyIcon = privacy ? PRIVACY_ICONS[privacy.kind] : Users;
  const title = bot.tasks?.find((task) => task.threadId === bot.threadId)?.title;
  // Simple mode calls an untitled conversation what it is, never a "thread".
  const conversation = threadTitle ?? (!awayFromMainThread(bot, false) ? (privacy?.kind === "shared" ? t("task.sharedChat") : null)
    : !title || title === UNTITLED ? t("task.untitledChat") : localizedTaskTitle(title));
  const label = t("chat.openProfileAria", { name: bot.name });
  const tabs = useMemo(() => (switcher ? threadTabs(bot) : []), [switcher, bot.id, bot.threadId, bot.switchingTo, bot.mainThreadId, bot.tasks, bot.busy]);
  const identity = <>
    <BotAvatar bot={bot} size={28} {...avatar} />
    <span dir="auto" className="min-w-0 truncate text-[14px] font-medium leading-5">{bot.name}</span>
    {privacyLabel && (
      <span data-chathead-privacy={privacy?.kind} title={privacyLabel} className="flex shrink-0 text-ink-tertiary">
        <PrivacyIcon size={13} aria-hidden="true" />
        <span className="sr-only">{privacyLabel}</span>
      </span>
    )}
    {elsewhere > 0 && (
      <span role="img" data-chathead-elsewhere aria-label={t("task.otherActivity", { count: elsewhere })} className="size-1.5 shrink-0 rounded-full bg-accent" />
    )}
  </>;
  if (showsTabs(tabs)) {
    return <ThreadSwitcherPill bot={bot} tabs={tabs} head={<span className="flex min-w-0 items-center gap-2 pe-1">{identity}</span>} label={label} panelOpen={open} onToggle={() => onToggle(!open)} />;
  }
  return (
    <div data-chathead-pill className={cn("flex min-w-0 max-w-full items-center rounded-full text-ink", ELEVATED_FLOAT)}>
      <WorkspaceThreadPicker key={bot.id} owner={bot} onProfile={() => onToggle(true)}>
        {identity}
        {!conversation && (
          // Hidden at rest and folded into the gap, so the pill stays tight; it slides in on hover or keyboard focus.
          <span aria-hidden="true" data-chathead-chevron className={cn("-ml-2 flex w-0 shrink-0 overflow-hidden opacity-0 transition-[width,margin,opacity] group-hover:-ml-0.5 group-hover:w-3 group-hover:opacity-100 group-focus-visible:-ml-0.5 group-focus-visible:w-3 group-focus-visible:opacity-100", CHEVRON_MOTION)}>
            <ChevronRight size={12} className="shrink-0 text-ink-tertiary" />
          </span>
        )}
      </WorkspaceThreadPicker>
      {conversation && <>
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />
        <WorkspaceThreadPicker key={bot.threadId} owner={bot} title={conversation} />
      </>}
    </div>
  );
}
