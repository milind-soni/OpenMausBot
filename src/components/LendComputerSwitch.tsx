// "Let <server>'s bots use this computer": one switch with one line under it, wherever a server of the person's own is
// shown (src/lib/use-lend-computer.ts holds its state). A server it can't be lent to shows the one-line reason instead.
import { useEffect, useState } from "react";
import { DESKTOP_DOWNLOAD_URL } from "../../shared/computer-ask";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { pageOnRemoteServer } from "@/lib/local-computer";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { lendLine, useLendComputer } from "@/lib/use-lend-computer";
import { cn } from "@/lib/cn";
import { Switch } from "./SettingsPrimitives";

/** `setting`: a Settings switch row's type (a 14 px title, a 13 px line), with no box of its own. */
type Look = "row" | "panel" | "setting";

/** `id`: the saved server on this app's own page, null on a server's own page. `onChoose`: Advanced's folders and terminal
 * for it, offered once it is on. `quietReasons`: reasons a Cloud or team gives are left out (a panel that isn't about
 * This computer). */
export function LendComputerSwitch({ id, look = "row", onChoose, quietReasons = false, className }: { id: string | null; look?: Look; onChoose?: () => void; quietReasons?: boolean; className?: string }) {
  const lend = useLendComputer(id);
  const view = lend.view;
  if (!lend.available || !view) return null;
  const line = lendLine(view);
  if (!view.lendable) {
    if (quietReasons && (view.why === "cloud" || view.why === "team")) return null;
    return <p data-lend-reason={view.why} className={cn("text-[12px] leading-4 text-ink-secondary", look === "panel" && "mt-3 text-center", className)}>{line}</p>;
  }
  const title = t("lend.title", { name: view.name });
  const setting = look === "setting";
  return <div data-lend-switch={view.on ? "on" : "off"} className={cn("flex items-start gap-3", !setting && "rounded-lg bg-inset px-3 py-2", look === "panel" && "mt-3 text-left", className)}>
    <div className="min-w-0 flex-1">
      <div className={setting ? "text-[14px] leading-5 text-ink" : "text-[12px] font-medium text-ink"}>{title}</div>
      <div data-lend-line className={setting ? "mt-0.5 text-[13px] leading-[18px] text-ink-secondary" : "text-[12px] leading-4 text-ink-secondary"}>{line}</div>
      {view.on && view.screen === "permissions" && <button type="button" data-lend-allow disabled={lend.busy} onClick={() => void lend.allowScreen()}
        className="mt-1 text-[12px] font-medium text-accent-text hover:underline disabled:opacity-50">{t("lend.screen.allow")}</button>}
      {lend.error && <div role="alert" className="text-[12px] leading-4 text-danger">{lend.error}</div>}
    </div>
    {view.on && onChoose && <button type="button" onClick={onChoose} className="shrink-0 self-center text-[12px] font-medium text-accent-text hover:underline">{t("servers.share.choose")}</button>}
    <Switch checked={lend.on} disabled={lend.busy} aria-label={title} className="self-center" onClick={() => void lend.set(!lend.on)} />
  </div>;
}

/** The Screen panel: on a server's own page in the desktop app, its switch; in a browser, for a bot set to This computer,
 * that only the app on a computer can lend it, with where to get it. Nothing on this app's own page. */
export function LendHere({ appNeeded = false }: { appNeeded?: boolean }) {
  const { capabilities } = useDesktopCapabilities();
  if (window.ogb?.lendComputer && pageOnRemoteServer(capabilities)) return <LendComputerSwitch id={null} look="panel" quietReasons={!appNeeded} />;
  if (!appNeeded || capabilities.host.label !== "Browser") return null;
  return <p data-lend-browser className="mt-3 text-center text-[12px] leading-4 text-ink-secondary">
    {t("lend.browser", { app: productName() })}{" "}
    <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="font-medium text-accent-text hover:underline">{t("computerAsk.action.getApp", { app: productName() })}</a>
  </p>;
}

/** The add form: lend to the server being added once it is paired, if it turns out to be the person's own. Off unless
 * turned on; never shown when pairing a saved server again, where off would read as stopping it. */
export function AddFormLendSwitch({ address }: { address: string }) {
  const wish = window.ogb?.lendComputer?.wish;
  const [on, setOn] = useState(false);
  const trimmed = address.trim();
  useEffect(() => { if (wish && trimmed) void wish(trimmed, on).catch(() => {}); }, [wish, trimmed, on]);
  if (!wish) return null;
  const title = t("lend.addTitle");
  return <div data-lend-add={on ? "on" : "off"} className="flex items-start gap-3">
    <div className="min-w-0 flex-1">
      <div className="text-[13px] font-medium text-ink">{title}</div>
      <div className="text-[12px] leading-4 text-ink-secondary">{t("lend.addLine", { app: productName() })}</div>
    </div>
    <Switch checked={on} aria-label={title} className="self-center" onClick={() => setOn(!on)} />
  </div>;
}
