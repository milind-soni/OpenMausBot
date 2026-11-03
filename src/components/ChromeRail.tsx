import { useEffect } from "react";
import { effectiveLanguage, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { wearSkin } from "@/lib/skins";
import { AccountsSheet, useAccountsSheet } from "./AccountMenu";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";
import { PlacesRail } from "./PlacesRail";

/** The window's own rail of places (main's chrome-rail.mjs): this app's page in a narrow view at the window's left edge,
 * beside whichever place's page the window shows, in the skin and language of the app. Its sheets cover the window
 * while open (main widens the view for them). */
export function ChromeRail() {
  usePageLanguage(effectiveLanguage(useLanguageChoice(), undefined));
  // The page beside the rail chose its skin: the rail wears the same one.
  useEffect(() => window.ogb?.rail?.onSkin?.(wearSkin), []);
  const accounts = useAccountsSheet();
  return <DesktopCapabilitiesProvider><div data-chrome-rail className="h-full"><PlacesRail chrome /></div>{accounts.open && <AccountsSheet onClose={accounts.close} />}</DesktopCapabilitiesProvider>;
}
