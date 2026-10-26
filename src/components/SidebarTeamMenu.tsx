import { Network, Pencil, Share2, SlidersHorizontal, Trash2, UserRound, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

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
  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-raised";
  return (
    <>
      <button type="button" role="menuitem" autoFocus className={item} onClick={onAddBots}><Users size={14} />{t("team.addBots")}</button>
      {onSetOwner && <button type="button" role="menuitem" className={item} onClick={onSetOwner}><UserRound size={14} />{t("owner.setForAll")}</button>}
      {onSeeReports && <button type="button" role="menuitem" className={item} onClick={onSeeReports}><Network size={14} />{t("orgChart.seeWho")}</button>}
      {onSetForAll && <button type="button" role="menuitem" className={item} onClick={onSetForAll}><SlidersHorizontal size={14} />{t("teamSettings.menu")}</button>}
      <button type="button" role="menuitem" className={item} onClick={onRename}><Pencil size={14} />{t("team.rename")}</button>
      <button type="button" role="menuitem" className={item} onClick={onShare}><Share2 size={14} />{t("team.share")}</button>
      <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={onDelete}><Trash2 size={14} />{t("team.delete")}</button>
    </>
  );
}
