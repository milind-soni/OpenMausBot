// Bots in two places (electron/two-places.mjs), as this computer's page sees it: the one place main suggests bringing them
// together on, or none; undefined until main first answers, and always none in a browser or on another place's page.
import { useEffect, useState } from "react";

export interface TwoPlacesSuggestion { key: string; name: string; kind: "cloud" | "server" }

const bridge = () => (typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.twoPlaces);

export function useTwoPlaces(): { suggest: TwoPlacesSuggestion | null | undefined; accept(key: string): Promise<void>; dismiss(key: string): void } {
  const [suggest, setSuggest] = useState<TwoPlacesSuggestion | null | undefined>(bridge() ? undefined : null);
  useEffect(() => {
    const twoPlaces = bridge();
    if (!twoPlaces) return;
    let alive = true;
    const read = () => { void twoPlaces.state().then((next) => { if (alive) setSuggest(next?.suggest ?? null); }, () => { if (alive) setSuggest(null); }); };
    const unsubscribe = twoPlaces.onChanged(read);
    window.addEventListener("focus", read);
    read();
    return () => { alive = false; unsubscribe(); window.removeEventListener("focus", read); };
  }, []);
  return {
    suggest,
    async accept(key) {
      const next = await bridge()?.accept(key);
      setSuggest(next?.suggest ?? null);
    },
    dismiss(key) {
      setSuggest(null);
      void bridge()?.dismiss(key).catch(() => {});
    },
  };
}
