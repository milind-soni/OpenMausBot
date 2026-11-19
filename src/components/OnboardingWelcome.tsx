import { ArrowRight, Code2, LayoutTemplate, Search } from "lucide-react";
import { MausAvatar } from "./Avatar";
import "./OnboardingWelcome.css";

const activities = [
  { avatar: "orange", state: "working", icon: Code2, action: "Building", task: "Implementing a feature", tone: "build" },
  { avatar: "blue", state: "celebrate", icon: LayoutTemplate, action: "Designing", task: "Refining a layout", tone: "design" },
  { avatar: "purple", state: "thinking", icon: Search, action: "Researching", task: "Comparing sources", tone: "research" },
] as const;

export function OnboardingWelcome({ heading, reducedMotion, onStart }: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  reducedMotion: boolean;
  onStart: () => void;
}) {
  return (
    <main className="alpha-welcome fixed inset-0 z-50 flex flex-col overflow-auto bg-app px-4 py-5 sm:p-8">
      <section aria-labelledby="onboarding-title" className="alpha-welcome-shell mx-auto my-auto grid w-full max-w-[1080px] shrink-0 overflow-hidden rounded-[26px] border border-hairline/80 bg-panel md:grid-cols-[1fr_1fr]">
        <div className="flex flex-col justify-center p-7 sm:p-12 lg:p-14">
          <img src="/app-icon.svg" alt="" className="mb-8 size-12 rounded-xl sm:mb-10 sm:size-14" />
          <h1 ref={heading} id="onboarding-title" aria-label="Gérer Build Studio (v0.1 Alpha)" tabIndex={-1} className="alpha-welcome-title font-bold text-ink outline-none">
            Gérer Build Studio
            <span className="mt-4 block text-sm font-semibold tracking-normal text-ink-secondary">(v0.1 Alpha)</span>
          </h1>
          <p className="mt-5 max-w-[320px] text-base leading-relaxed text-ink-secondary">
            Set up a team of AI Buddies to develop ideas, build projects, and review work in one desktop workspace.
          </p>
          <button type="button" onClick={onStart} className="mt-8 inline-flex min-h-11 w-fit items-center justify-center gap-3 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-border focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
            Get started <ArrowRight size={17} />
          </button>
        </div>

        <div className="alpha-welcome-art relative flex min-h-[310px] items-center justify-center overflow-hidden border-t border-hairline/75 px-6 py-8 sm:px-10 md:min-h-[532px] md:border-t-0 md:border-l" aria-label="Buddies working on different tasks">
          <div className="relative grid w-full max-w-[370px] gap-3 sm:gap-4">
            {activities.map(({ avatar, state, icon: Icon, action, task, tone }) => (
              <div key={action} className={`alpha-activity alpha-activity--${tone} flex items-center gap-3 rounded-2xl border p-3 sm:gap-4 sm:p-4`}>
                <div className="alpha-activity-avatar grid size-12 shrink-0 place-items-center rounded-xl sm:size-14">
                  <MausAvatar size={40} color={avatar} state={state} animated={!reducedMotion} trackPointer={!reducedMotion} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink">{action}</div>
                  <div className="mt-0.5 text-xs leading-snug text-ink-secondary">{task}</div>
                </div>
                <Icon className="alpha-activity-icon shrink-0" size={17} aria-hidden="true" />
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
