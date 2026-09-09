import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, EllipsisVertical, Globe, Hand, Loader2, Maximize2, Plus, RotateCw, UserRound, X } from "lucide-react";
import { browserUnavailableReason } from "@/lib/feature-flags";
import { api, useStore, type Bot } from "@/state/store";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { BrowserViewport, type BrowserFrame } from "./BrowserViewport";
import { createBrowserInputQueue } from "@/lib/browser-input-queue";

interface BrowserTab { tabId: string; title: string; url: string; active: boolean }
const button = "rounded-md p-1.5 text-ink-secondary hover:bg-inset hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";

/** Closing a panel releases its lease. A new connection never silently
 * restores permission to type, and never replays old browser frames. */
export function LiveBrowser({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [address, setAddress] = useState("");
  const [connected, setConnected] = useState(false);
  const [control, setControl] = useState({ held: false, controlling: false, owned: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [showProfiles, setShowProfiles] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const viewer = useRef("");
  const panel = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const profilesDialog = useRef<HTMLDialogElement>(null);
  const typingDialog = useRef<HTMLDialogElement>(null);
  const inputQueue = useRef<ReturnType<typeof createBrowserInputQueue> | null>(null);
  const urlEditing = useRef(false);
  const profileName = bot.browserProfile === "guest" ? "Temporary browser"
    : state.config?.browserProfiles?.find((profile) => profile.id === bot.browserProfile)?.name ?? `${bot.name}’s own browser`;
  useEffect(() => { if (showProfiles) profilesDialog.current?.showModal(); else profilesDialog.current?.close(); }, [showProfiles]);
  useEffect(() => { if (showTyping) typingDialog.current?.showModal(); else typingDialog.current?.close(); }, [showTyping]);

  const action = useCallback(async (body: Record<string, unknown>, expected = viewer.current) => {
    if (!expected) throw new Error("Open the browser connection first.");
    return api(`/api/bots/${bot.id}/browser/action`, { method: "POST", body: JSON.stringify({ ...body, viewerId: expected }) });
  }, [bot.id]);
  const input = useCallback((body: Record<string, unknown>) => {
    inputQueue.current?.enqueue(body);
  }, []);

  useEffect(() => {
    let stopped = false;
    setFrame(null); setTabs([]); setAddress(""); setConnected(false); setError("");
    setControl({ held: false, controlling: false, owned: false }); setPending(false);
    const source = new EventSource(`/api/bots/${bot.id}/browser/live`);
    const listen = (name: string, handler: (data: any) => void) => source.addEventListener(name, (event) => {
      if (stopped) return;
      try { handler(JSON.parse((event as MessageEvent).data)); } catch { /* Malformed events are not rendered. */ }
    });
    listen("ready", (data) => {
      const expected = String(data.viewerId);
      viewer.current = expected;
      inputQueue.current = createBrowserInputQueue(async (body) => {
        if (viewer.current === expected) await action(body, expected);
      }, (cause) => { if (viewer.current === expected) setError(cause instanceof Error ? cause.message : String(cause)); });
      setConnected(true);
    });
    listen("frame", setFrame);
    listen("tabs", (data) => {
      setTabs(data.tabs);
      const active = data.tabs.find((tab: BrowserTab) => tab.active);
      if (active && !urlEditing.current) setAddress(active.url === "about:blank" ? "" : active.url);
    });
    listen("url", (data) => { if (!urlEditing.current) setAddress(data.url === "about:blank" ? "" : data.url); });
    listen("status", (data) => {
      if (data.viewportWidth > 0 && data.viewportHeight > 0) setViewport({ width: data.viewportWidth, height: data.viewportHeight });
    });
    listen("control", (data) => {
      setControl(data);
      if (data.held && !data.controlling) { setFrame(null); setTabs([]); setAddress(""); }
    });
    source.addEventListener("error", (event) => {
      // A closed source may still deliver its queued error after a profile
      // switch or reconnect. It must not clear the replacement viewer/input.
      if (stopped) return;
      stopped = true;
      let message = "Browser connection ended. Reconnect to continue watching.";
      if (event instanceof MessageEvent) { try { message = JSON.parse(event.data).message || message; } catch { /* Network error fallback. */ } }
      setError(message); setConnected(false); setFrame(null); setControl({ held: false, controlling: false, owned: false });
      viewer.current = ""; inputQueue.current?.clear(); source.close();
    });
    return () => { stopped = true; viewer.current = ""; inputQueue.current?.clear(); source.close(); };
  }, [bot.id, bot.browserProfile, attempt, action]);

  const execute = async (body: Record<string, unknown>) => {
    const expected = viewer.current;
    setPending(true); setError("");
    try { await inputQueue.current?.drain(); await action(body, expected); if (body.type === "restart") setAttempt((value) => value + 1); }
    catch (cause) { if (viewer.current === expected) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (viewer.current === expected) setPending(false); }
  };
  const driving = control.controlling && connected && !pending;
  return <div ref={panel} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-card text-ink">
    <div className="flex min-h-12 items-center gap-1 px-2 pt-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.length ? tabs.map((tab) => <div key={tab.tabId} className={`flex max-w-52 shrink-0 items-center gap-1 rounded-xl px-1 text-[12px] ${tab.active ? "bg-inset text-ink" : "text-ink-secondary"}`}>
          <Globe size={13} className="ml-1.5 shrink-0 opacity-60" />
          <button className="truncate px-1 py-2 text-left disabled:cursor-default" disabled={!driving} onClick={() => void execute({ type: "tab-select", tabId: tab.tabId })} title={tab.title || tab.url}>{tab.title || "New tab"}</button>
          <button className={button} aria-label={`Close ${tab.title || "tab"}`} disabled={!driving} onClick={() => void execute({ type: "tab-close", tabId: tab.tabId })}><X size={13} /></button>
        </div>) : <div className="flex items-center gap-2 rounded-xl bg-inset px-3 py-2 text-[12px] text-ink-secondary"><Globe size={13} />New tab</div>}
        <button className={`${button} shrink-0`} disabled={!driving} aria-label="New tab" title="New tab" onClick={() => void execute({ type: "tab-new" })}><Plus size={17} /></button>
      </div>
      <button className={button} title="Full screen" aria-label="Full screen" onClick={() => { void panel.current?.requestFullscreen().catch(() => setError("Full screen is unavailable in this browser.")); }}><Maximize2 size={16} /></button>
      <button className={`${button} rounded-xl bg-inset p-2`} title={`Browser profile: ${profileName}`} aria-label="Browser profiles" aria-expanded={showProfiles} onClick={() => setShowProfiles(true)}><UserRound size={16} /></button>
    </div>
    <form className="flex h-12 items-center gap-1 border-b border-hairline/40 px-2" onSubmit={(e) => { e.preventDefault(); if (driving && address.trim()) void execute({ type: "navigate", url: /^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}` }); }}>
      <div className="flex shrink-0 items-center">
        <button type="button" className={button} disabled={!driving} aria-label="Back" onClick={() => void execute({ type: "back" })}><ArrowLeft size={17} /></button>
        <button type="button" className={button} disabled={!driving} aria-label="Forward" onClick={() => void execute({ type: "forward" })}><ArrowRight size={17} /></button>
        <button type="button" className={button} disabled={!driving} aria-label="Reload page" onClick={() => void execute({ type: "reload" })}><RotateCw size={17} /></button>
      </div>
      <input ref={addressInput} aria-label="Browser address" readOnly={!driving} value={address} onChange={(e) => setAddress(e.target.value)} onFocus={(e) => { urlEditing.current = true; if (driving) e.target.select(); }} onBlur={() => { urlEditing.current = false; }} placeholder={connected ? "about:blank" : "Connecting…"} spellCheck={false} className="mx-1 min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1.5 text-center text-[12px] outline-none placeholder:text-ink-secondary focus:bg-inset focus:text-left" />
      <button type="button" disabled={!connected || pending || (control.held && !control.owned)} onClick={() => void execute({ type: control.owned ? "release" : "take" })} title={control.owned ? "Return to bot — browser tools are paused while you control this profile" : control.held ? "This profile is controlled in another window" : "Take control to click, type, or sign in"} aria-label={control.owned ? "Return to bot" : "Take control"} aria-pressed={control.owned} className={`${button} flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] sm:text-[12px] ${control.owned ? "bg-accent/15 text-accent" : ""}`}>
        {pending ? <Loader2 size={16} className="animate-spin" /> : <Hand size={16} className="hidden sm:block" />}
        <span>{control.owned ? "Return to bot" : "Take control"}</span>
      </button>
      <details className="relative shrink-0">
        <summary className={`${button} list-none cursor-pointer [&::-webkit-details-marker]:hidden`} aria-label="Browser menu" title="Browser menu"><EllipsisVertical size={17} /></summary>
        <div className="absolute right-0 top-full z-20 mt-2 flex w-44 flex-col rounded-xl border border-hairline/50 bg-card p-1.5 text-[12px] shadow-xl">
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!driving} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setShowTyping(true); }}>Type or paste text…</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setAttempt((value) => value + 1); }}>Reconnect view</button>
          <button type="button" className="rounded-md px-3 py-2 text-left hover:bg-inset disabled:opacity-40" disabled={!connected || pending} onClick={(e) => {
            e.currentTarget.closest("details")?.removeAttribute("open");
            if (!window.confirm("Restart this profile’s browser? Open tabs will close. Saved logins are kept. Stop any bots using it first.")) return;
            void execute({ type: "restart" });
          }}>Restart browser…</button>
        </div>
      </details>
    </form>
    {error && <div role="alert" className="flex items-center justify-between gap-2 border-b border-hairline/30 px-3 py-2 text-[12px] text-danger"><span>{error}</span>{!connected && <button className="shrink-0 underline" onClick={() => setAttempt((value) => value + 1)}>Reconnect</button>}</div>}
    <div className="min-h-48 flex-1 overflow-auto bg-inset/40">
      {frame ? <BrowserViewport frame={frame} {...viewport} driving={driving} input={input}
        onReturnToToolbar={() => addressInput.current?.focus()}
        acknowledge={(seq) => { if (viewer.current) void action({ type: "ack", seq }).catch(() => {}); }}
        onDecodeError={() => setError("A browser frame could not be decoded. Close and reopen the panel to reconnect.")} />
        : <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-ink-secondary">{connected && control.held ? <Hand size={24} /> : error ? <Globe size={24} /> : <Loader2 size={24} className="animate-spin" />}<span>{control.held ? "Live view paused for human control" : error ? "Browser disconnected" : "Opening the live browser…"}</span></div>}
    </div>
    <dialog ref={profilesDialog} onClose={() => setShowProfiles(false)} onClick={(e) => { if (e.target === e.currentTarget) setShowProfiles(false); }} className="m-auto w-[min(420px,calc(100%-32px))] max-h-[80vh] overflow-auto rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-[15px] font-medium">Browser profiles</h2><button className={button} aria-label="Close browser profiles" onClick={() => setShowProfiles(false)}><X size={16} /></button></div>
      <BrowserProfilesManager bot={bot} disabled={pending || control.held} onProfileChanged={() => { setShowProfiles(false); setAttempt((value) => value + 1); }} />
    </dialog>
    <dialog ref={typingDialog} onClose={() => setShowTyping(false)} className="m-auto w-[min(420px,calc(100%-32px))] rounded-2xl border border-hairline/50 bg-card p-5 text-ink shadow-2xl backdrop:bg-black/40">
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[14px] font-medium">Type into the selected page field</h2><button className={button} aria-label="Close typing" onClick={() => setShowTyping(false)}><X size={16} /></button></div>
      <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault(); const field = e.currentTarget.elements.namedItem("pageText") as HTMLInputElement;
      if (driving && field.value) { input({ type: "input_keyboard", eventType: "char", text: field.value }); field.value = ""; setShowTyping(false); }
    }}><input name="pageText" aria-label="Text for the page" autoComplete="off" maxLength={4096} placeholder="Type or paste text" className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" /><button disabled={!driving} className="self-end rounded-lg bg-accent px-4 py-2 text-[12px] text-accent-ink disabled:opacity-40">Type</button></form>
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
  if (admin === false) return <div className="p-5 text-[13px] text-ink-secondary">Only workspace administrators can view or control saved browser sessions.</div>;
  if (bot.browser === false) return <div className="p-5 text-[13px] text-ink-secondary">Enable the browser in this bot’s profile to use it.</div>;
  if (engine?.kind === "engine" && !installing && !engine.installError) return admin === null
    ? <div className="p-5 text-[13px] text-ink-secondary">Loading browser…</div>
    : <LiveBrowser key={bot.id} bot={bot} />;
  return <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 rounded-xl bg-card p-5">
    <div className="text-[15px] font-medium text-ink">{engine?.kind === "engine" ? "Browser installation incomplete" : "Browser engine not installed"}</div>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{engine?.kind === "engine" ? "agent-browser is installed, but Chrome setup has not finished. Retry the browser installation." : browserUnavailableReason(state.config)}</p>
    {engine?.installable || engine?.kind === "engine" ? <button type="button" onClick={() => void install()} disabled={installing || admin !== true} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-60">{installing ? "Installing… (a one-time download of about 160 MB)" : engine?.kind === "engine" ? "Retry browser installation" : "Install the browser engine"}</button> : null}
    {(engine?.installError || error) && <p role="alert" className="text-[12px] text-danger">{error ?? engine?.installError}</p>}
  </div>;
}
