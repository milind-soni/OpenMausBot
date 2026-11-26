import { useEffect, useRef, useState } from "react";
import { MessageSquare, MoreHorizontal, AppWindowMac, Pencil, Trash2 } from "lucide-react";

import type { LocalApp } from "../../../shared/local-apps";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { appInitial } from "@/lib/published-apps";
import type { Bot } from "@/state/store";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";

export const LOCAL_APP_FIELD = "min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2.5 py-1.5 text-[14px] font-medium text-ink outline-none focus:border-focus";

/** The app's mark: its first letter on a plate in the colour of the bot that made it, plain once that bot is gone. */
export function LocalAppMark({ app, bot, size = "md" }: { app: LocalApp; bot?: Bot; size?: "md" | "sm" }) {
  const color = (bot ?? app.bot)?.color;
  return (
    <span aria-hidden="true" data-bot-color={color}
      className={cn("flex shrink-0 select-none items-center justify-center rounded-xl font-semibold leading-none",
        size === "md" ? "size-11 text-[20px]" : "size-7 rounded-lg text-[13px]",
        color ? "bot-identity bg-current/[0.14]" : "bg-inset text-ink-tertiary")}>
      {appInitial(app.name)}
    </span>
  );
}

/** Rename in place: Enter or leaving the field keeps the name, Esc keeps the old one. */
export function InlineName({ name, onDone }: { name: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next === null || !next.trim() || next.trim() === name ? null : next.trim());
  };
  return (
    <input ref={field} dir="auto" value={value} maxLength={80} aria-label={t("localApps.card.nameLabel")} data-local-app-name-field=""
      onChange={(event) => setValue(event.target.value)} onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); finish(value); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); }
      }}
      className={LOCAL_APP_FIELD} />
  );
}

export function LocalAppCard({ app, bot, onOpen, onOpenWindow, onRename, onGoToChat, onRemove }: {
  app: LocalApp;
  bot?: Bot;
  onOpen: () => void;
  /** Absent outside the desktop app. */
  onOpenWindow?: () => void;
  onRename: (name: string) => void;
  /** Absent when the chat it came from is gone. */
  onGoToChat?: () => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const maker = bot?.name ?? app.bot?.name;
  const facts = [maker ?? t("localApps.card.botGone"), relativeTime(app.updatedAt)].join(" · ");
  const items: SidebarMenuItem[] = [
    { key: "rename", label: t("localApps.card.rename"), icon: <Pencil size={16} />, onSelect: () => setRenaming(true) },
    ...(onGoToChat ? [{ key: "chat", label: t("localApps.card.goToChat"), icon: <MessageSquare size={16} />, onSelect: onGoToChat }] : []),
    { key: "remove", label: t("localApps.card.remove"), icon: <Trash2 size={16} />, separatorBefore: true, onSelect: onRemove },
  ];
  return (
    <li data-local-app={app.id} className="group flex min-w-0 items-center gap-1 rounded-xl border border-hairline/40 bg-card p-2 transition-colors duration-[120ms] focus-within:border-hairline hover:border-hairline motion-reduce:transition-none">
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 p-1">
          <LocalAppMark app={app} bot={bot} />
          <InlineName name={app.name} onDone={(next) => { setRenaming(false); if (next) onRename(next); }} />
        </div>
      ) : (
        <button type="button" onClick={onOpen} aria-label={t("localApps.card.openOf", { name: app.name })} title={app.name}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-start transition-colors duration-[120ms] hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none">
          <LocalAppMark app={app} bot={bot} />
          <span className="min-w-0 flex-1">
            <span dir="auto" data-local-app-name="" className="block truncate text-[14px] font-medium leading-5 text-ink">{app.name}</span>
            <span dir="auto" className="mt-0.5 block truncate text-[12px] leading-4 text-ink-tertiary">{facts}</span>
          </span>
        </button>
      )}
      <span className="flex shrink-0 items-center">
        {onOpenWindow && (
          <button type="button" className="ui-icon-button hover:bg-ink/[0.06] hover:text-ink" onClick={onOpenWindow}
            aria-label={t("localApps.card.openWindow")} title={t("localApps.card.openWindow")}><AppWindowMac size={16} /></button>
        )}
        <SidebarPopoverMenu items={items} ariaLabel={t("localApps.card.more", { name: app.name })} placement="below" align="end"
          triggerTitle={t("localApps.card.more", { name: app.name })} triggerClassName="ui-icon-button hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06]"
          renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />} />
      </span>
    </li>
  );
}
