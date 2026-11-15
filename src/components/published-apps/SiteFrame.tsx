import { useEffect, useState } from "react";

import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { showable, SITE_FRAME_ALLOW, SITE_FRAME_SANDBOX } from "@/lib/published-apps";
import { useFramingRefused } from "./use-framing";

const LOAD_TIMEOUT_MS = 10_000;

/** A published site, live, in a sandboxed frame; or, when it can't be shown here (it refuses framing, asks for a login,
 * never loads, or is not a plain web address), a line saying so and Open in browser. */
export function SiteFrame({ url, title, loginOnly = false, attempt }: { url: string; title: string; loginOnly?: boolean; attempt: number }) {
  const canFrame = showable(url, window.location.origin) && !loginOnly;
  const refused = useFramingRefused(canFrame ? url : null, attempt);
  const [timedOut, setTimedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setTimedOut(false);
    setLoaded(false);
    const timer = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, attempt]);

  if (!canFrame || refused || (timedOut && !loaded)) {
    return (
      <div data-app-preview-fallback="" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[14px] font-medium text-ink">{t("publishedApps.preview.cantShow")}</p>
        <p className="max-w-sm text-[13px] text-ink-secondary">{t(loginOnly ? "publishedApps.preview.loginBody" : "publishedApps.preview.cantShowBody")}</p>
        <button type="button" className="ui-button ui-button-primary" onClick={() => void openExternalLink(url).catch(() => undefined)}>{t("webPanels.page.openInBrowser")}</button>
      </div>
    );
  }
  return (
    <iframe
      key={`${url}:${attempt}`}
      data-app-preview-frame=""
      src={url}
      title={title}
      sandbox={SITE_FRAME_SANDBOX}
      allow={SITE_FRAME_ALLOW}
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
