import { useState, type CSSProperties } from "react";
import { bannerSrc, type BannerSummary } from "@/lib/place-banner";
import { placeTint, usePlaceLook } from "@/lib/place-look";
import { useStore } from "@/state/store";

/** What the top of the sidebar shows, first that applies: the workspace's banner picture (kept on its own server), the
 * place's colour, or nothing as it always was. Under the picture the colour waits for a picture that won't load, and
 * for reduced transparency, where the picture is never shown (styles.css .place-banner). */
export function PlaceTop({ banner, color }: { banner: BannerSummary | null | undefined; color: unknown }) {
  const src = bannerSrc(banner);
  const [broken, setBroken] = useState<string | null>(null);
  const picture = src && src !== broken ? src : null;
  const tint = placeTint(color);
  return <>
    {picture && <div aria-hidden="true" data-place-banner className="place-banner pointer-events-none absolute inset-x-0 top-0">
      <img src={picture} alt="" draggable={false} onError={() => setBroken(picture)} />
    </div>}
    {tint && <div aria-hidden="true" data-place-tint data-under-banner={picture ? "" : undefined} className="place-tint pointer-events-none absolute inset-x-0 top-0" style={tint as CSSProperties} />}
  </>;
}

/** The sidebar's own: this page's banner from its server's settings, and its place's colour from the app. */
export function PlaceTint() {
  const { state } = useStore();
  return <PlaceTop banner={state.config?.workspaceBanner} color={usePlaceLook()?.color} />;
}
