// The "they have hands" scene. One authored moment: the screen waking from
// black to a live desktop, and the bot's pointer clicking a real button on
// it. Setup is the chat with the ask and the Computer panel sliding in from
// the right, drawn as ComputerPanel draws it (the view tabs, the preview
// status, Open live desktop and Take control). Resolution is the click
// landing, the tool chip in the chat, and the reply.
import { useEffect, useState } from "react";
import { Check, ExternalLink, Hand, Loader2, MousePointer2, Settings2, X } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { reducedMotion } from "@/lib/onboarding";
import type { SceneProps } from "./OrbitingApps";

const HANDS_MS = 6400;

const ASK = "Book the 3 pm slot on the clinic's site.";
const REPLY = "Booked. 3:00 pm, confirmation #4821.";

/** Beats, in ms from play. */
const PANEL_AT = 500;
const WAKE_AT = 1600;
const MOVE_AT = 2500;
const CLICK_AT = 3500;
const DONE_AT = 4300;
const REPLY_AT = 5000;

type Phase = "chat" | "panel" | "awake" | "moving" | "clicked" | "done" | "reply";
const ORDER: Phase[] = ["chat", "panel", "awake", "moving", "clicked", "done", "reply"];
const reached = (phase: Phase, target: Phase) => ORDER.indexOf(phase) >= ORDER.indexOf(target);

const TABS = ["Computer", "Android", "Browser", "Routines"];

