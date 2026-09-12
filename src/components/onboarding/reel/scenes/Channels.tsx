// The "put bots in a room" scene. One authored moment: an @mention picks who
// answers. Setup is the room header with its member stack, exactly as
// GroupView draws it; the action is typing "@Res", the mention menu opening
// and Researcher being chosen; the resolution is Researcher lighting up in
// the header and answering while the other two stay quiet.
import { useEffect, useState } from "react";
import { Hash, Send } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import type { MausColor } from "@/lib/mascot";
import { reducedMotion } from "@/lib/onboarding";
import type { SceneProps } from "./OrbitingApps";

const CHANNELS_MS = 6000;

const MEMBERS: Array<{ name: string; title: string; color: MausColor }> = [
  { name: "Maus", title: "Chief of staff", color: "green" },
  { name: "Researcher", title: "Finds and checks facts", color: "blue" },
  { name: "Writer", title: "Drafts and edits", color: "orange" },
];
const RESEARCHER = 1;

const TYPED = "@Res";
const REST = " pull last week's numbers";
const REPLY = "Found them. Revenue up 12% week over week, churn flat. Full table in the folder.";

/** Beats, in ms from play. */
const TYPE_AT = 600;
const MENU_AT = 1150;
const PICK_AT = 1900;
const REST_AT = 2100;
const SEND_AT = 3000;
const THINK_AT = 3300;
const REPLY_AT = 4200;

type Phase = "room" | "typing" | "menu" | "picked" | "rest" | "sent" | "thinking" | "reply";
const ORDER: Phase[] = ["room", "typing", "menu", "picked", "rest", "sent", "thinking", "reply"];
const reached = (phase: Phase, target: Phase) => ORDER.indexOf(phase) >= ORDER.indexOf(target);

function useTypewriter(text: string, active: boolean, still: boolean, charsPerTick = 2, tickMs = 45) {
  const [n, setN] = useState(still ? text.length : 0);
  useEffect(() => {
    if (still) {
      setN(text.length);
      return;
    }
    if (!active) return;
    setN(0);
    const timer = setInterval(() => {
      setN((v) => {
        if (v >= text.length) {
          clearInterval(timer);
          return v;
        }
        return Math.min(text.length, v + charsPerTick);
      });
    }, tickMs);
    return () => clearInterval(timer);
  }, [active, still, text, charsPerTick, tickMs]);
  return text.slice(0, n);
}

