import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, setEmailGateDone, initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { TaskBoardScreen } from "@/components/TaskBoardScreen";
import { ProjectsProvider } from "@/state/projects";
import { useQueuedMessageSender } from "@/lib/useQueuedMessageSender";

// Full-page screens outside the chat loop load on first open, keeping them
// out of the startup bundle.
const SettingsScreen = lazy(() => import("@/components/SettingsScreen").then((m) => ({ default: m.SettingsScreen })));
const AppsScreen = lazy(() => import("@/components/AppsScreen").then((m) => ({ default: m.AppsScreen })));
const ProjectsScreen = lazy(() => import("@/components/ProjectsScreen").then((m) => ({ default: m.ProjectsScreen })));

function ScreenFallback() {
  return (
    <div className="flex flex-1 items-center justify-center text-ink-secondary">
      <Loader2 size={18} className="animate-spin" />
    </div>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
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
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      {state.appSettingsOpen ? (
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
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
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

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
    if (!emailGateDone()) {
      fetch("/api/config")
        .then((r) => r.json())
        .then((cfg) => {
          if (cfg?.profile?.email || cfg?.profile?.name) {
            setEmailGateDone("submitted");
            setGated(false);
          }
        })
        .catch(() => {});
    }
  }, []);
  return (
    <StoreProvider>
      <ProjectsProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </ProjectsProvider>
    </StoreProvider>
  );
}
