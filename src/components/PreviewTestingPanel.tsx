import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Hand, Play, Square, X } from "lucide-react";
import type { PreviewTestingSession } from "@/lib/previewTesting";
import { usePanelResize } from "@/lib/usePanelResize";
import { cn } from "@/lib/cn";
import { PreviewFrame } from "./PreviewFrame";
import { ResizeHandle } from "./ResizeHandle";

function TestingFrame({ session, active, bounds, onError }: { session: PreviewTestingSession; active: boolean; bounds: { width: number; height: number }; onError: (message: string) => void }) {
  // Navigation happens within this guest. Polling session status must never remount it.
  const source = useMemo(() => session.source, [session.id]);
  const width = session.responsive ? Math.max(240, bounds.width) : session.width;
  const height = session.responsive ? Math.max(200, bounds.height) : session.height;
  const scale = session.responsive ? 1 : Math.min(1, bounds.width / width, bounds.height / height);
  return <div aria-hidden={!active} className="absolute inset-0 flex items-center justify-center overflow-hidden" style={{ visibility: active ? "visible" : "hidden", pointerEvents: active ? "auto" : "none" }}>
    <PreviewFrame source={source} width={width} height={height} scale={Math.max(0.1, scale)} fill={session.responsive} showDeviceBezel={false} testingSessionId={session.id} testingActive={session.state !== "paused"} onTestingError={onError} frameTitle={session.name} />
  </div>;
}
export function PreviewTestingPanel() {
  const [sessions, setSessions] = useState<PreviewTestingSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bounds, setBounds] = useState({ width: 600, height: 700 });
  const stage = useRef<HTMLDivElement>(null);
  const ids = sessions.map(s => s.id).join(",");
  const { width, handleProps } = usePanelResize({ id: "preview-testing", defaultWidth: 680, minWidth: 360, maxWidth: () => Math.min(1000, window.innerWidth - 68), edge: "left", label: "Resize bot testing Preview", docked: false });
  useEffect(() => {
    const api = window.gbs?.previewTesting;
    if (!api) return;
    let alive = true;
    const update = (next: PreviewTestingSession[]) => { if (alive) setSessions(next.filter(s => s.state !== "closed")); };
    const unsubscribe = api.onSessions(update);
    const unsubscribeActive = api.onActive(id => { if (alive) { setSelected(id); setError(""); } });
    void api.start().then(update).catch(e => setError(e.message));
    return () => { alive = false; unsubscribe(); unsubscribeActive(); };
  }, []);
  useEffect(() => {
    setSelected(previous => previous && sessions.some(s => s.id === previous) ? previous : sessions.at(-1)?.id ?? null);
  }, [ids]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBounds({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(sessions.length)]);
  const onFrameError = useCallback((message: string) => setError(message), []);
  const session = sessions.find(s => s.id === selected) ?? sessions.at(-1);
  if (!session) return null;
  const control = (action: "pause" | "resume" | "close") => {
    setError("");
    void window.gbs!.previewTesting!.control({ sessionId: session.id, action }).catch(e => setError(e.message));
  };
  return <aside aria-label="Bot testing Preview" data-panel="preview-testing" className="fixed inset-y-0 right-0 z-30 flex flex-col border-l border-hairline/60 bg-panel shadow-2xl shadow-black/50" style={{ width, maxWidth: "calc(100vw - 32px)" }}>
    <header className="flex min-h-[60px] items-center justify-between gap-3 border-b border-hairline/40 px-4 py-2">
      <div className="min-w-0"><h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Bot size={17} className="text-accent" />Testing in Preview</h2><p className="mt-0.5 truncate text-[12px] text-ink-secondary">{session.state === "paused" ? session.canResume ? "You have control" : "Page replaced · start a new session" : session.state === "error" ? "Test session needs attention" : `Controlled by ${session.botName}`}</p></div>
      <div className="flex shrink-0 items-center gap-1.5">
        {session.state === "paused" ? session.canResume && <button onClick={() => control("resume")} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] text-white"><Play size={13} />Resume bot</button> : session.state !== "error" && <button onClick={() => control("pause")} className="flex items-center gap-1.5 rounded-lg border border-hairline/60 bg-raised px-3 py-2 text-[12px] text-ink"><Square size={12} />Stop / take control</button>}
        <button aria-label="Close testing session" title="Close this testing session" onClick={() => control("close")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={17} /></button>
      </div>
    </header>
    {sessions.length > 1 && <div aria-label="Testing sessions" className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/40 px-3 py-2">{sessions.map(s => <button key={s.id} aria-pressed={s.id === session.id} onClick={() => { setSelected(s.id); setError(""); }} className={cn("max-w-[220px] shrink-0 truncate rounded-lg px-3 py-1.5 text-[12px]", s.id === session.id ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised")}>{s.botName} · {s.name}</button>)}</div>}
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/30 px-4 py-2 text-[11px] text-ink-secondary"><span className="truncate" title={session.url}>{session.url}</span><span role="status" className="shrink-0">{session.state === "paused" ? <span className="flex items-center gap-1"><Hand size={12} />Paused</span> : session.activity}</span></div>
    {session.state === "paused" && !session.canResume && <p className="border-b border-hairline/40 px-4 py-2 text-[12px] text-ink-secondary">This page was replaced. Close this session and ask the bot to open a new test.</p>}
    {(error || session.error) && <p role="alert" className="border-b border-danger/20 bg-danger/10 px-4 py-2 text-[12px] text-danger">{error || session.error}</p>}
    <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden bg-inset">{sessions.filter(s => s.state !== "error").map(s => <TestingFrame key={s.id} session={s} active={s.id === session.id} bounds={bounds} onError={onFrameError} />)}</div>
    <footer className="flex shrink-0 justify-between border-t border-hairline/40 px-4 py-2 text-[11px] text-ink-secondary"><span>{session.responsive ? `Responsive · ${bounds.width} × ${bounds.height}` : `${session.width} × ${session.height}`}</span><span>Embedded browser · {session.botName}</span></footer>
    <ResizeHandle {...handleProps} />
  </aside>;
}
