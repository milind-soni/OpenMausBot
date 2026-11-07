// The browser panel's menu. Its zoom row follows pingdotgg/t3code@00cdceb1
// apps/web/src/components/preview/PreviewMoreMenu.tsx, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: OpenMausBot's items, and viewport sizes instead of a device toolbar.
import { Check, EllipsisVertical, Minus, Plus, RotateCcw } from "lucide-react";
import { useRef, type ReactNode } from "react";

import type { PreviewViewportSetting } from "@/lib/browser-stream-client";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** Chrome's own zoom levels. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS.at(-1)!;
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0];
}

export const VIEWPORTS: ReadonlyArray<{ label: LocaleKey; setting: PreviewViewportSetting }> = [
  { label: "browser.viewport.fill", setting: { mode: "fill" } },
  { label: "browser.viewport.fullHd", setting: { mode: "preset", preset: "fullHd" } },
  { label: "browser.viewport.desktop", setting: { mode: "preset", preset: "desktop" } },
  { label: "browser.viewport.tablet", setting: { mode: "preset", preset: "tablet" } },
  { label: "browser.viewport.phone", setting: { mode: "preset", preset: "phone" } },
];

const sameSetting = (a: PreviewViewportSetting, b: PreviewViewportSetting) =>
  a.mode === b.mode && (a.mode !== "preset" || (b.mode === "preset" && a.preset === b.preset));

const item = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-start hover:bg-inset disabled:cursor-not-allowed disabled:opacity-40";
const small = "rounded-md border border-hairline p-1 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-40";

export function MoreMenu({ stream, ready, typing, setting, zoom, pip, onViewport, onZoom, onPip, onType, onSecret, onReconnect, onRestart }: {
  /** Viewport sizes, zoom and picture in picture come with the v2 stream only. */
  stream: boolean;
  /** The person holds the browser, so its page can be sized and zoomed. */
  ready: boolean;
  typing: boolean;
  setting: PreviewViewportSetting;
  zoom: number;
  /** Null where this browser cannot float a video. */
  pip: { open: boolean } | null;
  onViewport: (setting: PreviewViewportSetting) => void;
  onZoom: (factor: number) => void;
  onPip: () => void;
  onType: () => void;
  onSecret: () => void;
  onReconnect: () => void;
  onRestart: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const run = (action: () => void) => () => {
    menu.current?.removeAttribute("open");
    action();
  };
  const section = (children: ReactNode) => <div className="border-b border-hairline/40 py-1 last:border-b-0">{children}</div>;
  return (
    <details ref={menu} className="relative shrink-0">
      <summary className="list-none cursor-pointer rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink [&::-webkit-details-marker]:hidden" aria-label={t("browser.panel.menu")} title={t("browser.panel.menu")}><EllipsisVertical size={16} /></summary>
      <div className="absolute end-0 top-full z-40 mt-2 flex w-56 flex-col rounded-xl border border-hairline/50 bg-card p-1 text-[12px] text-ink shadow-xl" role="menu">
        {stream ? section(<>
          <div className="px-3 pb-1 pt-1.5 text-[11px] text-ink-tertiary">{t("browser.viewport.title")}</div>
          {VIEWPORTS.map((viewport) => (
            <button key={viewport.label} type="button" role="menuitemradio" aria-checked={sameSetting(viewport.setting, setting)} className={item} disabled={!ready} onClick={run(() => onViewport(viewport.setting))}>
              <span className="w-3.5 shrink-0">{sameSetting(viewport.setting, setting) ? <Check size={13} aria-hidden="true" /> : null}</span>{t(viewport.label)}
            </button>
          ))}
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
            <span>{t("settings.profile.avatar.zoom")}</span>
            <span className="flex items-center gap-1">
              <button type="button" className={small} aria-label={t("browser.zoom.out")} disabled={!ready || zoom <= ZOOM_LEVELS[0]} onClick={() => onZoom(nextZoom(zoom, -1))}><Minus size={12} /></button>
              <span className="min-w-11 text-center tabular-nums text-ink-secondary" aria-live="polite">{Math.round(zoom * 100)}%</span>
              <button type="button" className={small} aria-label={t("browser.zoom.in")} disabled={!ready || zoom >= ZOOM_LEVELS.at(-1)!} onClick={() => onZoom(nextZoom(zoom, 1))}><Plus size={12} /></button>
              <button type="button" className={small} aria-label={t("browser.zoom.reset")} disabled={!ready || zoom === 1} onClick={() => onZoom(1)}><RotateCcw size={12} /></button>
            </span>
          </div>
        </>) : null}
        {section(<>
          {stream && pip ? <button type="button" role="menuitem" className={item} onClick={run(onPip)}>{t(pip.open ? "browser.pip.close" : "browser.pip.open")}</button> : null}
          <button type="button" role="menuitem" className={item} disabled={!typing} onClick={run(onType)}>{t("browser.panel.typeTextMenu")}</button>
          <button type="button" role="menuitem" className={item} disabled={!typing} onClick={run(onSecret)}>{t("browser.typeSecret")}</button>
        </>)}
        {section(<>
          <button type="button" role="menuitem" className={item} onClick={run(onReconnect)}>{t("browser.panel.reconnectView")}</button>
          <button type="button" role="menuitem" className={item} onClick={run(onRestart)}>{t("browser.panel.restartBrowser")}</button>
        </>)}
      </div>
    </details>
  );
}
