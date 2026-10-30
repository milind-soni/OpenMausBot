import { Network, Share2, SlidersHorizontal, SquarePen, Trash2, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { MENU_ITEM } from "./menu-recipe";

export { showWhoReportsToWhom } from "./TeamOrgChart";

/** A department's menu, from its line's ⋯ or a right-click on its name. */
export function TeamMenuItems({ onAddBots, onRename, onShare, onDelete, onSetForAll, onSetOwner, onSeeReports }: {
  onAddBots: () => void;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
  onSetForAll?: () => void;
  onSetOwner?: () => void;
  onSeeReports?: () => void;
}) {
  const item = cn(MENU_ITEM, "hover:bg-menu-hover [&>svg]:text-ink-secondary");
  return (
    <>
      <button type="button" role="menuitem" autoFocus className={item} onClick={onAddBots}><Users size={16} />{t("team.addBots")}</button>
      {onSetOwner && <button type="button" role="menuitem" className={item} onClick={onSetOwner}><UserRound size={16} />{t("owner.setForAll")}</button>}
      {onSeeReports && <button type="button" role="menuitem" className={item} onClick={onSeeReports}><Network size={16} />{t("orgChart.seeWho")}</button>}
      {onSetForAll && <button type="button" role="menuitem" className={item} onClick={onSetForAll}><SlidersHorizontal size={16} />{t("teamSettings.menu")}</button>}
      <button type="button" role="menuitem" className={item} onClick={onRename}><SquarePen size={16} />{t("team.rename")}</button>
      <button type="button" role="menuitem" className={item} onClick={onShare}><Share2 size={16} />{t("team.share")}</button>
      <button type="button" role="menuitem" className={cn(item, "text-danger [&>svg]:text-danger")} onClick={onDelete}><Trash2 size={16} />{t("team.delete")}</button>
    </>
  );
}
