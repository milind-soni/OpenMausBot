import { useCallback, useEffect, useMemo, useState } from "react";
import type { PreviewTestingSession } from "@/lib/previewTesting";
import { SHOW_TESTING_EVENT, testingState, testingStore, useTestingState, type ShowTestingDetail, type TestingLayout } from "@/lib/previewTestingStore";
import { cn } from "@/lib/cn";
import { computeFrameScale } from "@/lib/previewSizes";
import { PreviewFrame, type PreviewFrameHandle, type PreviewFrameStatus } from "./PreviewFrame";

function TestingFrame({ session, layout, visible, interactive }: { session: PreviewTestingSession; layout?: TestingLayout; visible: boolean; interactive: boolean }) {
  // Navigation happens within this guest. Session updates must never remount it.
  const source = useMemo(() => session.source, [session.id]);
  const id = session.id;
  const frameRef = useCallback((handle: PreviewFrameHandle | null) => testingStore.setFrame(id, handle), [id]);
  const onStatusChange = useCallback((status: PreviewFrameStatus) => testingStore.setMeta(id, { status }), [id]);
  const onHistoryStateChange = useCallback((history: { canGoBack: boolean; canGoForward: boolean }) => testingStore.setMeta(id, history), [id]);
  const width = layout?.width ?? session.width;
  const height = layout?.height ?? session.height;
  return <div aria-hidden={!visible} className={cn("absolute inset-0 flex items-start justify-center overflow-auto", layout?.padded && "p-4")} style={{ visibility: visible ? "visible" : "hidden", pointerEvents: visible && interactive ? "auto" : "none" }}>
    <PreviewFrame
      ref={frameRef}
      source={source}
      width={width}
      height={height}
      scale={Math.max(0.1, layout?.scale ?? 1)}
      fill={layout?.fill ?? session.responsive}
      showDeviceBezel={layout?.bezel ?? false}
      testingSessionId={session.id}
      testingActive={session.state !== "paused"}
      onTestingError={testingStore.setError}
      onStatusChange={onStatusChange}
      onHistoryStateChange={onHistoryStateChange}
      frameTitle={session.name}
    />
  </div>;
}

/**
 * Hosts bot-owned Preview tabs for the whole app. The pages sit over Quick
 * Preview's stage while their tab is shown and stay alive (hidden) otherwise,
 * so switching chats or closing the panel does not end a bot's test.
 */
export function PreviewTestingLayer() {
  const { sessions, tab, slot, layouts, views } = useTestingState();
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const api = window.gbs?.previewTesting;
    if (!api) return;
    let alive = true;
    const update = (next: PreviewTestingSession[]) => { if (alive) testingStore.setSessions(next); };
    const unsubscribe = api.onSessions(update);
    const unsubscribeActive = api.onActive(id => {
      if (!alive) return;
      const session = testingState().sessions.find(s => s.id === id);
      testingStore.setTab(session?.target === "active" ? null : id);
      const detail: ShowTestingDetail = { sessionId: id };
      window.dispatchEvent(new CustomEvent(SHOW_TESTING_EVENT, { detail }));
      // No chat is showing Quick Preview (e.g. Settings or the Preview page): use the app-level panel.
      if (!detail.handled && testingState().hosts === 0) testingStore.setFallbackOpen(true);
    });
    void api.start().then(update).catch(e => testingStore.setError(e.message));
    return () => { alive = false; unsubscribe(); unsubscribeActive(); };
  }, []);

  // Follow the stage element; it moves with panel resizes, drawers and window layout.
  useEffect(() => {
    if (!slot) { setRect(null); return; }
    let frame = 0;
    const track = () => {
      const r = slot.getBoundingClientRect();
      setRect(previous => previous && previous.left === r.left && previous.top === r.top && previous.width === r.width && previous.height === r.height ? previous : { left: r.left, top: r.top, width: r.width, height: r.height });
      frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [slot]);

  const tabs = sessions.filter(s => s.target !== "active" && s.state !== "error");
  // Tabs Quick Preview has not laid out at the bot's current size follow the bot's request directly.
  const layoutFor = (s: PreviewTestingSession): TestingLayout => {
    const layout = layouts[s.id];
    if (layout && layout.dims === views[s.id]?.dims) return layout;
    const stage = rect ?? { width: 800, height: 700 };
    const width = s.responsive ? Math.max(240, Math.floor(stage.width)) : s.width;
    const height = s.responsive ? Math.max(200, Math.floor(stage.height)) : s.height;
    return { width, height, scale: s.responsive ? 1 : computeFrameScale({ width, height }, stage, "fit", 16), fill: s.responsive, padded: !s.responsive, bezel: false, interactive: true, dims: "" };
  };
  if (!tabs.length) return null;
  const shown = rect ? tabs.find(s => s.id === tab) : undefined;
  const interactive = shown ? layoutFor(shown).interactive : false;
  return <div
    data-panel="preview-testing-layer"
    className="fixed z-[35] overflow-hidden"
    // Without a stage, pages keep their size off-screen so a bot can keep working.
    style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: shown && interactive ? "auto" : "none" } : { left: -10000, top: 0, width: 800, height: 700, pointerEvents: "none" }}
  >
    {tabs.map(s => <TestingFrame key={s.id} session={s} layout={layoutFor(s)} visible={s.id === shown?.id} interactive={interactive} />)}
  </div>;
}