export function Channels({ playing, onCue, onEnded, label }: SceneProps) {
  const still = reducedMotion() || !playing;
  const [phase, setPhase] = useState<Phase>(still ? "reply" : "room");

  useEffect(() => {
    if (still) return;
    setPhase("room");
    onCue?.("listening");
    const timers = [
      setTimeout(() => setPhase("typing"), TYPE_AT),
      setTimeout(() => {
        setPhase("menu");
        onCue?.("curious");
      }, MENU_AT),
      setTimeout(() => setPhase("picked"), PICK_AT),
      setTimeout(() => setPhase("rest"), REST_AT),
      setTimeout(() => setPhase("sent"), SEND_AT),
      setTimeout(() => {
        setPhase("thinking");
        onCue?.("working");
      }, THINK_AT),
      setTimeout(() => {
        setPhase("reply");
        onCue?.("proud");
      }, REPLY_AT),
      setTimeout(() => onEnded?.(), CHANNELS_MS),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, still]);

  const typed = useTypewriter(TYPED, phase === "typing" || phase === "menu", still, 1, 110);
  const rest = useTypewriter(REST, reached(phase, "rest") && !reached(phase, "sent"), still, 2, 40);
  const reply = useTypewriter(REPLY, phase === "reply", still, 3, 45);

  const menuOpen = phase === "menu";
  const picked = reached(phase, "picked");
  const sent = reached(phase, "sent");
  const thinking = phase === "thinking";
  const replied = phase === "reply";
  const busy = thinking || (replied && reply.length < REPLY.length);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-inset" role="img" aria-label={label}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,transparent_55%,rgba(0,0,0,0.28)_100%)]" aria-hidden="true" />

      {/* the room, as GroupView draws it */}
      <div className="animate-rise relative m-4 mb-0 flex flex-1 flex-col overflow-hidden rounded-xl border border-hairline/40 bg-app shadow-[0_18px_44px_-20px_rgba(0,0,0,0.6)]">
        <header className="flex items-center justify-between border-b border-hairline/40 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <Hash size={14} className="text-ink-secondary" />
            <span className="text-[13px] font-semibold text-ink">Work</span>
          </div>
          <div className="flex -space-x-2">
            {MEMBERS.map((m, i) => {
              const active = busy && i === RESEARCHER;
              return (
                <span
                  key={m.name}
                  className={cn(
                    "relative inline-flex rounded-full transition-opacity duration-300",
                    active && "z-10 ring-2 ring-accent/50 ring-offset-1 ring-offset-app",
                    busy && i !== RESEARCHER && "opacity-45",
                  )}
                >
                  <MausAvatar color={m.color} state={active ? "working" : "happy"} size={24} animated={!still && active} trackPointer={false} />
                  {active && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-app bg-accent" />}
                </span>
              );
            })}
          </div>
        </header>

        {/* transcript */}
        <div className="relative flex flex-1 flex-col justify-end gap-2.5 px-3.5 pb-2.5">
          {sent && (
            <div className="animate-rise flex justify-end">
              <div className="max-w-[260px] rounded-2xl rounded-br-md bg-bubble-user px-3 py-2 text-[12px] leading-snug text-ink shadow-md shadow-black/15">
                <span className="rounded bg-accent/20 px-1 font-medium text-accent-text">@Researcher</span>
                {REST}
              </div>
            </div>
          )}
          {(thinking || replied) && (
            <div className="animate-rise flex items-start gap-2">
              <div className="mt-0.5 shrink-0 drop-shadow-[0_4px_10px_rgba(0,0,0,0.35)]">
                <MausAvatar color="blue" state={replied ? "writing" : "working"} size={26} animated={!still} trackPointer={false} />
              </div>
              <div className="min-w-0">
                <div className="mb-0.5 text-[10.5px] font-medium text-ink-secondary">Researcher</div>
                {thinking ? (
                  <div className="inline-flex items-center gap-1 rounded-2xl rounded-tl-md bg-card px-3 py-2.5">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="size-1.5 rounded-full bg-ink-secondary" style={{ animation: `dot-bob 0.9s ease-in-out ${i * 0.15}s infinite` }} />
                    ))}
                  </div>
                ) : (
                  <div className="animate-spot-in max-w-[300px] rounded-2xl rounded-tl-md border border-hairline/40 bg-card px-3 py-2 text-[12px] leading-relaxed text-ink shadow-[0_10px_30px_-12px_rgba(0,0,0,0.55)]">
                    {reply}
                    {reply.length < REPLY.length && <span className="animate-caret ml-0.5 inline-block h-[12px] w-[2px] translate-y-[2px] bg-ink" />}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* the mention menu, above the composer */}
          {menuOpen && (
            <div className="animate-spot-in absolute bottom-[48px] left-3.5 z-20 w-[210px] origin-bottom-left rounded-xl border border-hairline/50 bg-panel p-1 shadow-[0_18px_44px_-16px_rgba(0,0,0,0.7)]">
              {[MEMBERS[RESEARCHER]!, MEMBERS[2]!].map((m, i) => (
                <div key={m.name} className={cn("flex items-center gap-2 rounded-lg px-2 py-1", i === 0 ? "bg-accent/10" : "")}>
                  <MausAvatar color={m.color} state="happy" size={20} animated={false} trackPointer={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium text-ink">{m.name}</span>
                    <span className="block truncate text-[9.5px] text-ink-secondary">{m.title}</span>
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] text-ink-secondary">
                <span className="flex size-5 items-center justify-center rounded-full bg-raised text-[10px]">@</span> everyone
              </div>
            </div>
          )}
        </div>

        {/* composer */}
        <div className="m-2.5 mt-0 flex items-center gap-2 rounded-xl border border-hairline/50 bg-inset px-3 py-2">
          <div className="flex min-h-[16px] flex-1 items-center text-[12px] text-ink">
            {sent ? (
              <span className="text-ink-secondary">Message #Work</span>
            ) : (
              <>
                {picked ? <span className="rounded bg-accent/20 px-1 font-medium text-accent-text">@Researcher</span> : <span>{typed}</span>}
                <span>{rest}</span>
                {phase !== "room" && <span className="animate-caret ml-0.5 inline-block h-[12px] w-[2px] bg-ink" />}
              </>
            )}
          </div>
          <Send size={13} className={cn("transition-colors duration-200", picked && !sent ? "text-accent" : "text-ink-secondary")} />
        </div>
      </div>

      {/* the guide keeps its distance: this room belongs to the members */}
      <div className="flex h-11 shrink-0 items-center justify-center">
        <div className="drop-shadow-[0_8px_18px_rgba(0,0,0,0.45)]">
          <MausAvatar color="green" state={replied ? "proud" : busy ? "listening" : "idle"} size={28} animated={!still} trackPointer={false} />
        </div>
      </div>
    </div>
  );
}
