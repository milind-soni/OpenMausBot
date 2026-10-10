import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Clipboard, Keyboard, Maximize, Minimize, Monitor, RefreshCw, Send, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import RFB from "@novnc/novnc";
import { t } from "@/lib/i18n";
import { useHeldMenuMotion, useMenuMotion } from "./MenuMotion";

function subscribeLocation(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}
const locationHash = () => location.hash;

/** Served through the app's normal route/build. Only desktop pixels and
 * input cross the VM boundary; the VM never supplies this page's code. */
export function DesktopViewer() {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected" | "invalid">("connecting");
  const connected = connection === "connected";
  const status = t(`desktopViewer.${connection}`);
  const [panel, setPanel] = useState<"keyboard" | "clipboard" | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlError, setControlError] = useState("");
  const [clipboard, setClipboard] = useState("");
  const panelMotion = useHeldMenuMotion(panel);
  const handleMotion = useMenuMotion(!expanded);
  const keyboardPanel = panelMotion.value === "keyboard";
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [text, setText] = useState("");
  const hash = useSyncExternalStore(subscribeLocation, locationHash);
  const params = new URLSearchParams(hash.slice(1));
  const target = params.get("target");
  const threadId = params.get("threadId");

  useEffect(() => {
    setClipboard("");
    setText("");
    setPanel(null);
  }, [target, threadId]);

  useEffect(() => {
    const controller = new AbortController();
    let client: RFB | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const oldTitle = document.title;
    document.title = t("desktopViewer.title");
    setConnection("connecting");
    const connect = async () => {
      try {
        if (!target || !/^(local\/(shared|bot-[a-f0-9]{64}|pool-\d+)|vps\/[\w-]+)$/.test(target)) return setConnection("invalid");
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        if (target.startsWith("vps/")) {
          const query = threadId ? `?${new URLSearchParams({ threadId })}` : "";
          const joined = await fetch(`/api/bots/${target.slice(4)}/computer/join${query}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal,
          });
          if (!joined.ok) throw new Error("join failed");
          if (controller.signal.aborted) return;
        }
        const path = `/api/desktop-viewer/${target}`;
        const response = await fetch(path, {
          signal,
          credentials: "same-origin", cache: "no-store",
        });
        if (!response.ok) throw new Error("viewer unavailable");
        const config = await response.json();
        if (controller.signal.aborted) return;
        const websocket = new URL(`${path}/websockify`, location.href);
        websocket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        client = new RFB(screen.current!, websocket.href, {
          credentials: { password: config.password ?? "", username: "", target: "" },
        });
        rfb.current = client;
        client.scaleViewport = true;
        client.background = "var(--color-inset)";
        client.focusOnClick = panelRef.current === null;
        client.addEventListener("clipboard", event => { if (!controller.signal.aborted) setClipboard(event.detail.text); });
        deadline = setTimeout(() => {
          client?.disconnect();
          setConnection("disconnected");
        }, 15_000);
        client.addEventListener("connect", () => {
          if (controller.signal.aborted) return;
          clearTimeout(deadline);
          setConnection("connected");
        });
        client.addEventListener("disconnect", () => {
          if (controller.signal.aborted) return;
          clearTimeout(deadline);
          setConnection("disconnected");
        });
      } catch {
        if (!controller.signal.aborted) setConnection("disconnected");
      }
    };
    void connect();
    const disconnect = () => {
      controller.abort();
      clearTimeout(deadline);
      client?.disconnect();
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) setAttempt(value => value + 1); };
    window.addEventListener("pagehide", disconnect);
    window.addEventListener("pageshow", restore);
    return () => {
      disconnect();
      if (rfb.current === client) rfb.current = null;
      window.removeEventListener("pagehide", disconnect);
      window.removeEventListener("pageshow", restore);
      document.title = oldTitle;
    };
  }, [target, threadId, attempt]);

  useEffect(() => {
    if (rfb.current) {
      rfb.current.focusOnClick = panel === null;
    }
  }, [panel]);

  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggleFullscreen = async () => {
    setControlError("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setControlError(t("desktopViewer.fullscreenFailed"));
    }
  };
  const closePanel = () => {
    setPanel(null);
    if (panel) document.getElementById(panel)?.focus();
  };
  // After the commit that clears `inert`, so focus is not dropped to <body>.
  const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
  const togglePanel = (next: "keyboard" | "clipboard") => setPanel(value => value === next ? null : next);
  const slide = "transition-[width,translate,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";
  const action = "ui-button min-h-11 rounded-xl focus-visible:outline-2 focus-visible:outline-focus";

  return (
    <div className="relative flex h-dvh overflow-hidden bg-app text-sm text-ink" style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}>
      <aside aria-label={t("desktopViewer.controls")} aria-hidden={!expanded} inert={!expanded} className={cn("z-10 flex shrink-0 items-center justify-center py-3", slide, expanded ? "w-[72px]" : "w-0")}>
        <div className={cn("flex max-h-full w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-2xl border border-hairline bg-panel p-1 shadow-xl", slide, expanded ? "translate-x-0 opacity-100" : "-translate-x-12 opacity-0")}>
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center text-ink-secondary" title={status}>
            <Monitor size={20} aria-hidden="true" />
            <span className={cn("absolute right-2 bottom-2 size-2 rounded-full ring-2 ring-panel", connected ? "bg-success" : "bg-warning")} />
          </div>
          <div className="my-1 h-px w-7 shrink-0 bg-hairline" />
          <ViewerTool id="keyboard" label={t("desktopViewer.keyboard")} icon={Keyboard} disabled={!connected} active={panel === "keyboard"} expanded={panel === "keyboard"} onClick={() => togglePanel("keyboard")} />
          <ViewerTool id="clipboard" label={t("desktopViewer.clipboard")} icon={Clipboard} disabled={!connected} active={panel === "clipboard"} expanded={panel === "clipboard"} onClick={() => togglePanel("clipboard")} />
          {document.fullscreenEnabled && <ViewerTool id="fullscreen" label={t(fullscreen ? "desktopViewer.exitFullscreen" : "desktopViewer.fullscreen")} icon={fullscreen ? Minimize : Maximize} onClick={() => { void toggleFullscreen(); }} />}
          <div className="my-1 h-px w-7 shrink-0 bg-hairline" />
          <ViewerTool id="retry" label={t("desktopViewer.reconnect")} icon={RefreshCw} onClick={() => { setClipboard(""); setAttempt(value => value + 1); }} />
          <ViewerTool id="hide-controls" label={t("desktopViewer.hideControls")} icon={ChevronLeft} onClick={() => { setExpanded(false); setPanel(null); focusSoon("show-controls"); }} />
        </div>
      </aside>
      {handleMotion.shown && <div {...handleMotion.exitProps} className={cn("absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-r-2xl border border-l-0 border-hairline bg-panel p-1 shadow-xl", handleMotion.className)}>
        <ViewerTool id="show-controls" label={t("desktopViewer.showControls")} icon={ChevronRight} onClick={() => { setExpanded(true); focusSoon("hide-controls"); }} />
      </div>}

      <main className={cn("relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-inset", !fullscreen && "my-2 mr-2 rounded-2xl border border-hairline", !fullscreen && !expanded && "ml-2")}>
        <div id="screen" ref={screen} role="application" aria-label={t("desktopViewer.title")} className={cn("overflow-hidden", fullscreen ? "h-full w-full" : "h-[95%] w-[95%]")} />
        <div className={connected ? "sr-only" : "pointer-events-none absolute inset-x-3 top-3 flex justify-center"}>
          <span id="status" role="status" className="max-w-full rounded-full border border-hairline bg-panel/95 px-3 py-1.5 text-center text-xs text-ink-secondary shadow-sm">{status}</span>
        </div>
        {controlError && <p role="alert" className="absolute inset-x-3 bottom-3 rounded-xl border border-hairline bg-panel p-3 text-ink">{controlError}</p>}
      </main>

      <a id="viewer-notice" href="/novnc-NOTICE.txt" target="_blank" rel="license noopener noreferrer" title={t("desktopViewer.notice")} aria-label={t("desktopViewer.notice")} className="absolute bottom-2 right-2 z-10 flex min-h-6 w-11 items-center justify-center rounded-lg bg-app/80 text-[10px] text-ink-secondary hover:text-ink hover:underline" style={{ marginRight: "env(safe-area-inset-right)", marginBottom: "env(safe-area-inset-bottom)" }}>noVNC</a>

      {panelMotion.shown && <section {...panelMotion.exitProps} aria-label={t(keyboardPanel ? "desktopViewer.keyboard" : "desktopViewer.clipboard")} onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closePanel(); }
      }} className={cn("absolute left-[72px] top-1/2 z-20 max-h-[calc(100dvh-24px)] w-[min(320px,calc(100%-84px))] -translate-y-1/2 overflow-y-auto rounded-2xl border border-hairline bg-panel p-4 shadow-2xl", panelMotion.className)} style={{ marginLeft: "env(safe-area-inset-left)" }}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h1 className="font-medium">{t(keyboardPanel ? "desktopViewer.keyboard" : "desktopViewer.clipboard")}</h1>
          <button type="button" title={t("desktopViewer.closePanel")} aria-label={t("desktopViewer.closePanel")} onClick={closePanel} className="ui-icon-button shrink-0">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          if (!rfb.current || !connected || !keyboardPanel) return;
          // Explicit text entry works with phone keyboards without reading
          // the device clipboard. Non-Latin text uses Unicode VNC keysyms.
          for (const char of text) {
            const code = char.codePointAt(0)!;
            rfb.current.sendKey(code === 10 ? 0xff0d : code === 9 ? 0xff09 : code <= 255 ? code : 0x01000000 | code, null);
          }
          setText("");
        }}>
          <label className="mb-2 block text-xs leading-relaxed text-ink-secondary" htmlFor={keyboardPanel ? "text" : "clipboard-text"}>{t(keyboardPanel ? "desktopViewer.text" : "desktopViewer.clipboardHint")}</label>
          <textarea id={keyboardPanel ? "text" : "clipboard-text"} className="w-full resize-y rounded-xl border border-hairline bg-inset p-3 text-base text-ink outline-none focus:border-focus" rows={4} maxLength={keyboardPanel ? 4096 : 65536} autoComplete="off" autoCapitalize="off" spellCheck={false} value={keyboardPanel ? text : clipboard} disabled={!keyboardPanel && !connected} onChange={event => {
            const value = event.target.value;
            if (keyboardPanel) setText(value);
            else {
              setClipboard(value);
              if (connected) rfb.current?.clipboardPasteFrom(value);
            }
          }} />
          {keyboardPanel && <button id="send" type="submit" className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-40" disabled={!connected || !text}>
            <Send size={16} aria-hidden="true" />{t("desktopViewer.send")}
          </button>}
        </form>
        {keyboardPanel && <div className="mt-4 grid grid-cols-2 gap-2 border-t border-hairline pt-4">
          <button className={action} disabled={!connected} onClick={() => rfb.current?.sendKey(0xff09, "Tab")}>{t("desktopViewer.keyTab")}</button>
          <button className={action} disabled={!connected} onClick={() => rfb.current?.sendKey(0xff1b, "Escape")}>{t("desktopViewer.keyEscape")}</button>
          <button id="ctrl-alt-del" className={cn(action, "col-span-2")} disabled={!connected} onClick={() => rfb.current?.sendCtrlAltDel()}>{t("desktopViewer.keyCtrlAltDel")}</button>
        </div>}
      </section>}
    </div>
  );
}

function ViewerTool({ id, label, icon: Icon, disabled, active, expanded, onClick }: {
  id?: string; label: string; icon: LucideIcon; disabled?: boolean; active?: boolean; expanded?: boolean; onClick: () => void;
}) {
  return <button id={id} type="button" title={label} aria-label={label} aria-pressed={active} aria-expanded={expanded} disabled={disabled} onClick={onClick} className={cn(
    "ui-icon-button size-11 min-h-11 shrink-0 rounded-xl focus-visible:outline-2 focus-visible:outline-focus",
    active ? "bg-accent/15 text-accent-text hover:bg-accent/25" : "text-ink-secondary hover:bg-raised-hover hover:text-ink",
  )}><Icon size={19} strokeWidth={1.75} aria-hidden="true" /></button>;
}
