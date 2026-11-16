import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { appInitial, showable, SITE_FRAME_ALLOW, SITE_THUMB_SANDBOX } from "@/lib/published-apps";
import { useFramingBlock } from "./use-framing";

const SITE_WIDTH = 1280, SITE_HEIGHT = 800;
const LOAD_TIMEOUT_MS = 12_000;

/** A card's picture: the live site drawn small, loaded only once the card is on screen and never taking a click or
 * the keyboard; until it has loaded, and whenever it can't be shown, a plain tile with the app's initial. With
 * `sayLogin`, a site that asks for a login gets that line instead of the initial. With `unloadOffScreen`, the site is
 * dropped while the card is well off screen and drawn again when it comes back. */
export function SiteThumb({ url, title, loginOnly, sayLogin = false, unloadOffScreen = false }: { url: string; title: string; loginOnly: boolean; sayLogin?: boolean; unloadOffScreen?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [seen, setSeen] = useState(false);
  const [scale, setScale] = useState(0.25);
  const [loaded, setLoaded] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const canFrame = showable(url, window.location.origin) && !loginOnly;
  const block = useFramingBlock(canFrame && seen ? url : null);
  const refused = block !== null;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const size = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => setScale(element.clientWidth / SITE_WIDTH));
    size?.observe(element);
    if (typeof IntersectionObserver === "undefined") { setOnScreen(true); setSeen(true); return () => size?.disconnect(); }
    const watch = new IntersectionObserver((entries) => {
      if (entries.at(-1)?.isIntersecting) {
        setOnScreen(true);
        setSeen(true);
        if (!unloadOffScreen) watch.disconnect();
      } else if (unloadOffScreen) {
        setOnScreen(false);
        setLoaded(false);
      }
    }, { rootMargin: unloadOffScreen ? "600px" : "200px" });
    watch.observe(element);
    return () => { size?.disconnect(); watch.disconnect(); };
  }, [unloadOffScreen]);

  const framed = canFrame && onScreen && !refused && !gaveUp;
  useEffect(() => {
    if (!framed || loaded) return;
    const timer = setTimeout(() => setGaveUp(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [framed, loaded]);

  const login = sayLogin && (loginOnly || block === "login");
  return (
    <div ref={box} data-app-thumb={login ? "login" : framed && loaded ? "live" : "tile"} className="relative aspect-[16/10] w-full overflow-hidden bg-inset">
      {login
        ? <p data-app-preview-fallback="" className="absolute inset-0 flex items-center justify-center p-4 text-center text-[13px] text-ink-secondary">{t("publishedApps.preview.loginBody")}</p>
        : <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-[44px] font-semibold text-ink-tertiary">{appInitial(title)}</div>}
      {framed && (
        <iframe
          src={url}
          title=""
          aria-hidden="true"
          tabIndex={-1}
          loading="lazy"
          sandbox={SITE_THUMB_SANDBOX}
          allow={SITE_FRAME_ALLOW}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          style={{ width: SITE_WIDTH, height: SITE_HEIGHT, transform: `scale(${scale})`, transformOrigin: "0 0", opacity: loaded ? 1 : 0 }}
          className="pointer-events-none absolute left-0 top-0 select-none border-0 bg-white transition-opacity duration-300"
        />
      )}
    </div>
  );
}
