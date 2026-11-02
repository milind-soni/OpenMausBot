// The tab strip and address bar above a bot's browser. The address bar follows pingdotgg/t3code@00cdceb1
// apps/web/src/components/preview/PreviewChromeRow.tsx, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: OpenMausBot's tabs, control pill and profile button.
import { ArrowLeft, ArrowRight, Expand, Globe, Hand, Loader2, Maximize2, Minimize2, Plus, RotateCw, Shrink, UserRound, X } from "lucide-react";
import { forwardRef, useState, type ReactNode } from "react";

import type { PreviewStreamControl } from "@/lib/browser-stream-client";
import type { BrowserTakeStatus } from "@/lib/browser-control";
import { t } from "@/lib/i18n";

export interface BrowserTab {
  tabId: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserNav {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

const button = "rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

export type PillState = "connecting" | "watching" | "bot" | "yours" | "held" | "elsewhere" | "taking" | "waiting";

/** What the pill says: who has the browser now, from this viewer's side. */
export function controlPill(connected: boolean, control: PreviewStreamControl | null, takeStatus: BrowserTakeStatus): PillState {
  if (!connected || !control) return "connecting";
  if (takeStatus === "pending") return "taking";
  if (takeStatus === "slow") return "waiting";
  if (control.controller === "you") return "yours";
  // The person's hold, used from another view of theirs or not granted yet: they can hand it back from here.
  if (control.owned) return "held";
  if (control.controller === "another-viewer") return "elsewhere";
  return control.controller === "agent" ? "bot" : "watching";
}

const PILL_TEXT: Record<PillState, (bot: string) => string> = {
  connecting: () => t("browser.panel.connecting"),
  watching: () => t("ui.chromeRow.watching"),
  bot: (bot) => t("ui.chromeRow.nameHasControl", { name: bot }),
  yours: () => t("vm.workspace.youHaveControl"),
  held: (bot) => t("ui.chromeRow.nameIsPausedForYou", { name: bot }),
  elsewhere: () => t("ui.chromeRow.heldOnAnotherDevice"),
  taking: () => t("ui.chromeRow.takingControl"),
  waiting: (bot) => t("browser.control.waiting", { name: bot }),
};

export const ChromeRow = forwardRef<HTMLInputElement, {
  botName: string;
  tabs: BrowserTab[];
  nav: BrowserNav;
  connected: boolean;
  control: PreviewStreamControl | null;
  takeStatus: BrowserTakeStatus;
  /** What holding the browser means for the bot, while this view has control. */
  hint?: string;
  /** Toolbar commands are open while connected and the browser is not held on another device. */
  commandsReady: boolean;
  profileName: string;
  fullscreen: boolean;
  /** Maximized: the panel overlays the whole window, instead of its usual share of it. */
  maximized: boolean;
  menu: ReactNode;
  onCommand: (command: { type: "navigate"; url: string } | { type: "history"; delta: -1 | 1 } | { type: "reload" } | { type: "tabSelect"; tabId: string } | { type: "tabClose"; tabId: string } | { type: "tabNew" }) => void;
  onAddress: (text: string) => void;
  onTake: () => void;
  onHandBack: () => void;
  onFullscreen: () => void;
  onMaximize: () => void;
  onProfiles: () => void;
}>(function ChromeRow(props, addressRef) {
  const { botName, tabs, nav, connected, control, takeStatus, commandsReady } = props;
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const pill = controlPill(connected, control, takeStatus);
  const yours = pill === "yours";
  // Whenever the person holds the browser, from this view or another, the pill hands it back.
  const handsBack = yours || pill === "held";
  const shown = nav.url === "about:blank" ? "" : nav.url;
  return (
    <div className="shrink-0 border-b border-hairline/40">
      <div className="flex min-h-10 items-center gap-1 px-2 pt-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label={t("ui.chromeRow.browserTabs")}>
          {tabs.length ? tabs.map((tab) => (
            <div key={tab.tabId} className={`flex max-w-52 shrink-0 items-center gap-1 rounded-xl px-1 text-[12px] ${tab.active ? "bg-inset text-ink" : "text-ink-secondary"}`}>
              <Globe size={13} className="ml-1.5 shrink-0 opacity-60" aria-hidden="true" />
              <button role="tab" aria-selected={tab.active} className="truncate px-1 py-1.5 text-left disabled:cursor-default" disabled={!commandsReady} onClick={() => props.onCommand({ type: "tabSelect", tabId: tab.tabId })} title={tab.title || tab.url}>{tab.title || t("ui.chromeRow.newTab")}</button>
              <button className={button} aria-label={t("ui.chromeRow.closeName", { name: tab.title || t("browser.panel.tab") })} disabled={!commandsReady} onClick={() => props.onCommand({ type: "tabClose", tabId: tab.tabId })}><X size={13} /></button>
            </div>
          )) : <div className="flex items-center gap-2 rounded-xl bg-inset px-3 py-1.5 text-[12px] text-ink-secondary"><Globe size={13} aria-hidden="true" />{t("ui.chromeRow.newTab")}</div>}
          <button className={`${button} shrink-0`} disabled={!commandsReady} aria-label={t("ui.chromeRow.newTab")} title={t("ui.chromeRow.newTab")} onClick={() => props.onCommand({ type: "tabNew" })}><Plus size={16} /></button>
        </div>
        <button
          type="button"
          aria-pressed={handsBack}
          aria-label={`${PILL_TEXT[pill](botName)}. ${t(handsBack ? "browser.control.handBack" : "browser.control.take")}`}
          aria-description={yours ? props.hint : undefined}
          title={yours && props.hint ? props.hint : t(handsBack ? "browser.control.handBack" : "browser.control.take")}
          disabled={!connected || pill === "elsewhere" || pill === "connecting" || pill === "taking" || pill === "waiting"}
          onClick={handsBack ? props.onHandBack : props.onTake}
          className={`flex max-w-56 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] disabled:cursor-default ${handsBack ? "border-accent-border bg-accent/15 text-accent-text" : "border-hairline text-ink-secondary hover:bg-inset hover:text-ink"}`}
          data-pill={pill}
        >
          {pill === "taking" || pill === "waiting" || pill === "connecting" ? <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" /> : <Hand size={12} className="shrink-0" aria-hidden="true" />}
          <span className="truncate">{PILL_TEXT[pill](botName)}</span>
          {pill === "bot" || pill === "watching" ? <span className="shrink-0 text-ink">· {t("browser.control.take")}</span> : handsBack ? <span className="shrink-0">· {t("browser.control.handBack")}</span> : null}
        </button>
        <button className={button} title={props.maximized ? t("ui.chromeRow.restoreSize") : t("window.maximize")} aria-label={props.maximized ? t("ui.chromeRow.restoreSize") : t("window.maximize")} onClick={props.onMaximize}>{props.maximized ? <Shrink size={15} /> : <Expand size={15} />}</button>
        <button className={button} title={props.fullscreen ? t("ui.chromeRow.exitFullScreen") : t("browser.panel.fullscreen")} aria-label={props.fullscreen ? t("ui.chromeRow.exitFullScreen") : t("browser.panel.fullscreen")} onClick={props.onFullscreen}>{props.fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        <button className={`${button} rounded-xl bg-inset p-1.5`} title={t("ui.chromeRow.browserProfileName", { name: props.profileName })} aria-label={t("ui.chromeRow.browserProfiles")} onClick={props.onProfiles}><UserRound size={15} /></button>
      </div>
      <form
        className="relative flex h-10 items-center gap-1 px-2"
        onSubmit={(event) => {
          event.preventDefault();
          props.onAddress(draft);
          (addressRef && typeof addressRef === "object" ? addressRef.current : null)?.blur();
        }}
      >
        <div className="flex shrink-0 items-center" role="group" aria-label={t("ui.chromeRow.navigation")}>
          <button type="button" className={button} disabled={!commandsReady || !nav.canGoBack} aria-label={t("whatsNew.back")} title={t("whatsNew.back")} onClick={() => props.onCommand({ type: "history", delta: -1 })}><ArrowLeft size={16} /></button>
          <button type="button" className={button} disabled={!commandsReady || !nav.canGoForward} aria-label={t("browser.panel.forward")} title={t("browser.panel.forward")} onClick={() => props.onCommand({ type: "history", delta: 1 })}><ArrowRight size={16} /></button>
          <button type="button" className={button} disabled={!commandsReady} aria-label={nav.loading ? t("ui.chromeRow.loadingReloadPage") : t("ui.chromeRow.reloadPage")} title={t("html.reload")} onClick={() => props.onCommand({ type: "reload" })}>
            {nav.loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}
          </button>
        </div>
        <input
          ref={addressRef}
          aria-label={t("ui.chromeRow.browserAddress")}
          readOnly={!commandsReady}
          value={editing ? draft : shown}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            setDraft(shown);
            setEditing(true);
            if (commandsReady) queueMicrotask(() => event.target.select());
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft(shown);
            event.currentTarget.blur();
          }}
          placeholder={connected ? t("ui.chromeRow.searchOrEnterAddress") : t("browser.panel.connecting")}
          spellCheck={false}
          className="mx-1 min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1.5 text-center text-[12px] outline-none placeholder:text-ink-secondary focus:bg-inset focus:text-left"
        />
        {props.menu}
        <div aria-hidden="true" data-loading={nav.loading} className={`pointer-events-none absolute bottom-0 left-0 h-0.5 bg-accent transition-[width,opacity] duration-500 ${nav.loading ? "w-2/3 opacity-100" : "w-full opacity-0"}`} />
      </form>
    </div>
  );
});
