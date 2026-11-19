import { useEffect, useState } from "react";
import { TourSpotlight } from "@/components/TourSpotlight";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { useStore, type Action } from "@/state/store";
import { tourEvent, tourKey } from "@/lib/workspaceOnboarding";
import { cn } from "@/lib/cn";

const tour = [
  { title: "Buddies and chats", target: "conversations", copy: "Open a Buddy to give it a prompt. Use Buddy settings to change its role or model." },
  { title: "Rooms and mentions", target: "new", copy: "Create a room from the sidebar when a task needs several Buddies. Mention a Buddy with @ to involve it." },
  { title: "Projects and files", target: "projects", copy: "Register a project folder and reference it with # in a prompt.", action: { type: "toggleProjects", open: true } },
  { title: "Tasks", target: "tasks", copy: "Use the task board to capture work and assign it to a Buddy.", action: { type: "toggleTaskBoard", open: true } },
  { title: "Studio Preview", target: "preview", copy: "Open web pages and project files next to your work.", action: { type: "togglePreview", open: true } },
  { title: "Schedules", target: "schedules", copy: "Set a prompt to run once or on a recurring cadence.", action: { type: "toggleSchedules", open: true } },
  { title: "Apps", target: "apps", copy: "See which desktop apps Buddies can use and how to connect them.", action: { type: "toggleApps", open: true } },
  { title: "Settings", target: "settings", copy: "Review your profile, models, and preferences. You can restart this tour in System settings.", action: { type: "toggleAppSettings", open: true, tab: "system" } },
] satisfies Array<{ title: string; target: string; copy: string; action?: Action }>;

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

  const readyBuddy = state.bots.find((buddy) =>
    !buddy.hidden &&
    state.instances.some(
      (engine) =>
        engine.instanceId === buddy.modelSelection.instanceId &&
        engine.snapshot.state === "available" &&
        engine.snapshot.authenticated !== false,
    ),
  );

  const startWorking = () => {
    if (readyBuddy) dispatch({ type: "select", id: readyBuddy.id });
    else dispatch({ type: "toggleAppSettings", open: true, tab: "models" });
    finish();
  };

  if (position === -2) return null;
  const step = tour[position];

  return (
    <>
    {step && <TourSpotlight target={step.target} />}
    <aside
      aria-label="Studio tour"
      className="fixed inset-x-3 bottom-3 z-40 max-w-[396px] rounded-2xl border border-white/[0.1] bg-panel/95 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.65)] backdrop-blur-xl sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div aria-live="polite" className="min-w-0">
          {step ? (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-accent-border">
                {position + 1} / {tour.length}
              </span>
              <div className="flex flex-1 items-center gap-1" aria-hidden="true">
                {tour.map((item, idx) => (
                  <span
                    key={item.title}
                    className={cn(
                      "h-1 flex-1 rounded-full transition-colors",
                      idx <= position ? "bg-accent" : "bg-white/[0.12]",
                    )}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/12 px-2.5 py-0.5 text-[11px] font-semibold text-accent-border">
              <Sparkles size={11} aria-hidden="true" />
              Quick tour
            </div>
          )}
          <h2 className="text-[15px] font-semibold text-ink">{step?.title ?? "Explore your new workspace"}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
            {step?.copy ?? "Take a short walk through Buddies, rooms, Preview, tasks, and schedules."}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss tour"
          className="cursor-pointer rounded-full p-1.5 text-ink-secondary transition-colors hover:bg-white/[0.08] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          onClick={finish}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {position === -1 && (
          <button
            type="button"
            className="cursor-pointer rounded-full px-3.5 py-2 text-[13px] font-medium text-ink-secondary transition-colors hover:bg-white/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            onClick={finish}
          >
            Skip for now
          </button>
        )}
        {position > 0 && (
          <button
            type="button"
            className="cursor-pointer rounded-full px-3.5 py-2 text-[13px] font-medium text-ink-secondary transition-colors hover:bg-white/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => navigate(position - 1)}
          >
            Back
          </button>
        )}
        {position < tour.length - 1 ? (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => navigate(position + 1)}
          >
            {position === -1 ? "Start tour" : "Next"}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={startWorking}
          >
            {readyBuddy ? "Open Buddy chat" : "Set up an AI model"}
          </button>
        )}
      </div>
    </aside>
    </>
  );
}
