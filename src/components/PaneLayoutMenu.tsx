import { Columns2, Grid2X2, LayoutPanelLeft, PanelsTopLeft, Rows2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { currentPreset, emptyPane, paneIds, presetSize, type PanePreset } from "@/state/pane-layout";
import { workspaceLayout } from "@/state/fork-panel";
import { useStore } from "@/state/store";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

export function PaneLayoutMenu({ className }: { className: string }) {
  const { state, dispatch } = useStore();
  const layout = workspaceLayout(state);
  const occupied = paneIds(layout).filter(id => !emptyPane(id)).length;
  const icons = { columns: Columns2, rows: Rows2, stack: LayoutPanelLeft, grid: Grid2X2 };
  const items = (Object.keys(icons) as PanePreset[]).map(preset => {
    const Icon = icons[preset];
    const disabled = presetSize[preset] < occupied;
    return { key: preset, label: t(`chat.${preset}`), checked: currentPreset(layout) === preset, icon: <Icon size={16} />, disabled,
      subtitle: disabled ? t("chat.presetTooSmall") : undefined,
      onSelect: () => dispatch({ type: "presetPanes", preset }) };
  });
  return <SidebarPopoverMenu items={items} ariaLabel={t("chat.layout")} triggerTitle={t("chat.layout")}
    align="end" triggerClassName={className} renderTrigger={() => <PanelsTopLeft size={16} aria-hidden="true" />} />;
}
