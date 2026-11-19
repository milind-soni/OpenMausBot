import { PreviewTestingLayer } from "@/components/PreviewTestingLayer";
import { MobilePreviewPanel } from "@/components/MobilePreviewPanel";
import { testingStore, useTestingState } from "@/lib/previewTestingStore";
import { ScheduleSheet } from "@/components/ScheduleSheet";
import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { initAnalytics } from "@/lib/analytics";
import { StudioTour } from "@/components/StudioTour";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { TaskBoardScreen } from "@/components/TaskBoardScreen";
import { ProjectsProvider } from "@/state/projects";
import { useQueuedMessageSender } from "@/lib/useQueuedMessageSender";

// Full-page screens outside the chat loop load on first open, keeping them
// out of the startup bundle.
const SchedulesScreen = lazy(() => import("@/components/SchedulesScreen").then(m => ({ default: m.SchedulesScreen })));
const SettingsScreen = lazy(() => import("@/components/SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const AppsScreen = lazy(() => import("@/components/AppsScreen").then((m) => ({ default: m.AppsScreen })));
const ProjectsScreen = lazy(() => import("@/components/ProjectsScreen").then((m) => ({ default: m.ProjectsScreen })));
const PreviewScreen = lazy(() => import("@/components/PreviewScreen"));

function ScreenFallback() {
  return (
    <div className="flex flex-1 items-center justify-center text-ink-secondary">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}

/** Shows Quick Preview app-wide when a bot starts testing while no chat shows it. */
function TestingFallbackPanel() {
  const testing = useTestingState();
  if (!testing.fallbackOpen || testing.hosts > 0) return null;
  return (
    <MobilePreviewPanel
      onClose={() => testingStore.setFallbackOpen(false)}
      docked={false}
      testingHost={false}
      className="fixed inset-y-0 right-0 z-30 flex max-w-full shadow-2xl"
    />
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId && !b.hidden) ?? state.bots.find((b) => !b.hidden));
  useQueuedMessageSender();

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  return (
    <div className="flex h-full flex-col">
      <PreviewTestingLayer />
      <TestingFallbackPanel />
      <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      {state.scheduleSheet && <ScheduleSheet {...state.scheduleSheet} onClose={() => dispatch({ type: "closeSchedule" })} />}
      {state.schedulesOpen ? <Suspense fallback={<ScreenFallback />}><SchedulesScreen /></Suspense> : state.appSettingsOpen ? (
        <Suspense fallback={<ScreenFallback />}>
          <SettingsScreen />
        </Suspense>
      ) : state.appsOpen ? (
        <Suspense fallback={<ScreenFallback />}>
          <AppsScreen />
        </Suspense>
      ) : state.taskBoardOpen ? (
        <TaskBoardScreen />
      ) : state.projectsOpen ? (
        <Suspense fallback={<ScreenFallback />}>
          <ProjectsScreen />
        </Suspense>
      ) : state.previewOpen ? (
        <Suspense fallback={<ScreenFallback />}>
          <PreviewScreen />
        </Suspense>
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No Buddies yet" : "Connecting to Studio…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      </div>
    </div>
  );
}

type LaunchConfig = {
  profile: { name: string; email: string };
  alphaOnboarding: { id: string; completed: boolean } | null;
};

function Launch() {
  const [config, setConfig] = useState<LaunchConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false);
  useEffect(() => { initAnalytics(); }, []);
  const connect = async (signal: AbortSignal) => {
    setFailed(false);
    try {
      const config: LaunchConfig = await api("/api/config", { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      if (!signal.aborted) setConfig(config);
    } catch {
      if (!signal.aborted) setFailed(true);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void connect(controller.signal);
    return () => controller.abort();
  }, []);

  if (!config) {
    if (!failed) return <div className="flex h-full items-center justify-center bg-app"><ScreenFallback /></div>;
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-app p-4 text-center text-ink">
        <h1 className="text-xl font-semibold">Gérer Build Studio (v0.1 Alpha)</h1>
        <p role="alert" className="text-sm text-ink-secondary">Studio couldn’t connect to its local service.</p>
        <button className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white" onClick={() => void connect(new AbortController().signal)}>Try again</button>
      </main>
    );
  }
  if (config.alphaOnboarding && !config.alphaOnboarding.completed && !finished) {
    return <Onboarding id={config.alphaOnboarding.id} profile={config.profile} onDone={() => setFinished(true)} />;
  }
  return <><Shell /><StudioTour firstRun={finished || Boolean(config.alphaOnboarding?.completed)} /></>;
}

export default function App() {
  return <StoreProvider><ProjectsProvider><Launch /></ProjectsProvider></StoreProvider>;
}
