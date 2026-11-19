import { useState, type CSSProperties } from "react";
import { ArrowRight, Code2, LayoutTemplate, Pause, Play, Search } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import "./OnboardingWelcome.css";

const sceneCards = [
  {
    id: "design",
    avatar: "blue",
    glow: "rgba(55, 127, 230, 0.28)",
    state: "playful",
    icon: LayoutTemplate,
    dotClass: "bg-sky-400",
    accentText: "text-sky-300",
    action: "Designing",
    task: "Refining flows & layouts",
    avatarSize: 64,
    desktopPos: "lg:top-[10%] lg:right-[5%] xl:top-[11%] xl:right-[8%]",
    motionVars: { "--enter-delay": "90ms", "--float-duration": "6.6s", "--float-delay": "240ms" } as CSSProperties,
  },
  {
    id: "build",
    avatar: "orange",
    glow: "rgba(231, 133, 49, 0.28)",
    state: "working",
    icon: Code2,
    dotClass: "bg-amber-400",
    accentText: "text-amber-300",
    action: "Building",
    task: "Implementing a feature",
    avatarSize: 70,
    desktopPos: "lg:bottom-[10%] lg:left-[5%] xl:bottom-[11%] xl:left-[8%]",
    motionVars: { "--enter-delay": "150ms", "--float-duration": "5.9s", "--float-delay": "700ms" } as CSSProperties,
  },
  {
    id: "research",
    avatar: "purple",
    glow: "rgba(128, 87, 200, 0.28)",
    state: "thinking",
    icon: Search,
    dotClass: "bg-violet-400",
    accentText: "text-violet-300",
    action: "Researching",
    task: "Comparing sources",
    avatarSize: 62,
    desktopPos: "lg:bottom-[11%] lg:right-[5%] xl:bottom-[12%] xl:right-[8.5%]",
    motionVars: { "--enter-delay": "210ms", "--float-duration": "7.1s", "--float-delay": "1100ms" } as CSSProperties,
  },
] as const;

export function OnboardingWelcome({ heading, reducedMotion, onStart }: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  reducedMotion: boolean;
  onStart: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const animated = !reducedMotion && !paused;

  return (
    <main
      className="gbs-welcome fixed inset-0 z-50 flex flex-col overflow-auto"
      data-motion={animated ? "on" : "off"}
    >
      <section
        aria-labelledby="onboarding-title"
        className="relative mx-auto flex min-h-dvh w-full max-w-[1360px] flex-1 flex-col items-center justify-center px-6 py-14 sm:px-10"
      >
        {/* Top-left floating solo Buddy matching the wireframe corner composition */}
        <div
          aria-hidden="true"
          style={{ "--enter-delay": "40ms", "--float-duration": "6.1s", "--float-delay": "0ms" } as CSSProperties}
          className="gbs-float-item pointer-events-auto relative mb-6 hidden lg:absolute lg:top-[12%] lg:left-[10%] lg:mb-0 lg:block xl:top-[14%] xl:left-[14%]"
        >
          <div className="relative flex items-center justify-center">
            <span className="gbs-welcome-buddy-halo" style={{ "--buddy-glow": "rgba(0, 201, 168, 0.26)" } as CSSProperties} />
            <MausAvatar
              size={68}
              color="blue"
              state="curious"
              gaze={{ x: 0.35, y: 0.25 }}
              animated={animated}
              trackPointer={animated}
            />
          </div>
        </div>

        {/* Center hero composition — unobstructed bold title, alpha badge, description & pill CTA */}
        <div className="gbs-welcome-hero relative z-10 flex max-w-[680px] flex-col items-center text-center">
          {/* Compact emblem on smaller screens where the floating corner Buddies move below */}
          <div className="mb-5 flex items-center justify-center lg:hidden" aria-hidden="true">
            <MausAvatar size={54} color="blue" state="curious" animated={animated} trackPointer={animated} />
          </div>

          {/* The title is centred on its own; the version pill hangs beside it without shifting it. */}
          <div className="relative flex flex-col items-center gap-2 sm:block">
            <h1
              ref={heading}
              id="onboarding-title"
              aria-label="Gérer Build Studio (v0.1 Alpha)"
              tabIndex={-1}
              className="gbs-welcome-title font-bold outline-none"
            >
              Gérer Build Studio
            </h1>
            <span
              aria-hidden="true"
              className="gbs-welcome-version inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-accent/35 bg-accent/12 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-accent-border shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] sm:absolute sm:left-full sm:top-1/2 sm:ml-3 sm:-translate-y-1/2"
            >
              v0.1 Alpha
            </span>
          </div>

          <p className="mt-5 max-w-[46ch] text-balance text-[15px] leading-relaxed text-ink-secondary sm:text-[17px]">
            Your desktop hub of AI Buddies. Build a tailored team to plan, code, design, and research in one workspace.
          </p>

          <button
            type="button"
            onClick={onStart}
            className="gbs-welcome-cta group mt-9 inline-flex min-h-12 cursor-pointer items-center justify-center gap-2.5 rounded-full bg-accent px-8 py-3 text-[15px] font-semibold text-white transition-all duration-200 hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            Get started
            <ArrowRight size={17} className="transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        </div>

        {/* Animated Buddy activity nodes — anchored cleanly in the perimeter on desktop,
            and flowing into a balanced responsive grid below the CTA on smaller viewports */}
        <div
          aria-label="Buddies working on different tasks"
          className="mt-12 grid w-full max-w-[780px] gap-4 sm:grid-cols-3 lg:pointer-events-none lg:contents"
        >
          {sceneCards.map(({ id, avatar, glow, state, icon: Icon, dotClass, accentText, action, task, avatarSize, desktopPos, motionVars }) => (
            <div
              key={id}
              style={motionVars}
              className={cn(
                "gbs-float-item relative pt-5 pl-4 lg:pointer-events-auto lg:absolute lg:pt-0 lg:pl-0",
                desktopPos,
              )}
            >
              <div className="gbs-welcome-card relative flex min-w-0 items-center gap-3.5 rounded-2xl py-3.5 pr-4 pl-[4.5rem] lg:w-[274px] lg:py-4 lg:pr-5 lg:pl-[4.75rem]">
                {/* Overlapping scalloped Buddy peeking over the card's top-left corner as sketched */}
                <div
                  className="absolute -top-5 -left-3.5 flex items-center justify-center lg:-top-6 lg:-left-5"
                  aria-hidden="true"
                >
                  <span className="gbs-welcome-buddy-halo" style={{ "--buddy-glow": glow } as CSSProperties} />
                  <MausAvatar
                    size={avatarSize}
                    color={avatar}
                    state={state}
                    animated={animated}
                    trackPointer={animated}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("gbs-live-dot size-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" />
                    <span className="truncate text-[13px] font-semibold text-ink">{action}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-ink-secondary">{task}</p>
                </div>
                <Icon size={15} className={cn("shrink-0 opacity-75", accentText)} aria-hidden="true" />
              </div>
            </div>
          ))}
        </div>

        {/* Accessible pause control for continuous ambient motion (WCAG 2.2.2) */}
        {!reducedMotion && (
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            className="fixed right-4 bottom-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-panel/80 px-3 py-1.5 text-[11px] font-medium text-ink-secondary backdrop-blur-md transition-colors hover:border-white/[0.16] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {paused ? <Play size={11} aria-hidden="true" /> : <Pause size={11} aria-hidden="true" />}
            {paused ? "Play motion" : "Pause motion"}
          </button>
        )}
      </section>
    </main>
  );
}
