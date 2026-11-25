import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Globe, Hand, Loader2, LockKeyhole, Moon, X } from "lucide-react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, useStore, type Bot } from "@/state/store";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { ChromeRow, type BrowserNav, type BrowserTab } from "./browser/ChromeRow";
import { ExtensionsMenu, extensionsOf, type BrowserExtension } from "./browser/ExtensionsMenu";
import { MoreMenu } from "./browser/MoreMenu";
import { PasskeyNotice } from "./browser/PasskeyNotice";
import { StreamSurface, type StreamSurfaceHandle, type SurfaceConnect } from "./browser/StreamSurface";
import { BrowserViewerPill, usePaneHold } from "./viewer-pill-host";
import { createBrowserControl, startsInteraction, streamTransport, type BrowserControl, type BrowserTakeStatus } from "@/lib/browser-control";
import { resolveAddressBarInput } from "@/lib/browser-address";
import { closeBrowserPictureInPicture, openBrowserPictureInPicture, supportsBrowserPictureInPicture, useBrowserPictureInPicture } from "@/lib/browser-pip";
import { browserStreamAccess, createPreviewStreamClient, type PreviewStreamClient, type PreviewStreamControl, type PreviewStreamInput, type PreviewViewportSetting } from "@/lib/browser-stream-client";
import { createLiveStreamClient, type LiveResume, type LiveStreamClient } from "@/lib/browser-stream-v1";
import { BROWSER_HELD_ELSEWHERE } from "../../shared/browser-held";
import { passkeyWallAt } from "../../shared/passkey-wall";
import { browserScope, withBrowserScope } from "@/lib/team-browser";
import { followBounds } from "@/lib/follow-bounds";
import { useNativeViewObscured } from "@/lib/native-view-obscured";
import { CookieImportDialog, cookieImportAvailable, siteOfAddress } from "./browser/cookie-import";

const BrowserDesktop = lazy(() => import("./browser/BrowserDesktop").then((module) => ({ default: module.BrowserDesktop })));

const button = "rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";
const TAKE_TRIES = 3;
const TAKE_RETRY_MS = 800;
const NO_NAV: BrowserNav = { url: "", loading: false, canGoBack: false, canGoForward: false };

/** `expand`: open the browser full size, as a handoff's Take over does. */
export type BrowserSignIn = { url: string; site: string; nonce: number; expand?: boolean };
/** A page to open in a new tab once the view is connected and awake: a published page's Open (usePageOpener). */
export type BrowserPage = { url: string; nonce: number };

function tabsOf(value: unknown): BrowserTab[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tab) => tab && typeof tab === "object" && typeof tab.tabId === "string"
    ? [{ tabId: tab.tabId, title: typeof tab.title === "string" ? tab.title : "", url: typeof tab.url === "string" ? tab.url : "", active: tab.active === true }]
    : []);
}

/**
 * A bot's browser: the page fills the panel on either engine, streamed over the v2 WebSocket when the new engine runs
 * it, else over the v1 live view. Security: a new connection never replays old input. Only the server gives this view a
 * hold: one of the same person's, when none of their views uses it or when they take it over here.
 */
