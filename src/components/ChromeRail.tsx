import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { effectiveLanguage, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { wearSkin } from "@/lib/skins";
import { AccountsSheet, useAccountsSheet } from "./AccountMenu";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";
import { PlacesRail } from "./PlacesRail";
import { WindowPlacesList, useWindowPlacesList } from "./WindowPlacesList";

/** The window's own rail of places (main's chrome-rail.mjs): this app's page in a narrow view at the window's left edge,
 * beside whichever place's page the window shows, in the skin and language of the app. Its sheets cover the window
 * while open (main widens the view for them). */
export function ChromeRail() {
  usePageLanguage(effectiveLanguage(useLanguageChoice(), undefined));
  // The page beside the rail chose its skin: the rail wears the same one.
  useEffect(() => window.ogb?.rail?.onSkin?.(wearSkin), []);
  const accounts = useAccountsSheet(), list = useWindowPlacesList();
  return <DesktopCapabilitiesProvider>
    <div data-chrome-rail className={cn("h-full", list.hidesRail && "invisible")}><PlacesRail chrome /></div>
    {accounts.open && <AccountsSheet onClose={accounts.close} />}
    {list.open && <WindowPlacesList onClose={list.close} />}
  </DesktopCapabilitiesProvider>;
}
