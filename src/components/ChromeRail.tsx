import { useEffect, useState } from "react";
import { RAIL_MARKS, type RailMark } from "../../electron/chrome-rail.mjs";
import { setLocale } from "@/lib/i18n";
import { effectiveLanguage, useLanguageChoice } from "@/lib/language-preference";
import { wearSkin } from "@/lib/skins";
import { DesktopCapabilitiesProvider } from "./DesktopCapabilities";
import { PlacesRail } from "./PlacesRail";

const railMark = (part: string | null): RailMark | null => (RAIL_MARKS as readonly (string | null)[]).includes(part) ? part as RailMark : null;

/** The window's own rail of places (main's chrome-rail.mjs): this app's page in a narrow view at the window's left edge,
 * beside whichever place's page the window shows, in the skin and language of the app. Its sheets cover the window
 * while open (main widens the view for them). A tour on the page beside it marks the part it points at. */
export function ChromeRail() {
  const language = effectiveLanguage(useLanguageChoice(), undefined);
  const [, setEpoch] = useState(0);
  const [mark, setMark] = useState<RailMark | null>(null);
  useEffect(() => { setLocale(language || globalThis.navigator?.language); setEpoch((epoch) => epoch + 1); }, [language]);
  // The page beside the rail chose its skin: the rail wears the same one.
  useEffect(() => window.ogb?.rail?.onSkin?.(wearSkin), []);
  useEffect(() => window.ogb?.rail?.onMark?.((part) => setMark(railMark(part))), []);
  return <DesktopCapabilitiesProvider><div data-chrome-rail className="h-full"><PlacesRail chrome mark={mark} /></div></DesktopCapabilitiesProvider>;
}
