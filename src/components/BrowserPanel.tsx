import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, EllipsisVertical, Globe, Hand, Loader2, LockKeyhole, Maximize2, Minimize2, Plus, RotateCw, UserRound, X } from "lucide-react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot } from "@/state/store";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { BrowserViewport, type BrowserFrame } from "./BrowserViewport";
import { createBrowserInputQueue } from "@/lib/browser-input-queue";
import { createBrowserControl, type BrowserInteraction, type BrowserTakeStatus } from "@/lib/browser-control";
import { resolveAddressBarInput } from "@/lib/browser-address";
import { BROWSER_HELD_ELSEWHERE } from "../../shared/browser-held";

interface BrowserTab { tabId: string; title: string; url: string; active: boolean }
type ViewerFrame = BrowserFrame & { viewerId: string; generation: number };
const button = "rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";
const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000];
const RECONNECT_MESSAGE = "Connection interrupted. Reconnecting the browser view…";
// The server sends a heartbeat every 10 s: a view that heard nothing for longer lost its stream without an error.
const SILENT_MS = 25_000;
const SILENCE_CHECK_MS = 5_000;

const NO_CONTROL = { held: false, controlling: false, owned: false };

export type BrowserSignIn = { url: string; site: string; nonce: number };

/** Security: a new connection never silently restores permission to type and never replays old frames or input. Only the
 * server returns a hold, and only to this panel's reconnect after its own stream dropped. */