export function LiveBrowser({ bot, signIn, page }: { bot: Bot; signIn?: BrowserSignIn; page?: BrowserPage }) {
  const { state } = useStore();
  const [fallback, setFallback] = useState(false);
  const stream = state.config?.browserEngine?.engine === "chrome" && !fallback;
  const [noDesktop, setNoDesktop] = useState(false);
  const desktopView = stream && state.config?.browserEngine?.desktopView === true && !noDesktop;
  // The desktop app shows this browser natively over the page area; the stream underneath shows through any overlay.
  const paneMode = stream && state.config?.browserEngine?.pane === true && Boolean(window.ogb?.browserPane);
  // The page shows as a remote desktop or a native pane, not from the stream's pictures: the stream's tab list, which comes
  // once the browser runs, ends the starting state rather than a first picture.
  const pageNotFromFrames = useRef(false);
  pageNotFromFrames.current = desktopView || paneMode;
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [nav, setNav] = useState<BrowserNav>(NO_NAV);
  const [setting, setSetting] = useState<PreviewViewportSetting>({ mode: "fill" });
  const [zoom, setZoom] = useState(1);
  const [extensions, setExtensions] = useState<BrowserExtension[] | null>(null);
  const [takeStatus, setTakeStatus] = useState<BrowserTakeStatus>("");
  const [error, setError] = useState("");
  const [notReaching, setNotReaching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [gone, setGone] = useState(false);
  const [asleep, setAsleep] = useState<"" | "asleep" | "waking">("");
  const [kept, setKept] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [masked, setMasked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [passkeyDismissed, setPasskeyDismissed] = useState("");
  const floating = useBrowserPictureInPicture();
  const pageVisible = usePageVisible();
  const panel = useRef<HTMLDivElement>(null);
  const pageArea = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const surface = useRef<StreamSurfaceHandle>(null);
  const profilesDialog = useRef<HTMLDialogElement>(null);
  const typingDialog = useRef<HTMLDialogElement>(null);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const controlListeners = useRef(new Set<(control: PreviewStreamControl | null) => void>());
  const browserControl = useRef<BrowserControl | null>(null);
  // The v1 view this panel had for this bot and profile when its stream dropped: only its reconnect gets the hold back.
  const resume = useRef<LiveResume & { key: string }>({ key: "", viewer: "" });
  const keepNow = useRef(false);
  const signInHandled = useRef(0);
  const signInWoken = useRef(0);
  const pageHandled = useRef(0);
  const signInPage = useRef<string | null>(null);
  const pageNow = useRef<string | null>(null);
  const latest = useRef({ openSignInPage: () => {}, takeControl: () => {} });
  const signInOpen = state.computerControl?.[bot.id]?.help?.place === "browser";
  const scopedThread = browserScope(state.config?.team, bot.threadId).threadId;
  keepNow.current = kept || signInOpen;
  const profileName = bot.browserProfile === "guest" ? t("browser.panel.temporary")
    : state.config?.browserProfiles?.find((profile) => profile.id === bot.browserProfile)?.name ?? t("browser.panel.ownBrowser", { name: bot.name });
  useEffect(() => { if (showProfiles) profilesDialog.current?.showModal(); else profilesDialog.current?.close(); }, [showProfiles]);
  useEffect(() => {
    browserControl.current?.hold(showTyping);
    if (showTyping) typingDialog.current?.showModal(); else typingDialog.current?.close();
  }, [showTyping]);

  const reconnect = useCallback(() => {
    setGone(false);
    setError("");
    setFallback(false);
    setAttempt((value) => value + 1);
  }, []);
  // Another profile may run on the other engine: it gets the stream again if it has one.
  useEffect(() => { setFallback(false); setNoDesktop(false); }, [bot.id, bot.browserProfile, scopedThread]);
  useEffect(() => {
    setTabs([]);
    setExtensions(null);
    setNav(stream ? NO_NAV : { ...NO_NAV, canGoBack: true, canGoForward: true });
    setStarting(false);
    setGone(false);
    setNotReaching(false);
    setAsleep("");
    pageNow.current = null;
  }, [bot.id, bot.browserProfile, scopedThread, attempt, stream]);

  const connect = useCallback<SurfaceConnect>((target, events) => {
    const scope: Record<string, string> = scopedThread ? { threadId: scopedThread } : {};
    // The desktop view shows the page, so the stream beside it carries no pictures.
    if (stream) return createPreviewStreamClient({ access: browserStreamAccess(bot.id, window.location, desktopView ? { ...scope, frames: "0" } : scope), ...target }, events);
    const key = `${bot.id}\n${bot.browserProfile ?? ""}${scopedThread ? `\n${scopedThread}` : ""}`;
    if (resume.current.key !== key) resume.current = { key, viewer: "" };
    return createLiveStreamClient(bot.id, events, (body, viewerId) => api(withBrowserScope(`/api/bots/${encodeURIComponent(bot.id)}/browser/action`, scope), {
      // 120 s matches the server's browser requestTimeoutMs.
      method: "POST", body: JSON.stringify({ ...body, viewerId }), timeoutMs: 120_000,
    }), resume.current, scope, { width: target.width, height: target.height });
  }, [bot.id, bot.browserProfile, scopedThread, stream, desktopView]);

  const interact = useCallback((input: PreviewStreamInput) => {
    if (controlRef.current?.controller === "another-viewer") {
      if (startsInteraction(input)) (clientRef.current as Partial<LiveStreamClient> | null)?.transport?.dropped?.("held_elsewhere");
      setError(BROWSER_HELD_ELSEWHERE);
      return;
    }
    browserControl.current?.interact(input);
  }, []);

  const onClient = useCallback((client: PreviewStreamClient | null) => {
    clientRef.current = client;
    browserControl.current?.close();
    browserControl.current = null;
    if (!client) return;
    const transport = "transport" in client
      ? (client as LiveStreamClient).transport
      : streamTransport(client, {
        current: () => controlRef.current,
        watch: (listener) => { controlListeners.current.add(listener); return () => { controlListeners.current.delete(listener); }; },
      }, BROWSER_HELD_ELSEWHERE);
    const created = createBrowserControl({
      transport,
      owned: () => controlRef.current?.controller === "you",
      mine: () => controlRef.current?.owned === true,
      onTakeStatus: setTakeStatus,
      onError: setError,
    });
    created.keep(keepNow.current);
    browserControl.current = created;
  }, []);

  const onControl = useCallback((next: PreviewStreamControl | null) => {
    const previous = controlRef.current;
    controlRef.current = next;
    setControl(next);
    if (previous?.controller === "you" && next?.controller !== "you") setKept(false);
    if (next === null) setTakeStatus("");
    for (const listener of controlListeners.current) listener(next);
    browserControl.current?.observe();
  }, []);

  const onMessage = useCallback((message: Readonly<Record<string, unknown>>) => {
    if (message.type === "tabs") {
      const next = tabsOf(message.tabs);
      setTabs(next);
      if (pageNotFromFrames.current) setStarting(false);
      const active = next.find((tab) => tab.active);
      if (active) {
        setNav((current) => ({ ...current, url: active.url }));
        pageNow.current = active.url;
        latest.current.openSignInPage();
      }
    } else if (message.type === "nav" && typeof message.url === "string") {
      setNav({ url: message.url, loading: message.loading === true, canGoBack: message.canGoBack === true, canGoForward: message.canGoForward === true });
      pageNow.current = message.url;
      latest.current.openSignInPage();
    } else if (message.type === "url" && typeof message.url === "string") {
      setNav((current) => ({ ...current, url: message.url as string }));
      pageNow.current = message.url;
      latest.current.openSignInPage();
    } else if (message.type === "extensions") {
      setExtensions(extensionsOf(message.extensions));
    } else if (message.type === "viewport") {
      const next = message.setting as PreviewViewportSetting | undefined;
      if (next && (next.mode === "fill" || next.mode === "preset")) setSetting(next);
      if (typeof message.zoom === "number") setZoom(message.zoom);
    } else if (message.type === "inputHalted") {
      setNotReaching(message.halted === true);
    } else if (message.type === "starting") {
      setStarting(true);
    } else if (message.type === "asleep" || message.type === "awake") {
      if (message.type === "asleep") pageNow.current = null;
      setAsleep(message.type === "asleep" ? "asleep" : "");
    }
  }, []);

  useEffect(() => { browserControl.current?.keep(kept || signInOpen); }, [kept, signInOpen]);
  const paneHold = usePaneHold(bot.id, scopedThread ?? null, paneMode, signInOpen);
  const takeControl = () => { setKept(true); browserControl.current?.keep(true); browserControl.current?.takeControl(); paneHold.set(true); };
  const handBack = () => { setKept(false); browserControl.current?.handBack(); paneHold.set(false); };
  const openSignInPage = () => {
    const url = signInPage.current;
    if (!url || pageNow.current === null) return;
    signInPage.current = null;
    if (!pageNow.current || pageNow.current === "about:blank") interact({ type: "navigate", url });
  };
  latest.current = { openSignInPage, takeControl };
  // Woken once per request: a browser that cannot start answers "asleep" again, and Wake stays for the person.
  useEffect(() => {
    if (!signIn || !connected || signInHandled.current === signIn.nonce) return;
    if (asleep) {
      if (asleep === "asleep" && signInWoken.current !== signIn.nonce && clientRef.current?.send({ type: "wake" })) {
        signInWoken.current = signIn.nonce;
        setAsleep("waking");
      }
      return;
    }
    signInHandled.current = signIn.nonce;
    signInPage.current = signIn.url || null;
    if (signIn.expand) { setMaximized(true); setTakeTries(TAKE_TRIES); }
    latest.current.takeControl();
    latest.current.openSignInPage();
  }, [signIn, connected, asleep]);
  // A take made as the view grew to full size can land while its stream reconnects: it is asked again, a few times.
  const [takeTries, setTakeTries] = useState(0);
  useEffect(() => {
    if (!takeTries || !maximized || control?.controller === "you") { if (takeTries && control?.controller === "you") setTakeTries(0); return; }
    if (!connected || takeStatus === "pending" || takeStatus === "slow") return;
    const timer = setTimeout(() => { setTakeTries((left) => left - 1); latest.current.takeControl(); }, TAKE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [takeTries, maximized, connected, control, takeStatus]);

  // A new tab, so whatever the bot has open stays as it was; a sleeping browser is woken first.
  useEffect(() => {
    if (!page || !connected || pageHandled.current === page.nonce) return;
    if (asleep) {
      if (asleep === "asleep" && clientRef.current?.send({ type: "wake" })) setAsleep("waking");
      return;
    }
    pageHandled.current = page.nonce;
    interact({ type: "tabNew", url: page.url });
  }, [page, connected, asleep, interact]);

  // On macOS a full-screen element takes the window into native full screen, where minimize is disabled.
  useEffect(() => {
    const update = () => setFullscreen(Boolean(panel.current) && document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleFullscreen = () => {
    const leaving = Boolean(panel.current) && document.fullscreenElement === panel.current;
    if (leaving && maximized) {
      setMaximized(false);
    }
    const request = leaving ? document.exitFullscreen() : panel.current?.requestFullscreen();
    void request?.catch(() => setError(t(leaving ? "browser.panel.exitFullscreenFailed" : "browser.panel.fullscreenUnavailable")));
  };
  const toggleMaximize = () => {
    if (fullscreen && document.fullscreenElement === panel.current) {
      void document.exitFullscreen().catch(() => {});
    }
    setMaximized((value) => !value);
  };
  // The maximized panel swallows its Escape (defaultPrevented) so the same press cannot close a dialog beneath.
  // Capture: listeners registered before this panel must see the key already refused.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (fullscreen && document.fullscreenElement === panel.current) {
        void document.exitFullscreen().catch(() => {});
      }
      setMaximized(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [maximized, fullscreen]);

  const restart = () => {
    if (!window.confirm(t("browser.panel.confirmRestart"))) return;
    setError("");
    if (!clientRef.current?.send({ type: "restart" })) setError(t("browser.panel.notConnected"));
  };
  const wake = () => {
    if (connected && clientRef.current?.send({ type: "wake" })) setAsleep("waking");
    else reconnect();
  };
  const togglePip = () => {
    if (floating === bot.id) { closeBrowserPictureInPicture(); return; }
    void openBrowserPictureInPicture({ botId: bot.id, seed: surface.current?.canvas() ?? null }).catch(() => setError(t("browser.panel.pipUnavailable")));
  };

  const heldElsewhere = control?.controller === "another-viewer";
  const commandsReady = connected && !heldElsewhere;
  const you = control?.controller === "you";
  // A page nobody can see keeps the stream off. A viewer holding the browser keeps it: their hold pauses the bot, so
  // closing the view to save frames would hand the browser over while nobody watches.
  const shown = pageVisible || you;
  useEffect(() => {
    if (shown) return;
    setConnected(false);
    setError("");
  }, [shown]);
  const typingReady = connected && you;
  const obscured = useNativeViewObscured(showProfiles || showTyping || showImport, paneMode);
  const profile = state.config?.browserProfiles?.find((candidate) => candidate.id === bot.browserProfile);
  const importable = cookieImportAvailable(state.config) && bot.browserProfile !== "guest"
    && !(profile?.browser === "chrome" && state.config?.browserEngine?.myChrome === true);
  // A page's alert, confirm or prompt is answered in the panel's own card, under where the native pane would be.
  const paneVisible = paneMode && shown && connected && !asleep && !heldElsewhere && !gone && !starting && !obscured && !control?.dialog;
  const paneShown = useRef(paneVisible);
  const placePane = useRef<() => void>(() => {});
  // While the app shows the pane, the stream underneath sends no frames; it resumes as soon as the pane hides.
  const [paneUp, setPaneUp] = useState(false);
  const covered = paneVisible && paneUp;
  const coveredSent = useRef(false);
  useEffect(() => {
    if (!stream || (!covered && !coveredSent.current)) return;
    clientRef.current?.send({ type: "covered", covered });
    coveredSent.current = covered;
  }, [stream, covered, connected]);
  paneShown.current = paneVisible;
  useEffect(() => {
    const bridge = window.ogb?.browserPane;
    if (!paneMode || !bridge) return;
    const threadId = scopedThread ?? null;
    const profile = bot.browserProfile ?? null;
    let placed = 0;
    const place = () => {
      const rect = pageArea.current?.getBoundingClientRect();
      const bounds = rect && rect.width >= 1 && rect.height >= 1
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
      const visible = paneShown.current && bounds !== null;
      const asked = ++placed;
      void bridge.show({ botId: bot.id, threadId, profile, bounds, visible }).then((answer) => { if (asked === placed) setPaneUp(visible && answer?.shown === true); }, () => { if (asked === placed) setPaneUp(false); });
    };
    placePane.current = place;
    const stop = pageArea.current ? followBounds(pageArea.current, place) : () => {};
    return () => {
      placePane.current = () => {};
      stop();
      setPaneUp(false);
      void bridge.show({ botId: bot.id, threadId, profile, bounds: null, visible: false }).catch(() => undefined);
    };
  }, [paneMode, bot.id, bot.browserProfile, scopedThread]);
  // A pane the app makes after the panel asked (as after a server restart) is shown once its tab is listed.
  useEffect(() => { placePane.current(); }, [paneVisible, paneMode, bot.id, bot.browserProfile, scopedThread, tabs]);
  const pipSupported = stream && supportsBrowserPictureInPicture();
  const passkeyWall = passkeyWallAt(nav.url);
  return <div ref={panel} className={maximized
    ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-card text-ink"
    : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-card text-ink"} data-browser-transport={stream ? "stream" : "live"}>
    <ChromeRow
      ref={address}
      botName={bot.name}
      tabs={tabs}
      nav={nav}
      connected={connected}
      control={control}
      takeStatus={takeStatus}
      hint={t(kept || signInOpen ? "browser.control.keptHint" : "browser.control.yoursHint", { name: bot.name })}
      commandsReady={commandsReady}
      profileName={profileName}
      fullscreen={fullscreen}
      maximized={maximized}
      pillBelow={maximized}
      onCommand={interact}
      onAddress={(text) => {
        const url = resolveAddressBarInput(text);
        if (commandsReady && url) interact({ type: "navigate", url });
        else if (text.trim()) setError(t("browser.panel.enterAddress"));
      }}
      onTake={takeControl}
      onHandBack={handBack}
      onFullscreen={toggleFullscreen}
      onMaximize={toggleMaximize}
      onProfiles={() => { browserControl.current?.handBack(); setShowProfiles(true); }}
      menu={<>{stream ? <ExtensionsMenu
        ready={connected && you}
        extensions={extensions}
        onList={() => clientRef.current?.send({ type: "extensions" })}
        onOpen={(id) => clientRef.current?.send({ type: "openExtension", id })}
      /> : null}<MoreMenu
        stream={stream}
        ready={connected && you}
        typing={typingReady}
        setting={setting}
        zoom={zoom}
        pip={pipSupported ? { open: floating === bot.id } : null}
        onViewport={(next) => clientRef.current?.send({ type: "viewport", setting: next })}
        onZoom={(factor) => clientRef.current?.send({ type: "zoom", factor })}
        onPip={togglePip}
        onType={() => { setMasked(false); setShowTyping(true); }}
        onSecret={() => { setMasked(true); setShowTyping(true); }}
        {...(importable ? { onImport: () => setShowImport(true) } : {})}
        onReconnect={reconnect}
        onRestart={restart}
      /></>}
    />
    {(error || (notReaching && connected)) && <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline/30 px-3 py-2 text-[12px] text-danger"><span>{notReaching && connected ? t("browser.input.notReaching") : error}</span>{(!connected || notReaching) && <button className="shrink-0 underline" onClick={reconnect}>{t("browser.panel.reconnect")}</button>}</div>}
    {takeStatus === "stale" && <div role="status" className="shrink-0 border-b border-hairline/30 px-3 py-1.5 text-[12px] text-accent-text">{t("browser.control.stale", { name: bot.name })}</div>}
    {passkeyWall && passkeyDismissed !== nav.url && <PasskeyNotice wall={passkeyWall} botName={bot.name} onDismiss={() => setPasskeyDismissed(nav.url)} />}
    <div ref={pageArea} {...(paneMode ? { "data-native-view-host": "" } : {})} className="relative flex min-h-0 flex-1 flex-col bg-inset/40">
      {shown ? (
        <StreamSurface
          key={`${attempt}:${stream ? "stream" : "live"}:${bot.browserProfile ?? ""}${desktopView ? ":desktop" : ""}`}
          ref={surface}
          connect={connect}
          input={interact}
          label={t("browser.panel.pageLabel", { name: bot.name })}
          onClient={onClient}
          onControl={onControl}
          onMessage={onMessage}
          onConnectedChange={(next) => { setConnected(next); if (next) { setStarting(false); setGone(false); setError(""); } }}
          onFirstFrame={() => setStarting(false)}
          onUnauthorized={() => { if (stream) setFallback(true); else setGone(true); }}
          onGone={() => setGone(true)}
          onClose={(code, reason) => { if (code === 1013 && reason) setError(reason); }}
          onLeave={() => address.current?.focus()}
        />
      ) : null}
      {shown && desktopView && connected && !starting && !asleep && !gone && !heldElsewhere ? (
        <Suspense fallback={null}>
          <BrowserDesktop
            key={`${attempt}:${bot.browserProfile ?? ""}`}
            botId={bot.id}
            scope={scopedThread ? { threadId: scopedThread } : {}}
            controlling={you}
            label={t("browser.panel.pageLabel", { name: bot.name })}
            onUnavailable={() => setNoDesktop(true)}
          />
        </Suspense>
      ) : null}
      {asleep || heldElsewhere || gone || !connected || starting ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-card/95 p-6 text-center text-[13px] text-ink-secondary">
          {asleep ? <Moon size={24} /> : heldElsewhere ? <Hand size={24} /> : gone ? <Globe size={24} /> : <Loader2 size={24} className="animate-spin" />}
          <span>{asleep ? t("browser.panel.asleep") : heldElsewhere ? BROWSER_HELD_ELSEWHERE : gone ? t("browser.panel.disconnected") : !starting ? t("browser.panel.opening") : stream ? t("browser.panel.starting") : t("browser.live.botBusy", { name: bot.name })}</span>
          {asleep ? <button type="button" disabled={asleep === "waking"} className="rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink hover:bg-inset disabled:opacity-60" onClick={wake}>{t(asleep === "waking" ? "browser.panel.waking" : "browser.panel.wake")}</button>
            : gone ? <button type="button" className="rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink hover:bg-inset" onClick={reconnect}>{t("browser.panel.reconnect")}</button> : null}
        </div>
      ) : null}
    </div>
    {maximized && <BrowserViewerPill bot={bot} you={paneMode ? paneHold.held : you} pending={takeStatus === "pending" || takeStatus === "slow"} onTake={takeControl} onStop={handBack} onDone={() => paneHold.set(false)} onCollapse={() => setMaximized(false)} />}
    <dialog ref={profilesDialog} onClose={() => setShowProfiles(false)} onClick={(e) => { if (e.target === e.currentTarget) setShowProfiles(false); }} className="m-auto w-[min(420px,calc(100%-32px))] max-h-[80vh] overflow-auto rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-[15px] font-medium">{t("browser.panel.profiles")}</h2><button className={button} aria-label={t("browser.panel.closeProfiles")} onClick={() => setShowProfiles(false)}><X size={16} /></button></div>
      {(heldElsewhere || (you && takeStatus !== "")) && <p className="mb-3 text-[12px] text-ink-secondary">{t(heldElsewhere ? "browser.profiles.heldElsewhere" : "browser.profiles.busy")}</p>}
      <BrowserProfilesManager bot={bot} disabled={heldElsewhere || takeStatus === "pending" || takeStatus === "slow"} onProfileChanged={() => { setShowProfiles(false); reconnect(); }} />
    </dialog>
    {importable ? <CookieImportDialog open={showImport} botId={bot.id} botName={bot.name} threadId={scopedThread ?? null} site={siteOfAddress(nav.url)} onClose={() => setShowImport(false)} /> : null}
    {/* Security: a password or code typed here goes only to the page's focused field; it is never held in state, logged or shown. */}
    <dialog ref={typingDialog} onClose={() => { const field = typingDialog.current?.querySelector("input"); if (field) field.value = ""; setShowTyping(false); }} className="m-auto w-[min(420px,calc(100%-32px))] rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[14px] font-medium">{masked ? t("browser.typeSecret.title") : t("browser.panel.typeTextTitle")}</h2><button className={button} aria-label={t("browser.panel.closeTyping")} onClick={() => setShowTyping(false)}><X size={16} /></button></div>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault(); const field = e.currentTarget.elements.namedItem("pageText") as HTMLInputElement;
        if (typingReady && field.value) { interact({ type: "text", text: field.value }); field.value = ""; setShowTyping(false); }
      }}><input key={masked ? "secret" : "text"} name="pageText" type={masked ? "password" : "text"} aria-label={masked ? t("browser.typeSecret.field") : t("browser.panel.typeTextField")} autoComplete={masked ? "new-password" : "off"} spellCheck={false} maxLength={4096} placeholder={masked ? "••••••••" : t("browser.panel.typeTextPlaceholder")} className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" />
        {masked && <p className="flex items-center gap-1 text-[12px] text-ink-tertiary"><LockKeyhole size={11} aria-hidden="true" />{t("browser.typeSecret.note")}</p>}
        <button disabled={!typingReady} className="self-end rounded-lg bg-accent px-4 py-2 text-[12px] text-accent-ink disabled:opacity-40">{t("browser.panel.typeButton")}</button></form>
    </dialog>
  </div>;
}

export function BrowserPanel({ bot, signIn, page }: { bot: Bot; signIn?: BrowserSignIn; page?: BrowserPage }) {
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
  if (bot.browser === false) return <div className="p-5 text-[13px] text-ink-secondary">{t("browser.panel.enableBot")}</div>;
  if (engine?.kind === "engine" && !installing && !engine.installError) return <LiveBrowser key={bot.id} bot={bot} signIn={signIn} page={page} />;
  return <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 rounded-xl bg-card p-5">
    <div className="text-[15px] font-medium text-ink">{engine?.kind === "engine" ? t("browser.panel.installIncomplete") : t("browser.panel.engineNotInstalled")}</div>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{engine?.kind === "engine" ? t("browser.panel.installIncompleteHelp") : engine?.installable && admin !== false ? t("browser.panel.engineNotInstalledHelp", { name: bot.name }) : browserUnavailableReason(state.config)}</p>
    {engine?.installable || engine?.kind === "engine" ? <button type="button" onClick={() => void install()} disabled={installing || admin !== true} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-60">{installing ? t("browser.panel.installing") : engine?.kind === "engine" ? t("browser.panel.retryInstall") : t("browser.panel.installEngine")}</button> : null}
    {(engine?.installError || error) && <p role="alert" className="text-[12px] text-danger">{error ?? engine?.installError}</p>}
  </div>;
}
