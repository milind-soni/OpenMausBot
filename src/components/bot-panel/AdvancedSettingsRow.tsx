import { SlidersHorizontal } from "lucide-react";

import { t } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_ONLY } from "@/lib/simple-only";
import { useStore } from "@/state/store";
import { Card, NavRow } from "./rows";

/** Simple mode leaves out Sending on your behalf and per-app Access; this row says they exist and opens them in Advanced mode. */
export function AdvancedSettingsRow() {
  const { dispatch } = useStore();
  if (SIMPLE_ONLY) return null;
  const open = () => {
    setAdvancedMode(true);
    dispatch({ type: "toggleSettings", open: true, section: "permissions" });
  };
  return (
    <Card anchor="advanced">
      <NavRow data-panel-row="advanced" icon={SlidersHorizontal} title={t("botPanel.advanced.title")} hint={t("botPanel.advanced.hint")} onClick={open} />
    </Card>
  );
}
