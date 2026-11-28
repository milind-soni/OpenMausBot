import { useState } from "react";
import { ArrowDown, ArrowUp, CheckCheck, Loader2, Pause, Play, Share2, SlidersHorizontal, SquarePen, Trash2, Users } from "lucide-react";
import { isPausedHere, setPaused } from "@/lib/bot-pause";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { cn } from "@/lib/cn";
import { departmentUnread, markDepartmentRead } from "@/lib/folder-read";
import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { MENU_ITEM, MENU_ITEM_SEPARATOR } from "./menu-recipe";

function Label({ children }: { children: string }) {
  return <span className="min-w-0 truncate">{children}</span>;
}

/** Reads every conversation of the department's bots and its group chats; shown only while something there is unread. */
function MarkDepartmentRead({ name, className, onDone }: { name: string; className: string; onDone: () => void }) {
  const { state, dispatch } = useStore();
  const [reading, setReading] = useState(false);
  const unread = departmentUnread(name, state.bots, state.groups);
  if (!reading && unread.bots.length === 0 && unread.groups.length === 0) return null;
  const read = async () => {
    setReading(true);
    try {
      await markDepartmentRead(unread, (path, init) => api(path, init), (bot) => dispatch({ type: "botPatched", bot }), (group) => dispatch({ type: "groupPatched", group }));
      onDone();
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? `${t("sidebar.bot.markAllReadFailed")} ${error.message}` : t("sidebar.bot.markAllReadFailed") });
    } finally {
      setReading(false);
    }
  };
  return <button type="button" role="menuitem" data-team-mark-read className={className} disabled={reading} onClick={() => void read()}>
    {reading ? <Loader2 size={16} className="animate-spin" /> : <CheckCheck size={16} />}<Label>{reading ? t("team.markingAllRead") : t("team.markAllRead")}</Label>
  </button>;
}

/** Pause or resume every bot in the department: only the owner or an admin. */
function PauseDepartment({ name, className, onDone }: { name: string; className: string; onDone: () => void }) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  if (useOwnerOrAdmin() !== true) return null;
  const paused = isPausedHere(state.config, "department", name);
  const toggle = async () => {
    setSaving(true);
    try {
      await setPaused("department", name, !paused);
      onDone();
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };
  return <button type="button" role="menuitem" data-team-pause={paused ? "resume" : "pause"} className={className} disabled={saving} onClick={() => void toggle()}>
    {saving ? <Loader2 size={16} className="animate-spin" /> : paused ? <Play size={16} /> : <Pause size={16} />}<Label>{t(paused ? "pause.resumeDepartment" : "pause.pauseDepartment")}</Label>
  </button>;
}

/** A department's menu, from its line's ⋯ or a right-click on its name. */
export function TeamMenuItems({ onAddBots, onRename, onShare, onDelete, onSetForAll, onMoveUp, onMoveDown, department, onRead }: {
  /** The department this menu is for: with it, the menu offers Mark all as read. */
  department?: string;
  onRead?: () => void;
  onAddBots: () => void;
  onRename: () => void;
  /** Absent for a department this computer's server does not have (the one list's place department, which only the app
   * keeps): sharing it would name a department the server lacks. */
  onShare?: () => void;
  onDelete: () => void;
  onSetForAll?: () => void;
  /** Only on the phone layout, which has no Alt+Up/Down and where a touch drag of a heading can't be relied on. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const item = cn(MENU_ITEM, "hover:bg-menu-hover [&>svg]:shrink-0 [&>svg]:text-ink-secondary");
  return (
    <>
      <button type="button" role="menuitem" autoFocus className={item} onClick={onAddBots}><Users size={16} /><Label>{t("team.addBots")}</Label></button>
      <button type="button" role="menuitem" className={item} onClick={onRename}><SquarePen size={16} /><Label>{t("team.rename")}</Label></button>
      {onSetForAll && <button type="button" role="menuitem" data-team-settings className={item} onClick={onSetForAll}><SlidersHorizontal size={16} /><Label>{t("teamSettings.menu")}</Label></button>}
      {department !== undefined && <PauseDepartment name={department} className={cn(item, "disabled:opacity-60")} onDone={onRead ?? (() => {})} />}
      {department !== undefined && <MarkDepartmentRead name={department} className={cn(item, "disabled:opacity-60")} onDone={onRead ?? (() => {})} />}
      {onShare && <button type="button" role="menuitem" className={item} onClick={onShare}><Share2 size={16} /><Label>{t("team.shareDepartment")}</Label></button>}
      {onMoveUp && <button type="button" role="menuitem" data-team-move-up className={item} onClick={onMoveUp}><ArrowUp size={16} /><Label>{t("team.moveUp")}</Label></button>}
      {onMoveDown && <button type="button" role="menuitem" data-team-move-down className={item} onClick={onMoveDown}><ArrowDown size={16} /><Label>{t("team.moveDown")}</Label></button>}
      <div role="separator" className={MENU_ITEM_SEPARATOR} />
      <button type="button" role="menuitem" className={cn(item, "text-danger [&>svg]:text-danger")} onClick={onDelete}><Trash2 size={16} /><Label>{t("team.delete")}</Label></button>
    </>
  );
}
