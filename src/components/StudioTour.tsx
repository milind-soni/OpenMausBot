import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { useStore, type Action } from "@/state/store";
import { tourEvent, tourKey } from "@/lib/workspaceOnboarding";

const tour = [
  { title: "Buddies and chats", copy: "Open a Buddy to give it a prompt. Use Buddy settings to change its role or model." },
  { title: "Rooms and mentions", copy: "Create a room from the sidebar when a task needs several Buddies. Mention a Buddy with @ to involve it." },
  { title: "Projects and files", copy: "Register a project folder and reference it with # in a prompt.", action: { type: "toggleProjects", open: true } },
  { title: "Tasks", copy: "Use the task board to capture work and assign it to a Buddy.", action: { type: "toggleTaskBoard", open: true } },
  { title: "Studio Preview", copy: "Open web pages and project files next to your work.", action: { type: "togglePreview", open: true } },
  { title: "Schedules", copy: "Set a prompt to run once or on a recurring cadence.", action: { type: "toggleSchedules", open: true } },
  { title: "Apps", copy: "See which desktop apps Buddies can use and how to connect them.", action: { type: "toggleApps", open: true } },
  { title: "Settings", copy: "Review your profile, models, and preferences. You can restart this tour in System settings.", action: { type: "toggleAppSettings", open: true, tab: "system" } },
] satisfies Array<{ title: string; copy: string; action?: Action }>;

export function StudioTour({ firstRun }: { firstRun: boolean }) {
  const { state, dispatch } = useStore();
  const [position, setPosition] = useState(() => {
    try {
      const stored = localStorage.getItem(tourKey);
      if (stored !== null) {
        const value = Number(stored);
        if (Number.isInteger(value) && value >= -2 && value < tour.length) return value;
      }
    } catch {}
    return firstRun ? -1 : -2;
  });
  useEffect(() => {
    const open = () => setPosition(-1);
    window.addEventListener(tourEvent, open);
    return () => window.removeEventListener(tourEvent, open);
  }, []);
  useEffect(() => {
    if (position === -2 && !firstRun) return;
    try { localStorage.setItem(tourKey, String(position)); } catch {}
  }, [position, firstRun]);

  const navigate = (index: number) => {
    const action = tour[index]?.action;
    if (action) dispatch(action);
    else {
      const buddy = state.bots.find((item) => !item.hidden);
      if (buddy) dispatch({ type: "select", id: buddy.id });
    }
    setPosition(index);
  };
  const finish = () => {
    try { localStorage.setItem(tourKey, "-2"); } catch {}
    setPosition(-2);
  };
  const readyBuddy = state.bots.find((buddy) => !buddy.hidden && state.instances.some((engine) =>
    engine.instanceId === buddy.modelSelection.instanceId && engine.snapshot.state === "available" && engine.snapshot.authenticated !== false,
  ));
  const startWorking = () => {
    if (readyBuddy) dispatch({ type: "select", id: readyBuddy.id });
    else dispatch({ type: "toggleAppSettings", open: true, tab: "models" });
    finish();
  };

  if (position === -2) return null;
  const step = tour[position];
  return (
    <aside aria-label="Studio tour" className="fixed inset-x-3 bottom-3 z-40 max-w-[390px] rounded-xl border border-hairline/60 bg-panel p-4 shadow-2xl sm:inset-x-auto sm:right-6 sm:bottom-6">
      <div className="flex items-start justify-between gap-3">
        <div aria-live="polite">
          {step && <p className="text-xs text-ink-secondary">{position + 1} of {tour.length}</p>}
          <h2 className="font-semibold text-ink">{step?.title ?? "Take a quick tour of Studio"}</h2>
          <p className="mt-1 text-sm text-ink-secondary">{step?.copy ?? "Explore the tools you’ll use to work with your Buddies."}</p>
        </div>
        <button type="button" aria-label="Dismiss tour" className="rounded p-1.5 text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent" onClick={finish}><X size={16} /></button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {position > 0 && <button className="rounded-lg bg-card px-3 py-2 text-sm text-ink" onClick={() => navigate(position - 1)}>Back</button>}
        {position < tour.length - 1 ? (
          <button className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white" onClick={() => navigate(position + 1)}>{position === -1 ? "Start tour" : "Next"} <ArrowRight size={14} /></button>
        ) : (
          <button className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white" onClick={startWorking}>{readyBuddy ? "Open Buddy chat" : "Set up an AI model"}</button>
        )}
        {position === -1 && <button className="rounded-lg px-3 py-2 text-sm text-ink-secondary hover:text-ink" onClick={finish}>Skip for now</button>}
      </div>
    </aside>
  );
}
