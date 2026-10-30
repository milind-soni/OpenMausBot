// A pinned web page shown in place of the chat, like Team map. The page is
// framed with a sandbox and no referrer; a page that refuses framing (or
// never loads) falls back to a button that opens it in the browser.
import { ExternalLink, Globe, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { useWebPanels } from "@/lib/web-panel-preferences";
import { isAppOrigin } from "@/lib/web-panels";
import { useStore } from "@/state/store";

const LOAD_TIMEOUT_MS = 10_000;

export function WebPanelPage() {
  const { state, dispatch } = useStore();
  const panels = useWebPanels();
  const panel = panels.find((entry) => entry.id === state.webPanelId);
  const [reloads, setReloads] = useState(0);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");

  // A removed panel leaves nothing to show: go back to the conversation.
  useEffect(() => {
    if (!panel) dispatch({ type: "showChat" });
  }, [panel, dispatch]);

  useEffect(() => {
    setStatus("loading");
    const timer = setTimeout(() => setStatus((current) => (current === "loading" ? "failed" : current)), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [panel?.url, reloads]);

  if (!panel) return null;
  const openInBrowser = () => void openExternalLink(panel.url).catch(() => undefined);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-app" aria-label={panel.name}>
      <header className="flex items-center gap-2 border-b border-hairline/40 px-4 py-2.5">
        <Globe size={16} className="shrink-0 text-ink-secondary" />
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink" title={panel.url}>{panel.name}</h1>
        <button
          type="button"
          className="ui-icon-button shrink-0"
          aria-label={t("webPanels.page.reload")}
          title={t("webPanels.page.reload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <RotateCw size={16} />
        </button>
        <button type="button" className="ui-button" onClick={openInBrowser}>
          <ExternalLink size={14} />
          {t("webPanels.page.openInBrowser")}
        </button>
      </header>
      {status === "failed" || isAppOrigin(panel.url, window.location.origin) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[14px] font-medium text-ink">{t("webPanels.page.cantEmbed")}</p>
          <p className="max-w-sm text-[13px] text-ink-secondary">{t("webPanels.page.cantEmbedBody")}</p>
          <button type="button" className="ui-button ui-button-primary" onClick={openInBrowser}>
            {t("webPanels.page.openInBrowser")}
          </button>
        </div>
      ) : (
        <iframe
          key={`${panel.id}:${reloads}`}
          src={panel.url}
          title={panel.name}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("failed")}
          className="min-h-0 w-full flex-1 border-0 bg-app"
        />
      )}
    </main>
  );
}
