import { useEffect, useRef, useState } from "react";
import { AppWindowMac, MessageSquare, MonitorDown, MonitorUp, MoreHorizontal, Pencil, SquareMinus, SquarePlus, Trash2 } from "lucide-react";

import type { LocalApp } from "../../../shared/local-apps";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import type { Bot } from "@/state/store";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../SidebarPopoverMenu";
import { LocalAppThumb } from "./LocalAppThumb";

export { LocalAppMark } from "./LocalAppMark";

export const LOCAL_APP_FIELD = "min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2 py-0.5 text-[15px] font-semibold text-ink outline-none focus:border-focus";

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

/** What a saved app's menu offers on this computer. `desktop`: absent where this desktop build can't add a Desktop icon. */
export type InstallActions = { installed: boolean; run(): void; desktop?: { on: boolean; run(): void } };

/** Install on this computer or Uninstall, then Add to Desktop or Remove from Desktop, for a menu: nothing where the
 * desktop app can't install launchers. */
export function installItems(install: InstallActions | undefined): SidebarMenuItem[] {
  if (!install) return [];
  const { desktop } = install;
  return [
    install.installed
      ? { key: "uninstall", label: t("localApps.install.uninstall"), icon: <MonitorUp size={16} />, onSelect: install.run }
      : { key: "install", label: t("localApps.install.install"), icon: <MonitorDown size={16} />, onSelect: install.run },
    ...(!desktop ? [] : desktop.on
      ? [{ key: "desktop-remove", label: t("localApps.install.removeFromDesktop"), icon: <SquareMinus size={16} />, onSelect: desktop.run }]
      : [{ key: "desktop-add", label: t("localApps.install.addToDesktop"), icon: <SquarePlus size={16} />, onSelect: desktop.run }]),
  ];
}

/** The one line a failed Desktop change shows: installing first failed, or the Desktop item itself. */
export function desktopFailedText(error: unknown, removing: boolean, name: string): string {
  if (removing) return t("localApps.install.desktopRemoveFailed", { name });
  return t(error instanceof Error && error.message === "install" ? "localApps.install.failed" : "localApps.install.desktopFailed", { name });
}

export function InstalledMark() {
  return <span data-local-app-installed="" className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] leading-4 text-ink-secondary">{t("localApps.install.installed")}</span>;
}

export function LocalAppCard({ app, bot, onOpen, onOpenWindow, onRename, onGoToChat, onRemove, install }: {
  app: LocalApp;
  bot?: Bot;
  onOpen: () => void;
  /** Absent outside the desktop app. */
  onOpenWindow?: () => void;
  onRename: (name: string) => void;
  /** Absent when the chat it came from is gone. */
  onGoToChat?: () => void;
  onRemove: () => void;
  /** Present only where this computer can install launchers. */
  install?: InstallActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const maker = bot?.name ?? app.bot?.name;
  const facts = [maker ?? t(app.sample ? "localApps.card.sample" : "localApps.card.botGone"), relativeTime(app.updatedAt)].join(" · ");
  const items: SidebarMenuItem[] = [
    { key: "rename", label: t("localApps.card.rename"), icon: <Pencil size={16} />, onSelect: () => setRenaming(true) },
    ...(onGoToChat ? [{ key: "chat", label: t("localApps.card.goToChat"), icon: <MessageSquare size={16} />, onSelect: onGoToChat }] : []),
    ...installItems(install),
    { key: "remove", label: t("localApps.card.remove"), icon: <Trash2 size={16} />, separatorBefore: true, onSelect: onRemove },
  ];
  return (
    <li data-local-app={app.id} className="group relative flex min-w-0 flex-col rounded-2xl border border-hairline/40 bg-card transition-colors duration-[120ms] hover:border-hairline motion-reduce:transition-none">
      <button type="button" onClick={onOpen} aria-label={t("localApps.card.openOf", { name: app.name })} title={app.name}
        className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" />
      <div className="overflow-hidden rounded-t-2xl border-b border-hairline/30">
        <LocalAppThumb app={app} bot={bot} />
      </div>
      <div className="min-w-0 pb-3 pe-2 ps-3.5 pt-2">
        <div className="flex min-w-0 items-center gap-1">
          {renaming ? (
            <div className="relative z-[2] flex min-w-0 flex-1"><InlineName name={app.name} onDone={(next) => { setRenaming(false); if (next) onRename(next); }} /></div>
          ) : (
            <span dir="auto" data-local-app-name="" className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-[22px] text-ink">{app.name}</span>
          )}
          <span className="relative z-[2] flex shrink-0 items-center">
            {onOpenWindow && (
              <button type="button" className="ui-icon-button hover:bg-ink/[0.06] hover:text-ink" onClick={onOpenWindow}
                aria-label={t("localApps.card.openWindow")} title={t("localApps.card.openWindow")}><AppWindowMac size={16} /></button>
            )}
            <SidebarPopoverMenu items={items} ariaLabel={t("localApps.card.more", { name: app.name })} placement="below" align="end"
              triggerTitle={t("localApps.card.more", { name: app.name })} triggerClassName="ui-icon-button hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06]"
              renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />} />
          </span>
        </div>
        <span className="flex min-w-0 items-center gap-1.5 pe-1.5">
          <span dir="auto" className="min-w-0 truncate text-[13px] leading-[18px] text-ink-secondary" title={facts}>{facts}</span>
          {install?.installed && <InstalledMark />}
        </span>
      </div>
    </li>
  );
}
