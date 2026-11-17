import { useSyncExternalStore } from "react";
import type { PreviewFrameHandle, PreviewFrameStatus } from "@/components/PreviewFrame";
import type { PreviewTestingSession } from "./previewTesting";
import { PREVIEW_SIZE_PRESETS, RESPONSIVE_PREVIEW_SIZE_ID, type PreviewZoomMode } from "./previewSizes";

/**
 * Bot testing sessions shown inside Quick Preview.
 *
 * Bot tabs ("new" sessions) are rendered once by PreviewTestingLayer so their
 * pages survive chat switches and panel closes. Quick Preview only provides a
 * stage element (the slot) and the layout the layer should match. "active"
 * sessions attach to Quick Preview's own frame instead.
 */
export const SHOW_TESTING_EVENT = "gbs:preview-testing-show";
export interface ShowTestingDetail { sessionId: string; handled?: boolean }

/** Per-tab size settings, mirroring Quick Preview's own size controls. */
export interface TestingView { presetId: string; customSize: { width: number; height: number }; rotated: boolean; zoom: PreviewZoomMode; dims: string }
export interface TestingMeta { status: PreviewFrameStatus; canGoBack: boolean; canGoForward: boolean }
/** What Quick Preview last rendered for a tab; `dims` ties it to the bot's requested size. */
export interface TestingLayout { width: number; height: number; scale: number; fill: boolean; padded: boolean; bezel: boolean; interactive: boolean; dims: string }

interface State {
  sessions: PreviewTestingSession[];
  /** Tab shown in Quick Preview: a session id, or null for the user's own page. */
  tab: string | null;
  error: string;
  slot: HTMLElement | null;
  views: Record<string, TestingView>;
  layouts: Record<string, TestingLayout>;
  meta: Record<string, TestingMeta>;
  /** Quick Preview panels currently mounted; when none, the app shows a fallback panel. */
  hosts: number;
  fallbackOpen: boolean;
}

let state: State = { sessions: [], tab: null, error: "", slot: null, views: {}, layouts: {}, meta: {}, hosts: 0, fallbackOpen: false };
const listeners = new Set<() => void>();
const frames = new Map<string, PreviewFrameHandle>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export function useTestingState() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
export const testingState = () => state;

/** Maps a bot's requested viewport onto Quick Preview's size controls. */
export function viewFromSession(session: PreviewTestingSession, zoom: PreviewZoomMode = "fit"): TestingView {
  const dims = `${session.width}x${session.height}x${session.responsive}`;
  if (session.responsive) return { presetId: RESPONSIVE_PREVIEW_SIZE_ID, customSize: { width: session.width, height: session.height }, rotated: false, zoom, dims };
  for (const preset of PREVIEW_SIZE_PRESETS) {
    if (preset.width === session.width && preset.height === session.height) return { presetId: preset.id, customSize: { width: session.width, height: session.height }, rotated: false, zoom, dims };
    if (preset.rotatable && preset.height === session.width && preset.width === session.height) return { presetId: preset.id, customSize: { width: session.width, height: session.height }, rotated: true, zoom, dims };
  }
  return { presetId: "custom", customSize: { width: session.width, height: session.height }, rotated: false, zoom, dims };
}

export const testingStore = {
  state: () => state,
  setSessions(next: PreviewTestingSession[]) {
    const sessions = next.filter((s) => s.state !== "closed");
    const ids = new Set(sessions.map((s) => s.id));
    const views: Record<string, TestingView> = {};
    for (const s of sessions) {
      const previous = state.views[s.id];
      // A bot resize replaces any size the user picked; otherwise keep the user's choice.
      const dims = `${s.width}x${s.height}x${s.responsive}`;
      views[s.id] = previous && previous.dims === dims ? previous : viewFromSession(s, previous?.zoom);
    }
    for (const id of frames.keys()) if (!ids.has(id)) frames.delete(id);
    const tab = state.tab && ids.has(state.tab) ? state.tab : null;
    set({ sessions, views, tab, fallbackOpen: state.fallbackOpen && sessions.length > 0 });
  },
  setTab(tab: string | null) { if (tab !== state.tab) set({ tab, error: "" }); },
  setError(error: string) { if (error !== state.error) set({ error }); },
  setSlot(slot: HTMLElement | null) { if (slot !== state.slot) set({ slot }); },
  setView(id: string, patch: Partial<TestingView>) {
    const view = state.views[id];
    if (view) set({ views: { ...state.views, [id]: { ...view, ...patch } } });
  },
  setLayout(id: string, layout: TestingLayout) {
    const previous = state.layouts[id];
    if (previous && Object.keys(layout).every((k) => previous[k as keyof TestingLayout] === layout[k as keyof TestingLayout])) return;
    set({ layouts: { ...state.layouts, [id]: layout } });
  },
  setMeta(id: string, patch: Partial<TestingMeta>) {
    const previous = state.meta[id] ?? { status: "empty" as PreviewFrameStatus, canGoBack: false, canGoForward: false };
    if (Object.entries(patch).every(([k, v]) => previous[k as keyof TestingMeta] === v) && state.meta[id]) return;
    set({ meta: { ...state.meta, [id]: { ...previous, ...patch } } });
  },
  addHost() { set({ hosts: state.hosts + 1 }); return () => set({ hosts: state.hosts - 1 }); },
  setFallbackOpen(fallbackOpen: boolean) { if (fallbackOpen !== state.fallbackOpen) set({ fallbackOpen }); },
  setFrame(id: string, handle: PreviewFrameHandle | null) { if (handle) frames.set(id, handle); else frames.delete(id); },
  frame(id: string) { return frames.get(id) ?? null; },
  async control(sessionId: string, action: "pause" | "resume" | "close") {
    set({ error: "" });
    try { await window.gbs!.previewTesting!.control({ sessionId, action }); } catch (error) { set({ error: (error as Error).message }); }
  },
};
