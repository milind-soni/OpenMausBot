import { useState } from "react";
import { AppWindow } from "lucide-react";
import { t } from "@/lib/i18n";
import { MENU_ICON, MENU_ROW } from "./menu-recipe";

export function OpenWorkspaceWindowAction({ placeId, onOpened }: { placeId: string; onOpened: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const openWindow = typeof window === "undefined" ? undefined : window.ogb?.workspaces?.openWindow;
  if (!openWindow) return null;
  const open = async () => {
    setBusy(true);
    setFailed(false);
    try {
      if (await openWindow(placeId)) onOpened();
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={MENU_ROW} disabled={busy} aria-busy={busy} onClick={() => void open()} data-open-window>
      <AppWindow size={15} className={MENU_ICON} aria-hidden="true" />{t("workspace.openWindow")}
    </button>
    {failed && <p role="alert" className="px-2 text-[12px] text-danger">{t("workspace.windowFailed")}</p>}
  </>;
}