export function LiveBrowser({ bot, signIn }: { bot: Bot; signIn?: BrowserSignIn }) {
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
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState(false);
  const [masked, setMasked] = useState(false);
  const viewer = useRef("");
  const generation = useRef(0);
  const pendingOperation = useRef<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const profilesDialog = useRef<HTMLDialogElement>(null);
  const typingDialog = useRef<HTMLDialogElement>(null);
  const inputQueue = useRef<ReturnType<typeof createBrowserInputQueue> | null>(null);
  const browserControl = useRef<ReturnType<typeof createBrowserControl> | null>(null);
  const controlNow = useRef(NO_CONTROL);
  const haltMessage = useRef("");
  const urlEditing = useRef(false);
  const reconnectCount = useRef(0);
  const connectionProfile = useRef("");
  const resumeFrom = useRef("");
  const wake = useRef<((focused: boolean) => void) | null>(null);
  const keepNow = useRef(false);
  const signInHandled = useRef(0);
  const signInPage = useRef<string | null>(null);
  const pageNow = useRef<string | null>(null);
  const signInOpen = state.computerControl?.[bot.id]?.help?.place === "browser";
  keepNow.current = kept || signInOpen;
  const profileName = bot.browserProfile === "guest" ? "Temporary browser"
    : state.config?.browserProfiles?.find((profile) => profile.id === bot.browserProfile)?.name ?? `${bot.name}’s own browser`;
  useEffect(() => { if (showProfiles) profilesDialog.current?.showModal(); else profilesDialog.current?.close(); }, [showProfiles]);
  useEffect(() => {
    browserControl.current?.hold(showTyping);
    if (showTyping) typingDialog.current?.showModal(); else typingDialog.current?.close();
  }, [showTyping]);

  const action = useCallback(async (body: Record<string, unknown>, expected = viewer.current) => {
    if (!expected) throw new Error("Open the browser connection first.");
    // 120s matches the server's browser requestTimeoutMs.
    return api(`/api/bots/${encodeURIComponent(bot.id)}/browser/action`, { method: "POST", body: JSON.stringify({ ...body, viewerId: expected }), timeoutMs: 120_000 });
  }, [bot.id]);
  const interact = useCallback((item: BrowserInteraction) => {
    if (controlNow.current.held && !controlNow.current.owned) { setError(BROWSER_HELD_ELSEWHERE); return; }
    browserControl.current?.interact(item);
  }, []);
  const input = useCallback((body: Record<string, unknown>) => interact({ input: body }), [interact]);
  const command = (body: Record<string, unknown>) => interact({ command: body });
  const reconnect = useCallback(() => {
    // Invalidate synchronously: an old request may finish before React runs this reconnect's effect cleanup.
    generation.current++;
    reconnectCount.current = 0;
    resumeFrom.current = viewer.current || resumeFrom.current;
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
      resumeFrom.current = "";
    }
    let stopped = false;
    let revivable = false;
    let heardAt = Date.now();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    viewer.current = ""; pendingOperation.current = null; haltMessage.current = "";
    urlEditing.current = false; pageNow.current = null;
    setFrame(null); setTabs([]); setAddress(""); setConnected(false); setError(""); setBusy(false);
    setControl({ held: false, controlling: false, owned: false }); setPending(false);
    controlNow.current = NO_CONTROL; setTakeStatus("");
    // The view this panel had when its stream dropped: the server returns its hold to this reconnect only.
    const resume = resumeFrom.current ? `?resume=${encodeURIComponent(resumeFrom.current)}` : "";
    const source = new EventSource(`/api/bots/${encodeURIComponent(bot.id)}/browser/live${resume}`);
    const listen = (name: string, handler: (data: any) => void) => source.addEventListener(name, (event) => {
      if (stopped || !ownsConnection()) return;
      heardAt = Date.now();
      try { handler(JSON.parse((event as MessageEvent).data)); } catch {}
    });
    const dropped = (message: string, retryable: boolean) => {
      stopped = true;
      revivable = retryable;
      const delay = retryable ? RECONNECT_DELAYS[reconnectCount.current] : undefined;
      if (delay !== undefined) {
        reconnectCount.current++;
        message = RECONNECT_MESSAGE;
        reconnectTimer = setTimeout(() => {
          if (!ownsConnection()) return;
          generation.current++;
          setAttempt((value) => value + 1);
        }, delay);
      }
      setError(message); setBusy(false); setConnected(false); setFrame(null); setControl({ held: false, controlling: false, owned: false });
      controlNow.current = NO_CONTROL; setTakeStatus("");
      // Keep this generation alive: a successful restart closes its stream before the action reply arrives and must
      // still reconnect.
      resumeFrom.current = viewer.current || resumeFrom.current;
      viewer.current = ""; inputQueue.current?.clear(); inputQueue.current = null;
      browserControl.current?.close(); browserControl.current = null; source.close();
    };
    // A 404 from an action: the server closed this view, so input must go to a new one rather than halt here.
    const viewGone = (cause: unknown, expected: string) => {
      if ((cause as { status?: unknown } | null)?.status !== 404 || stopped || !ownsConnection() || viewer.current !== expected) return false;
      dropped(RECONNECT_MESSAGE, true);
      return true;
    };
    wake.current = (focused) => {
      if (!ownsConnection()) return;
      if (!stopped && viewer.current && Date.now() - heardAt > SILENT_MS) dropped(RECONNECT_MESSAGE, true);
      if (!stopped || !focused || !revivable) return;
      // Back at the window: retry now, whether a retry was waiting or they had run out.
      clearTimeout(reconnectTimer);
      reconnectCount.current = 0;
      generation.current++;
      setAttempt((value) => value + 1);
    };
    listen("waiting", () => { if (!viewer.current) setBusy(true); });
    listen("ready", (data) => {
      if (typeof data.viewerId !== "string" || !data.viewerId) return;
      setBusy(false);
      const expected = data.viewerId;
      viewer.current = expected;
      resumeFrom.current = "";
      const queue = createBrowserInputQueue(async (body) => {
        if (ownsConnection() && viewer.current === expected) await action(body, expected);
      }, (cause) => {
        if (!ownsConnection() || viewer.current !== expected || viewGone(cause, expected)) return;
        haltMessage.current = cause instanceof Error ? cause.message : String(cause);
        setError(haltMessage.current);
      });
      inputQueue.current = queue;
      const gone = (cause: unknown) => { viewGone(cause, expected); throw cause; };
      browserControl.current = createBrowserControl({
        queue,
        take: () => action({ type: "take" }, expected).catch(gone),
        release: () => action({ type: "release" }, expected).catch(gone),
        command: (body) => execute(body),
        busy: () => pendingOperation.current !== null,
        owned: () => controlNow.current.owned,
        onTakeStatus: setTakeStatus,
        onError: setError,
        onHalted: () => setError(haltMessage.current),
      });
      browserControl.current.keep(keepNow.current);
      setConnected(true);
    });
    listen("heartbeat", () => { reconnectCount.current = 0; });
    listen("frame", (data) => { if (viewer.current) setFrame({ ...data, viewerId: viewer.current, generation: current }); });
    listen("tabs", (data) => {
      if (!Array.isArray(data.tabs)) return;
      setTabs(data.tabs);
      const active = data.tabs.find((tab: BrowserTab) => tab.active);
      if (active && !urlEditing.current) setAddress(active.url === "about:blank" ? "" : active.url);
      if (active) { pageNow.current = active.url; openSignInPage(); }
    });
    listen("url", (data) => {
      if (typeof data.url !== "string") return;
      if (!urlEditing.current) setAddress(data.url === "about:blank" ? "" : data.url);
      pageNow.current = data.url; openSignInPage();
    });
    listen("status", (data) => {
      if (data.viewportWidth > 0 && data.viewportHeight > 0) setViewport({ width: data.viewportWidth, height: data.viewportHeight });
    });
    listen("control", (data) => {
      if (controlNow.current.owned && !data.owned) setKept(false);
      controlNow.current = data;
      setControl(data);
      if (data.held && !data.owned) { setFrame(null); setTabs([]); setAddress(""); }
      browserControl.current?.observe();
    });
    source.addEventListener("error", (event) => {
      // A closed EventSource may still deliver a queued error; it must not clear the replacement viewer or input.
      if (stopped || !ownsConnection()) return;
      let message = "Browser connection ended. Reconnect to continue watching.";
      let retryable = !(event instanceof MessageEvent);
      if (event instanceof MessageEvent) {
        try {
          const data = JSON.parse(event.data);
          message = data.message || message;
          retryable = data.retryable === true;
        } catch {}
      }
      dropped(message, retryable);
    });
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (ownsConnection()) {
        browserControl.current?.leave();
        browserControl.current?.close(); browserControl.current = null;
        generation.current++; viewer.current = ""; pendingOperation.current = null;
        inputQueue.current?.clear(); inputQueue.current = null;
      }
      source.close();
    };
  }, [bot.id, bot.browserProfile, attempt, action]);

  // On macOS a full-screen element takes the window into native full screen, where minimize is disabled.
  useEffect(() => {
    const update = () => setFullscreen(Boolean(panel.current) && document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => { browserControl.current?.keep(kept || signInOpen); }, [kept, signInOpen]);
  const takeControl = () => { setKept(true); browserControl.current?.keep(true); browserControl.current?.takeControl(); };
  const handBack = () => { setKept(false); browserControl.current?.handBack(); };
  useEffect(() => {
    if (!signIn || !connected || signInHandled.current === signIn.nonce) return;
    signInHandled.current = signIn.nonce;
    signInPage.current = signIn.url;
    takeControl();
    openSignInPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn, connected]);
  // Switching apps, sleep or a network change can drop the stream unnoticed or outlast the retries: check again on return.
  useEffect(() => {
    const returned = () => { if (document.visibilityState !== "hidden") wake.current?.(true); };
    const check = setInterval(() => wake.current?.(false), SILENCE_CHECK_MS);
    window.addEventListener("focus", returned);
    window.addEventListener("online", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      clearInterval(check);
      window.removeEventListener("focus", returned);
      window.removeEventListener("online", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, []);
  function openSignInPage() {
    const url = signInPage.current;
    if (!url || pageNow.current === null) return;
    signInPage.current = null;
    if (!pageNow.current || pageNow.current === "about:blank") interact({ command: { type: "navigate", url } });
  }

  const toggleFullscreen = () => {
    const leaving = Boolean(panel.current) && document.fullscreenElement === panel.current;
    const request = leaving ? document.exitFullscreen() : panel.current?.requestFullscreen();
    void request?.catch(() => setError(leaving ? "Could not leave full screen. Press Esc instead." : "Full screen is unavailable in this browser."));
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
      // The engine's tabs event may trail the reply; drop the closed tab now so its stale entry cannot offer Close on the last one.
      if (body.type === "tab-close" && generation.current === current && viewer.current === expected) {
        setTabs((tabs) => tabs.filter((tab) => tab.tabId !== body.tabId));
      }
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
  const heldElsewhere = control.held && !control.owned;
  const interactive = connected && !heldElsewhere && !pending;
  const typingReady = interactive && control.owned && control.controlling;
  const taking = takeStatus === "pending" || takeStatus === "slow";
  const commandsReady = interactive && !taking;
  const reconnecting = error === RECONNECT_MESSAGE;
  const pill = "flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border bg-menu px-2.5 py-1 text-[11px] shadow-sm sm:text-[12px]";
  return <div ref={panel} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-card text-ink">
    <div className="flex min-h-12 items-center gap-1 px-2 pt-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.length ? tabs.map((tab) => <div key={tab.tabId} className={`flex max-w-52 shrink-0 items-center gap-1 rounded-xl px-1 text-[12px] ${tab.active ? "bg-inset text-ink" : "text-ink-secondary"}`}>
          <Globe size={13} className="ml-1.5 shrink-0 opacity-60" />
          <button className="truncate px-1 py-2 text-left disabled:cursor-default" disabled={!commandsReady} onClick={() => command({ type: "tab-select", tabId: tab.tabId })} title={tab.title || tab.url}>{tab.title || "New tab"}</button>
          {/* agent-browser refuses to close the last tab, so only offer Close while another tab would remain. */}
          {tabs.length > 1 && <button className={button} aria-label={`Close ${tab.title || "tab"}`} disabled={!commandsReady} onClick={() => command({ type: "tab-close", tabId: tab.tabId })}><X size={13} /></button>}
        </div>) : <div className="flex items-center gap-2 rounded-xl bg-inset px-3 py-2 text-[12px] text-ink-secondary"><Globe size={13} />New tab</div>}
        <button className={`${button} shrink-0`} disabled={!commandsReady} aria-label="New tab" title="New tab" onClick={() => command({ type: "tab-new" })}><Plus size={17} /></button>
      </div>
      <button type="button" className={`${button} flex shrink-0 items-center gap-1 px-2 text-[12px] ${control.owned ? "bg-accent/15 text-accent-text" : ""}`}
        aria-pressed={control.owned} disabled={!connected || heldElsewhere || pending || (taking && !control.owned)}
        onClick={control.owned ? handBack : takeControl}>
        <Hand size={15} />{control.owned ? t("browser.control.handBack") : t("browser.control.take")}
      </button>
      <button className={button} title={fullscreen ? "Exit full screen" : "Full screen"} aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      <button className={`${button} rounded-xl bg-inset p-2`} title={`Browser profile: ${profileName}`} aria-label="Browser profiles" aria-expanded={showProfiles} onClick={() => { browserControl.current?.handBack(); setShowProfiles(true); }}><UserRound size={16} /></button>
    </div>
    <form className="flex h-12 items-center gap-1 border-b border-hairline/40 px-2" onSubmit={(e) => { e.preventDefault(); const url = resolveAddressBarInput(address); if (commandsReady && url) command({ type: "navigate", url }); else if (address.trim()) setError("Enter a web address or something to search for."); }}>
      <div className="flex shrink-0 items-center">
        <button type="button" className={button} disabled={!commandsReady} aria-label="Back" onClick={() => command({ type: "back" })}><ArrowLeft size={17} /></button>
        <button type="button" className={button} disabled={!commandsReady} aria-label="Forward" onClick={() => command({ type: "forward" })}><ArrowRight size={17} /></button>
        <button type="button" className={button} disabled={!commandsReady} aria-label="Reload page" onClick={() => command({ type: "reload" })}><RotateCw size={17} /></button>
      </div>
      <input ref={addressInput} aria-label="Browser address" readOnly={!commandsReady} value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => { urlEditing.current = true; if (commandsReady) e.target.select(); }} onBlur={() => { urlEditing.current = false; }} placeholder={connected ? "about:blank" : "Connecting…"} spellCheck={false} className="mx-1 min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1.5 text-center text-[12px] outline-none placeholder:text-ink-secondary focus:bg-inset focus:text-left" />
      <details className="relative shrink-0">
        <summary className={`${button} list-none cursor-pointer [&::-webkit-details-marker]:hidden`} aria-label="Browser menu" title="Browser menu"><EllipsisVertical size={17} /></summary>
        <div className="absolute right-0 top-full z-20 mt-2 flex w-44 flex-col rounded-xl border border-hairline/50 bg-card p-1.5 text-[12px] shadow-xl">
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!typingReady} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setMasked(false); setShowTyping(true); }}>Type or paste text…</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!typingReady} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setMasked(true); setShowTyping(true); }}>{t("browser.typeSecret")}</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); reconnect(); }}>Reconnect view</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!connected || pending || taking} onClick={(e) => {
            e.currentTarget.closest("details")?.removeAttribute("open");
            if (!window.confirm("Restart this profile’s browser? Open tabs will close. Saved logins are kept. Stop any bots using it first.")) return;
            void execute({ type: "restart" });
          }}>Restart browser…</button>
        </div>
      </details>
    </form>
    {error && <div role={reconnecting ? "status" : "alert"} className={`flex items-center justify-between gap-2 border-b border-hairline/30 px-3 py-2 text-[12px] ${reconnecting ? "text-ink-secondary" : "text-danger"}`}><span>{error}</span>{!connected && <button className="shrink-0 underline" onClick={reconnect}>Reconnect</button>}</div>}
    <div className="relative min-h-0 flex-1 overflow-hidden bg-inset/40">
      {frame ? <BrowserViewport frame={frame} {...viewport} driving={interactive} input={input}
        onReturnToToolbar={() => addressInput.current?.focus()}
        acknowledge={(seq) => { if (generation.current === frame.generation && viewer.current === frame.viewerId) void action({ type: "ack", seq }, frame.viewerId).catch(() => {}); }}
        onDecodeError={() => { if (generation.current === frame.generation && viewer.current === frame.viewerId) setError("A browser frame could not be decoded. Close and reopen the panel to reconnect."); }} />
        : <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-ink-secondary">{connected && heldElsewhere ? <Hand size={24} /> : error && !reconnecting ? <Globe size={24} /> : <Loader2 size={24} className="animate-spin" />}<span>{heldElsewhere ? BROWSER_HELD_ELSEWHERE : reconnecting ? "Reconnecting…" : error ? "Browser disconnected" : busy ? t("browser.live.botBusy", { name: bot.name }) : "Opening the live browser…"}</span></div>}
      <div role="status" className="pointer-events-none absolute inset-x-0 top-2 flex justify-center px-3">
        {takeStatus === "slow" ? <span className={`${pill} border-hairline text-ink-secondary`}>
          <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" /><span className="truncate">{t("browser.control.waiting", { name: bot.name })}</span>
        </span> : takeStatus === "stale" ? <span className={`${pill} border-accent-border text-accent-text`}>
          <Hand size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{t("browser.control.stale", { name: bot.name })}</span>
        </span> : !takeStatus && control.owned && control.controlling ? <span className={`${pill} border-accent-border text-accent-text`} aria-description={t(kept || signInOpen ? "browser.control.keptHint" : "browser.control.yoursHint", { name: bot.name })}>
          <Hand size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{t("browser.control.yours")}</span>
        </span> : null}
      </div>
    </div>
    <dialog ref={profilesDialog} onClose={() => setShowProfiles(false)} onClick={(e) => { if (e.target === e.currentTarget) setShowProfiles(false); }} className="m-auto w-[min(420px,calc(100%-32px))] max-h-[80vh] overflow-auto rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-[15px] font-medium">Browser profiles</h2><button className={button} aria-label="Close browser profiles" onClick={() => setShowProfiles(false)}><X size={16} /></button></div>
      {(heldElsewhere || (control.owned && (pending || taking))) && <p className="mb-3 text-[12px] text-ink-secondary">{t(heldElsewhere ? "browser.profiles.heldElsewhere" : "browser.profiles.busy")}</p>}
      <BrowserProfilesManager bot={bot} disabled={pending || control.held} onProfileChanged={() => { setShowProfiles(false); reconnect(); }} />
    </dialog>
    {/* Security: a password or code typed here goes only to the page's focused field; it is never held in state, logged or shown. */}
    <dialog ref={typingDialog} onClose={() => { const field = typingDialog.current?.querySelector("input"); if (field) field.value = ""; setShowTyping(false); }} className="m-auto w-[min(420px,calc(100%-32px))] rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[14px] font-medium">{masked ? t("browser.typeSecret.title") : "Type into the selected page field"}</h2><button className={button} aria-label="Close typing" onClick={() => setShowTyping(false)}><X size={16} /></button></div>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault(); const field = e.currentTarget.elements.namedItem("pageText") as HTMLInputElement;
      if (typingReady && field.value) { input({ type: "input_keyboard", eventType: "char", text: field.value }); field.value = ""; setShowTyping(false); }
    }}><input key={masked ? "secret" : "text"} name="pageText" type={masked ? "password" : "text"} aria-label={masked ? t("browser.typeSecret.field") : "Text for the page"} autoComplete={masked ? "new-password" : "off"} spellCheck={false} maxLength={4096} placeholder={masked ? "••••••••" : "Type or paste text"} className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" />
      {masked && <p className="flex items-center gap-1 text-[11.5px] text-ink-tertiary"><LockKeyhole size={11} aria-hidden="true" />{t("browser.typeSecret.note")}</p>}
      <button disabled={!typingReady} className="self-end rounded-lg bg-accent px-4 py-2 text-[12px] text-accent-ink disabled:opacity-40">Type</button></form>
    </dialog>
  </div>;
}

export function BrowserPanel({ bot, signIn }: { bot: Bot; signIn?: BrowserSignIn }) {
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
  if (bot.browser === false) return <div className="p-5 text-[13px] text-ink-secondary">Enable the browser in this bot’s profile to use it.</div>;
  if (engine?.kind === "engine" && !installing && !engine.installError) return <LiveBrowser key={bot.id} bot={bot} signIn={signIn} />;
  return <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 rounded-xl bg-card p-5">
    <div className="text-[15px] font-medium text-ink">{engine?.kind === "engine" ? "Browser installation incomplete" : "Browser engine not installed"}</div>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{engine?.kind === "engine" ? "agent-browser is installed, but Chrome setup has not finished. Retry the browser installation." : browserUnavailableReason(state.config)}</p>
    {engine?.installable || engine?.kind === "engine" ? <button type="button" onClick={() => void install()} disabled={installing || admin !== true} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-60">{installing ? "Installing… (a one-time download of about 160 MB)" : engine?.kind === "engine" ? "Retry browser installation" : "Install the browser engine"}</button> : null}
    {(engine?.installError || error) && <p role="alert" className="text-[12px] text-danger">{error ?? engine?.installError}</p>}
  </div>;
}
