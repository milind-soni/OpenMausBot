import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, EllipsisVertical, Globe, Hand, Loader2, Maximize2, Minimize2, Plus, RotateCw, UserRound, X } from "lucide-react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot } from "@/state/store";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { BrowserViewport, type BrowserFrame } from "./BrowserViewport";
import { createBrowserInputQueue } from "@/lib/browser-input-queue";
import { createBrowserControl, type BrowserInteraction, type BrowserTakeStatus } from "@/lib/browser-control";

interface BrowserTab { tabId: string; title: string; url: string; active: boolean }
type ViewerFrame = BrowserFrame & { viewerId: string; generation: number };
const button = "rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";
const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000];

const NO_CONTROL = { held: false, controlling: false, owned: false };

/** Closing a panel releases its lease. A new connection never silently
 * restores permission to type, and never replays old browser frames.
 * There is no Take control button: interacting takes the browser from the
 * bot, and a few idle seconds hand it back (see createBrowserControl). */
export function LiveBrowser({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState<ViewerFrame | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [address, setAddress] = useState("");
  const [connected, setConnected] = useState(false);
  const [control, setControl] = useState({ held: false, controlling: false, owned: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [showProfiles, setShowProfiles] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [takeStatus, setTakeStatus] = useState<BrowserTakeStatus>("");
  const [fullscreen, setFullscreen] = useState(false);
  const viewer = useRef("");
  const generation = useRef(0);
  const pendingOperation = useRef<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const profilesDialog = useRef<HTMLDialogElement>(null);
  const typingDialog = useRef<HTMLDialogElement>(null);
  const inputQueue = useRef<ReturnType<typeof createBrowserInputQueue> | null>(null);
  const browserControl = useRef<ReturnType<typeof createBrowserControl> | null>(null);
  // The latest server control state, for callbacks that outlive a render.
  const controlNow = useRef(NO_CONTROL);
  const haltMessage = useRef("");
  const urlEditing = useRef(false);
  const reconnectCount = useRef(0);
  const connectionProfile = useRef("");
  const profileName = bot.browserProfile === "guest" ? t("browser.profileTemporary")
    : state.config?.browserProfiles?.find((profile) => profile.id === bot.browserProfile)?.name ?? t("browser.profileOwn", { name: bot.name });
  useEffect(() => { if (showProfiles) profilesDialog.current?.showModal(); else profilesDialog.current?.close(); }, [showProfiles]);
  useEffect(() => {
    // Typed text goes to the field the person picked, so keep control while they write it.
    browserControl.current?.hold(showTyping);
    if (showTyping) typingDialog.current?.showModal(); else typingDialog.current?.close();
  }, [showTyping]);

  const action = useCallback(async (body: Record<string, unknown>, expected = viewer.current) => {
    if (!expected) throw new Error(t("browser.errNoConnection"));
    // 120s matches the server's browser requestTimeoutMs: restart replies can
    // be legitimately slow (see the reconnect note in the stream error
    // handler), but a wedged request must surface an error instead of
    // leaving the panel pending forever.
    return api(`/api/bots/${encodeURIComponent(bot.id)}/browser/action`, { method: "POST", body: JSON.stringify({ ...body, viewerId: expected }), timeoutMs: 120_000 });
  }, [bot.id]);
  const interact = useCallback((item: BrowserInteraction) => {
    // Another window's hold is never contested from here; the server refuses it too.
    if (controlNow.current.held && !controlNow.current.owned) return;
    browserControl.current?.interact(item);
  }, []);
  const input = useCallback((body: Record<string, unknown>) => interact({ input: body }), [interact]);
  const command = (body: Record<string, unknown>) => interact({ command: body });
  const reconnect = useCallback(() => {
    // Invalidate synchronously: an old request may finish before React runs
    // the effect cleanup for this reconnect.
    generation.current++;
    reconnectCount.current = 0;
    viewer.current = "";
    inputQueue.current?.clear(); inputQueue.current = null;
    browserControl.current?.close(); browserControl.current = null;
    pendingOperation.current = null;
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const ownsConnection = () => generation.current === current;
    const profile = JSON.stringify([bot.id, bot.browserProfile]);
    if (connectionProfile.current !== profile) {
      connectionProfile.current = profile;
      reconnectCount.current = 0;
    }
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    viewer.current = ""; pendingOperation.current = null; haltMessage.current = "";
    urlEditing.current = false;
    setFrame(null); setTabs([]); setAddress(""); setConnected(false); setError("");
    setControl({ held: false, controlling: false, owned: false }); setPending(false);
    controlNow.current = NO_CONTROL; setTakeStatus("");
    const source = new EventSource(`/api/bots/${encodeURIComponent(bot.id)}/browser/live`);
    const listen = (name: string, handler: (data: any) => void) => source.addEventListener(name, (event) => {
      if (stopped || !ownsConnection()) return;
      try { handler(JSON.parse((event as MessageEvent).data)); } catch { /* Malformed events are not rendered. */ }
    });
    listen("ready", (data) => {
      if (typeof data.viewerId !== "string" || !data.viewerId) return;
      const expected = data.viewerId;
      viewer.current = expected;
      const queue = createBrowserInputQueue(async (body) => {
        if (ownsConnection() && viewer.current === expected) await action(body, expected);
      }, (cause) => {
        if (!ownsConnection() || viewer.current !== expected) return;
        haltMessage.current = cause instanceof Error ? cause.message : String(cause);
        setError(haltMessage.current);
      });
      inputQueue.current = queue;
      browserControl.current = createBrowserControl({
        queue,
        take: () => action({ type: "take" }, expected),
        release: () => action({ type: "release" }, expected),
        command: (body) => execute(body),
        busy: () => pendingOperation.current !== null,
        owned: () => controlNow.current.owned,
        onTakeStatus: setTakeStatus,
        onError: setError,
        onHalted: () => setError(haltMessage.current),
      });
      setConnected(true);
    });
    // A ready event alone is not recovery: a flapping stream can open and
    // fail immediately. Reset the retry budget only after a live heartbeat.
    listen("heartbeat", () => { reconnectCount.current = 0; });
    listen("frame", (data) => { if (viewer.current) setFrame({ ...data, viewerId: viewer.current, generation: current }); });
    listen("tabs", (data) => {
      if (!Array.isArray(data.tabs)) return;
      setTabs(data.tabs);
      const active = data.tabs.find((tab: BrowserTab) => tab.active);
      if (active && !urlEditing.current) setAddress(active.url === "about:blank" ? "" : active.url);
    });
    listen("url", (data) => { if (typeof data.url === "string" && !urlEditing.current) setAddress(data.url === "about:blank" ? "" : data.url); });
    listen("status", (data) => {
      if (data.viewportWidth > 0 && data.viewportHeight > 0) setViewport({ width: data.viewportWidth, height: data.viewportHeight });
    });
    listen("control", (data) => {
      controlNow.current = data;
      setControl(data);
      // Only another window's hold hides the page; this viewer's own take
      // keeps it visible while the bot finishes.
      if (data.held && !data.owned) { setFrame(null); setTabs([]); setAddress(""); }
      browserControl.current?.observe();
    });
    source.addEventListener("error", (event) => {
      // A closed source may still deliver its queued error after a profile
      // switch or reconnect. It must not clear the replacement viewer/input.
      if (stopped || !ownsConnection()) return;
      stopped = true;
      let message = t("browser.connectionEnded");
      let retryable = !(event instanceof MessageEvent);
      if (event instanceof MessageEvent) {
        try {
          const data = JSON.parse(event.data);
          message = data.message || message;
          retryable = data.retryable === true;
        } catch { /* Malformed server errors require explicit reconnect. */ }
      }
      const delay = retryable ? RECONNECT_DELAYS[reconnectCount.current] : undefined;
      if (delay !== undefined) {
        reconnectCount.current++;
        message = t("browser.reconnectingBanner");
        reconnectTimer = setTimeout(() => {
          if (!ownsConnection()) return;
          // Reopen observation only, not browser commands or a human lease.
          generation.current++;
          setAttempt((value) => value + 1);
        }, delay);
      }
      setError(message); setConnected(false); setFrame(null); setControl({ held: false, controlling: false, owned: false });
      controlNow.current = NO_CONTROL; setTakeStatus("");
      // Keep this generation alive: a successful restart closes its stream
      // before the action reply arrives, and must still reconnect afterward.
      viewer.current = ""; inputQueue.current?.clear(); inputQueue.current = null;
      browserControl.current?.close(); browserControl.current = null; source.close();
    });
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (ownsConnection()) {
        // Closing the panel hands control back before the connection ends;
        // held or unsent input is left to the server's disconnect cleanup.
        browserControl.current?.leave();
        browserControl.current?.close(); browserControl.current = null;
        generation.current++; viewer.current = ""; pendingOperation.current = null;
        inputQueue.current?.clear(); inputQueue.current = null;
      }
      source.close();
    };
  }, [bot.id, bot.browserProfile, attempt, action]);

  // On macOS a full-screen element takes the whole window into native full
  // screen, where minimize is disabled. The button has to lead back out, and
  // it follows the document so Esc, the green button and View > Toggle Full
  // Screen keep it honest too (MOCA-266).
  useEffect(() => {
    const update = () => setFullscreen(Boolean(panel.current) && document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleFullscreen = () => {
    const leaving = Boolean(panel.current) && document.fullscreenElement === panel.current;
    const request = leaving ? document.exitFullscreen() : panel.current?.requestFullscreen();
    void request?.catch(() => setError(leaving ? t("browser.errLeaveFullscreen") : t("browser.errFullscreenUnavailable")));
  };

  const execute = async (body: Record<string, unknown>) => {
    if (pendingOperation.current !== null) return;
    const expected = viewer.current;
    const current = generation.current;
    const queue = inputQueue.current;
    pendingOperation.current = current;
    setPending(true); setError("");
    try {
      await queue?.drain();
      if (generation.current !== current || viewer.current !== expected) return;
      await action(body, expected);
      // A halted queue silently drops input; restore the banner the
      // setError("") above cleared so the view does not look interactive.
      if (inputQueue.current?.stopped() && generation.current === current) setError(haltMessage.current);
      if (generation.current === current && body.type === "restart") reconnect();
    }
    catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      if (generation.current === current && pendingOperation.current === current) {
        pendingOperation.current = null; setPending(false);
      }
    }
  };
  // Usable whenever connected and no other window holds the browser: the
  // first real interaction takes control from the bot by itself.
  const heldElsewhere = control.held && !control.owned;
  const interactive = connected && !heldElsewhere && !pending;
  // The dialog pins a lease; it cannot acquire one or freeze the field the
  // person picked. Click that page field first, before writing in the dialog.
  const typingReady = interactive && control.owned && control.controlling;
  // Toolbar actions wait out a take as they wait out a running action, so a
  // repeated click cannot pile up behind it. Page input still buffers.
  const taking = takeStatus === "pending" || takeStatus === "slow";
  const commandsReady = interactive && !taking;
  const reconnecting = error === t("browser.reconnectingBanner");
  const pill = "flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border bg-menu px-2.5 py-1 text-[11px] shadow-sm sm:text-[12px]";
  return <div ref={panel} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-card text-ink">
    <div className="flex min-h-12 items-center gap-1 px-2 pt-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.length ? tabs.map((tab) => <div key={tab.tabId} className={`flex max-w-52 shrink-0 items-center gap-1 rounded-xl px-1 text-[12px] ${tab.active ? "bg-inset text-ink" : "text-ink-secondary"}`}>
          <Globe size={13} className="ml-1.5 shrink-0 opacity-60" />
          <button className="truncate px-1 py-2 text-left disabled:cursor-default" disabled={!commandsReady} onClick={() => command({ type: "tab-select", tabId: tab.tabId })} title={tab.title || tab.url}>{tab.title || t("browser.newTab")}</button>
          <button className={button} aria-label={t("browser.closeTab", { name: tab.title || t("browser.tabWord") })} disabled={!commandsReady} onClick={() => command({ type: "tab-close", tabId: tab.tabId })}><X size={13} /></button>
        </div>) : <div className="flex items-center gap-2 rounded-xl bg-inset px-3 py-2 text-[12px] text-ink-secondary"><Globe size={13} />{t("browser.newTab")}</div>}
        <button className={`${button} shrink-0`} disabled={!commandsReady} aria-label={t("browser.newTab")} title={t("browser.newTab")} onClick={() => command({ type: "tab-new" })}><Plus size={17} /></button>
      </div>
      <button className={button} title={fullscreen ? t("browser.exitFullscreen") : t("browser.fullscreen")} aria-label={fullscreen ? t("browser.exitFullscreen") : t("browser.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      {/* Profiles can't switch while this window holds the browser: opening them hands it back now, not after the idle wait. */}
      <button className={`${button} rounded-xl bg-inset p-2`} title={t("browser.profileTitle", { name: profileName })} aria-label={t("browser.profilesAria")} aria-expanded={showProfiles} onClick={() => { browserControl.current?.handBack(); setShowProfiles(true); }}><UserRound size={16} /></button>
    </div>
    <form className="flex h-12 items-center gap-1 border-b border-hairline/40 px-2" onSubmit={(e) => { e.preventDefault(); if (commandsReady && address.trim()) command({ type: "navigate", url: /^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}` }); }}>
      <div className="flex shrink-0 items-center">
        <button type="button" className={button} disabled={!commandsReady} aria-label={t("browser.back")} onClick={() => command({ type: "back" })}><ArrowLeft size={17} /></button>
        <button type="button" className={button} disabled={!commandsReady} aria-label={t("browser.forward")} onClick={() => command({ type: "forward" })}><ArrowRight size={17} /></button>
        <button type="button" className={button} disabled={!commandsReady} aria-label={t("browser.reload")} onClick={() => command({ type: "reload" })}><RotateCw size={17} /></button>
      </div>
      <input ref={addressInput} aria-label={t("browser.addressAria")} readOnly={!commandsReady} value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => { urlEditing.current = true; if (commandsReady) e.target.select(); }} onBlur={() => { urlEditing.current = false; }} placeholder={connected ? "about:blank" : t("browser.connecting")} spellCheck={false} className="mx-1 min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1.5 text-center text-[12px] outline-none placeholder:text-ink-secondary focus:bg-inset focus:text-left" />
      <details className="relative shrink-0">
        <summary className={`${button} list-none cursor-pointer [&::-webkit-details-marker]:hidden`} aria-label={t("browser.menu")} title={t("browser.menu")}><EllipsisVertical size={17} /></summary>
        <div className="absolute right-0 top-full z-20 mt-2 flex w-44 flex-col rounded-xl border border-hairline/50 bg-card p-1.5 text-[12px] shadow-xl">
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!typingReady} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setShowTyping(true); }}>{t("browser.typeOrPaste")}</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); reconnect(); }}>{t("browser.reconnectView")}</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!connected || pending || taking} onClick={(e) => {
            e.currentTarget.closest("details")?.removeAttribute("open");
            if (!window.confirm(t("browser.restartConfirm"))) return;
            void execute({ type: "restart" });
          }}>{t("browser.restartBrowser")}</button>
        </div>
      </details>
    </form>
    {error && <div role={reconnecting ? "status" : "alert"} className={`flex items-center justify-between gap-2 border-b border-hairline/30 px-3 py-2 text-[12px] ${reconnecting ? "text-ink-secondary" : "text-danger"}`}><span>{error}</span>{!connected && <button className="shrink-0 underline" onClick={reconnect}>{t("browser.reconnect")}</button>}</div>}
    <div className="relative min-h-0 flex-1 overflow-hidden bg-inset/40">
      {frame ? <BrowserViewport frame={frame} {...viewport} driving={interactive} input={input}
        onReturnToToolbar={() => addressInput.current?.focus()}
        acknowledge={(seq) => { if (generation.current === frame.generation && viewer.current === frame.viewerId) void action({ type: "ack", seq }, frame.viewerId).catch(() => {}); }}
        onDecodeError={() => { if (generation.current === frame.generation && viewer.current === frame.viewerId) setError(t("browser.frameDecodeError")); }} />
        : <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-ink-secondary">{connected && heldElsewhere ? <Hand size={24} /> : error && !reconnecting ? <Globe size={24} /> : <Loader2 size={24} className="animate-spin" />}<span>{heldElsewhere ? t("browser.pausedForHuman") : reconnecting ? t("browser.reconnecting") : error ? t("browser.disconnected") : t("browser.openingLive")}</span></div>}
      {/* Status only, never a control: it floats over the top of the page,
          readable at any panel width, and every click passes through it. */}
      <div role="status" className="pointer-events-none absolute inset-x-0 top-2 flex justify-center px-3">
        {takeStatus === "slow" ? <span className={`${pill} border-hairline text-ink-secondary`}>
          <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" /><span className="truncate">{t("browser.control.waiting", { name: bot.name })}</span>
        </span> : takeStatus === "stale" ? <span className={`${pill} border-accent-border text-accent-text`}>
          <Hand size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{t("browser.control.stale", { name: bot.name })}</span>
        </span> : !takeStatus && control.owned && control.controlling ? <span className={`${pill} border-accent-border text-accent-text`} aria-description={t("browser.control.yoursHint", { name: bot.name })}>
          <Hand size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{t("browser.control.yours")}</span>
        </span> : null}
      </div>
    </div>
    <dialog ref={profilesDialog} onClose={() => setShowProfiles(false)} onClick={(e) => { if (e.target === e.currentTarget) setShowProfiles(false); }} className="m-auto w-[min(420px,calc(100%-32px))] max-h-[80vh] overflow-auto rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-[15px] font-medium">{t("browser.profilesTitle")}</h2><button className={button} aria-label={t("browser.closeProfiles")} onClick={() => setShowProfiles(false)}><X size={16} /></button></div>
      {/* Opening this hands an idle hold back at once; say why the switcher waits otherwise. */}
      {(heldElsewhere || (control.owned && (pending || taking))) && <p className="mb-3 text-[12px] text-ink-secondary">{t(heldElsewhere ? "browser.profiles.heldElsewhere" : "browser.profiles.busy")}</p>}
      <BrowserProfilesManager bot={bot} disabled={pending || control.held} onProfileChanged={() => { setShowProfiles(false); reconnect(); }} />
    </dialog>
    <dialog ref={typingDialog} onClose={() => setShowTyping(false)} className="m-auto w-[min(420px,calc(100%-32px))] rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[14px] font-medium">{t("browser.typingTitle")}</h2><button className={button} aria-label={t("browser.closeTyping")} onClick={() => setShowTyping(false)}><X size={16} /></button></div>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault(); const field = e.currentTarget.elements.namedItem("pageText") as HTMLInputElement;
      if (typingReady && field.value) { input({ type: "input_keyboard", eventType: "char", text: field.value }); field.value = ""; setShowTyping(false); }
    }}><input name="pageText" aria-label={t("browser.textForPage")} autoComplete="off" maxLength={4096} placeholder={t("browser.typeOrPasteText")} className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" /><button disabled={!typingReady} className="self-end rounded-lg bg-accent px-4 py-2 text-[12px] text-accent-ink disabled:opacity-40">{t("browser.type")}</button></form>
    </dialog>
  </div>;
}

export function BrowserPanel({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const engine = state.config?.browserEngine;
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => { let active = true; void api("/api/auth/session").then((session) => { if (active) setAdmin(session.scopes.includes("admin")); }).catch(() => { if (active) setAdmin(false); }); return () => { active = false; }; }, []);
  const installing = requested || engine?.installing === true;
  const install = async () => {
    setError(null); setRequested(true);
    try { await api("/api/browser-engine/install", { method: "POST" }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRequested(false); }
  };
  if (admin === false) return <div className="p-5 text-[13px] text-ink-secondary">{t("browser.adminOnly")}</div>;
  if (bot.browser === false) return <div className="p-5 text-[13px] text-ink-secondary">{t("browser.enableInProfile")}</div>;
  if (engine?.kind === "engine" && !installing && !engine.installError) return admin === null
    ? <div className="p-5 text-[13px] text-ink-secondary">{t("browser.loading")}</div>
    : <LiveBrowser key={bot.id} bot={bot} />;
  return <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 rounded-xl bg-card p-5">
    <div className="text-[15px] font-medium text-ink">{engine?.kind === "engine" ? t("browser.installIncomplete") : t("browser.engineNotInstalled")}</div>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{engine?.kind === "engine" ? t("browser.installIncompleteHint") : browserUnavailableReason(state.config)}</p>
    {engine?.installable || engine?.kind === "engine" ? <button type="button" onClick={() => void install()} disabled={installing || admin !== true} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-60">{installing ? t("browser.installing") : engine?.kind === "engine" ? t("browser.retryInstall") : t("browser.installEngine")}</button> : null}
    {(engine?.installError || error) && <p role="alert" className="text-[12px] text-danger">{error ?? engine?.installError}</p>}
  </div>;
}
