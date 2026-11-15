import { useEffect, useRef, useState } from "react";
import { ExternalLink, RotateCw, X } from "lucide-react";

import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { openExternalLink } from "@/lib/app-links";
import { closeAppPreview, useAppPreview } from "@/lib/app-preview";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, useComputerPanelResize } from "../computer-panel-resize";
import { SiteFrame } from "./SiteFrame";

/** The published app a card's Preview or a link in a message opened, beside the conversation where the Computer panel
 * sits. One panel has that side at a time: it gives way when another one opens. */
export function AppPreviewPanel() {
  const preview = useAppPreview();
  const { state } = useStore();
  const otherPanel = state.computerOpen || state.settingsOpen || state.inspectorOpen || state.activityOpen;
  const hadOtherPanel = useRef(otherPanel);
  useEffect(() => {
    if (otherPanel && !hadOtherPanel.current) closeAppPreview();
    hadOtherPanel.current = otherPanel;
  }, [otherPanel]);
  if (!preview || otherPanel || state.activeView !== "chat") return null;
  return <PreviewPanel key={preview.url} url={preview.url} title={preview.title} loginOnly={preview.loginOnly === true} />;
}

function PreviewPanel({ url, title, loginOnly }: { url: string; title: string; loginOnly: boolean }) {
  const { dragProps } = useCaptionChrome();
  const { panelWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize();
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  return (
    <aside aria-label={t("publishedApps.preview.aria", { name: title })} data-app-preview={url} style={{ width: panelWidth }}
      className="animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!">
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={(event) => { setDragging(true); onResizeStart(event); }}
        onPointerMove={onResizeMove}
        onPointerUp={(event) => { setDragging(false); onResizeEnd(event); }}
        onPointerCancel={(event) => { setDragging(false); onResizeEnd(event); }}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"
      />
      <header {...dragProps} className="ml-1.5 flex items-center gap-1 py-2.5 pl-2.5 pr-3">
        <div className="min-w-0 flex-1">
          <h2 dir="auto" className="truncate text-[14px] font-semibold text-ink">{title}</h2>
          <p dir="ltr" className="truncate text-[12px] text-ink-secondary" title={url}>{new URL(url).host}</p>
        </div>
        <button type="button" className="ui-icon-button shrink-0" aria-label={t("webPanels.page.reload")} title={t("webPanels.page.reload")} onClick={() => setAttempt((n) => n + 1)}><RotateCw size={16} /></button>
        <button type="button" className="ui-icon-button shrink-0" aria-label={t("webPanels.page.openInBrowser")} title={t("webPanels.page.openInBrowser")} onClick={() => void openExternalLink(url).catch(() => undefined)}><ExternalLink size={16} /></button>
        <button type="button" className="ui-icon-button shrink-0" aria-label={t("publishedApps.preview.close")} title={t("publishedApps.preview.close")} onClick={closeAppPreview}><X size={18} /></button>
      </header>
      {/* A cross-origin frame swallows the pointer, so the resize drag would stop the moment it crossed the site. */}
      <div className={dragging ? "pointer-events-none flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1 flex-col"}>
        <SiteFrame url={url} title={title} loginOnly={loginOnly} attempt={attempt} />
      </div>
    </aside>
  );
}