export function Hands({ playing, onCue, onEnded, label }: SceneProps) {
  const still = reducedMotion() || !playing;
  const [phase, setPhase] = useState<Phase>(still ? "reply" : "chat");

  useEffect(() => {
    if (still) return;
    setPhase("chat");
    onCue?.("listening");
    const timers = [
      setTimeout(() => {
        setPhase("panel");
        onCue?.("loading");
      }, PANEL_AT),
      setTimeout(() => {
        setPhase("awake");
        onCue?.("working");
      }, WAKE_AT),
      setTimeout(() => setPhase("moving"), MOVE_AT),
      setTimeout(() => setPhase("clicked"), CLICK_AT),
      setTimeout(() => {
        setPhase("done");
        onCue?.("proud");
      }, DONE_AT),
      setTimeout(() => setPhase("reply"), REPLY_AT),
      setTimeout(() => onEnded?.(), HANDS_MS),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, still]);

  const panel = reached(phase, "panel");
  const awake = reached(phase, "awake");
  const moving = reached(phase, "moving");
  const clicked = reached(phase, "clicked");
  const done = reached(phase, "done");
  const replied = reached(phase, "reply");
  const busy = awake && !done;

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-inset" role="img" aria-label={label}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,transparent_55%,rgba(0,0,0,0.28)_100%)]" aria-hidden="true" />

      {/* the app: chat on the left, the panel arriving on the right */}
      <div className="animate-rise relative m-4 flex flex-1 overflow-hidden rounded-xl border border-hairline/40 bg-app shadow-[0_18px_44px_-20px_rgba(0,0,0,0.6)]">
        {/* chat */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <MausAvatar color="green" state={busy ? "working" : replied ? "proud" : "happy"} size={18} animated={!still} trackPointer={false} />
              <span className="text-[12px] font-semibold text-ink">Maus</span>
            </div>
            <span className={cn("flex size-6 items-center justify-center rounded-md transition-colors duration-300", panel ? "bg-raised text-accent" : "text-ink-secondary")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
            </span>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-2 px-3 pb-2.5">
            <div className="flex justify-end">
              <div className="max-w-[200px] rounded-2xl rounded-br-md bg-bubble-user px-3 py-2 text-[11.5px] leading-snug text-ink shadow-md shadow-black/15">{ASK}</div>
            </div>
            {awake && (
              <div className="animate-rise flex items-start gap-2">
                <MausAvatar color="green" state={busy ? "working" : "proud"} size={22} animated={!still} trackPointer={false} />
                <div className="min-w-0">
                  <div className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-colors duration-300", done ? "bg-success/15 text-success" : "bg-raised text-ink-secondary")}>
                    {done ? <Check size={10} strokeWidth={3} /> : <Loader2 size={10} className="animate-spin" />}
                    {done ? "clicked Book" : clicked ? "clicking Book…" : "using the computer"}
                  </div>
                  {replied && (
                    <div className="animate-spot-in mt-1.5 max-w-[210px] rounded-2xl rounded-tl-md border border-hairline/40 bg-card px-3 py-2 text-[11.5px] leading-relaxed text-ink shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)]">
                      {REPLY}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="mt-1 h-7 rounded-lg border border-hairline/40 bg-inset px-2.5 text-[10.5px] leading-7 text-ink-secondary">Message Maus</div>
          </div>
        </div>

        {/* the Computer panel, as ComputerPanel draws it */}
        <aside
          className={cn(
            "flex w-[58%] shrink-0 flex-col border-l border-hairline/40 bg-panel transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
            panel ? "translate-x-0 opacity-100" : "translate-x-7 opacity-0",
          )}
        >
          <div className="flex items-center justify-between px-2.5 py-2">
            <Settings2 size={13} className="text-ink-secondary" />
            <div className="flex overflow-hidden rounded-md border border-hairline/40">
              {TABS.map((tab, i) => (
                <span key={tab} className={cn("px-2 py-0.5 text-[9px] font-medium", i === 0 ? "bg-raised text-ink" : "text-ink-secondary")}>
                  {tab}
                </span>
              ))}
            </div>
            <X size={13} className="text-ink-secondary" />
          </div>

          {/* the screen */}
          <div className="relative mx-2.5 aspect-[16/10] overflow-hidden rounded-lg border border-hairline/40 bg-black">
            {/* desktop */}
            <div className={cn("absolute inset-0 transition-opacity duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]", awake ? "opacity-100" : "opacity-0")}>
              <div className="absolute inset-0 bg-[linear-gradient(135deg,#1f3a5f_0%,#2a5d8c_45%,#6b3fa0_100%)]" />
              <div className="absolute inset-x-0 top-0 flex h-3 items-center justify-between bg-black/30 px-1.5 text-[6px] text-white/80">
                <span>Ubuntu</span>
                <span className="tabular-nums">14:58</span>
              </div>
              {/* the browser window with the booking form */}
              <div className="absolute left-[10%] right-[10%] top-[16%] bottom-[18%] overflow-hidden rounded-md bg-[#f4f5f7] shadow-[0_10px_30px_-8px_rgba(0,0,0,0.7)]">
                <div className="flex h-3.5 items-center gap-1 bg-[#e4e6ea] px-1.5">
                  <span className="size-1.5 rounded-full bg-[#ff5f57]" />
                  <span className="size-1.5 rounded-full bg-[#febc2e]" />
                  <span className="size-1.5 rounded-full bg-[#28c840]" />
                  <span className="ml-1 flex-1 rounded-sm bg-white px-1 text-[5.5px] leading-[9px] text-[#5f6368]">clinic.example/book</span>
                </div>
                <div className="p-2">
                  <div className="text-[7px] font-semibold text-[#202124]">Book an appointment</div>
                  <div className="mt-1 grid grid-cols-3 gap-1">
                    {["2:30 pm", "3:00 pm", "3:30 pm"].map((slot, i) => (
                      <div key={slot} className={cn("rounded-sm border px-1 py-0.5 text-center text-[6px] tabular-nums", i === 1 ? "border-[#1a73e8] bg-[#e8f0fe] text-[#1a73e8]" : "border-[#dadce0] text-[#5f6368]")}>
                        {slot}
                      </div>
                    ))}
                  </div>
                  <div
                    className={cn(
                      "mt-1.5 flex h-4 w-[52px] items-center justify-center rounded-sm text-[6.5px] font-semibold text-white transition-[background-color,transform] duration-200",
                      done ? "bg-[#1e8e3e]" : "bg-[#1a73e8]",
                      clicked && !done && "scale-95",
                    )}
                  >
                    {done ? "Booked ✓" : "Book"}
                  </div>
                </div>
              </div>
              {/* dock */}
              <div className="absolute bottom-1 left-1/2 flex -translate-x-1/2 gap-1 rounded-md bg-white/15 px-1.5 py-0.5">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="size-2 rounded-sm bg-white/70" />
                ))}
              </div>
              {/* the bot's pointer: a full-size layer, so its percentages are
                  the screen's, gliding from the corner to the Book button */}
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 z-20 transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                  moving ? "translate-x-[15.5%] translate-y-[44%]" : "translate-x-[80%] translate-y-[74%]",
                )}
              >
                {clicked && !done && <span className="absolute -left-1.5 -top-1.5 size-4 animate-ripple rounded-full" />}
                <MousePointer2 size={11} className="text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" fill="#fff" />
              </div>
            </div>
            {/* the screen before it wakes */}
            {!awake && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[9px] text-ink-secondary">
                <Loader2 size={12} className="animate-spin text-accent" />
                {panel ? "Connecting to the screen…" : ""}
              </div>
            )}
          </div>

          {/* status and actions, as the panel shows them */}
          <div className="mx-2.5 mt-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[9.5px] text-ink-secondary">
              <span className={cn("size-1.5 rounded-full transition-colors duration-300", awake ? "bg-success" : "bg-warning animate-status-pulse")} />
              {awake ? "Cloud screen connected" : "Starting…"}
            </div>
            <div className="flex items-center gap-1">
              <span className="flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[9px] text-ink">
                <ExternalLink size={9} /> Open live desktop
              </span>
              <span className="flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[9px] text-ink">
                <Hand size={9} /> Take control
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
