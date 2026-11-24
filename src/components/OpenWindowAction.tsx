import { useState } from "react";
import { AppWindow } from "lucide-react";
import { t } from "@/lib/i18n";
import { MENU_ICON, MENU_ROW } from "./menu-recipe";

type Target = { place: string } | { bot: string; thread: string };

export function OpenWindowAction({ target, onOpened, menuItem }: { menuItem?: boolean; target: Target; onOpened: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const desktop = typeof window === "undefined" ? undefined : window;
  const openWindow = desktop?.ogb?.workspaces?.openWindow;
  const openThread = desktop?.ombChatWindow?.openThread ?? desktop?.ogb?.workspaces?.openThread;
  const request = "place" in target
    ? openWindow && (() => openWindow(target.place))
    : openThread && (() => openThread(target.bot, target.thread));
  if (!request) return null;
  const open = async () => {
    setBusy(true);
    setFailed(false);
    try {
      if (await request()) onOpened();
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" role={menuItem ? "menuitem" : undefined} className={MENU_ROW} disabled={busy} aria-busy={busy} onClick={() => void open()} data-open-window>
      <AppWindow size={15} className={MENU_ICON} aria-hidden="true" />{t("workspace.openWindow")}
    </button>
    {failed && <p role="alert" className="px-2 text-[12px] text-danger">{t("workspace.windowFailed")}</p>}
  </>;
}
