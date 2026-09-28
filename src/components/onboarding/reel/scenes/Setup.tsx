// The /setup scene. One authored moment: "/setup" turns into a command as
// it is typed, and the bot fills in its own profile. Setup is the composer
// (the job typed after the command, the send press); action is the ask
// landing in the chat and the bot answering; resolution is the profile card
// on the right going from placeholders to a configured bot, one row per
// change the bot makes (its name, its schedule, its apps, its folder).
//
// Rows land one at a time because that is what setup really does: each is
// its own tool call, applied or waiting on the user. Values blur in rather
// than cross-fade so a placeholder and a value never show as two objects.
import { useEffect, useState } from "react";
import { ArrowUp, CalendarClock, Check, Folder, Plug } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { ServiceIcon, type ToolkitCard } from "@/components/PluginsPanel";
import { cn } from "@/lib/cn";
import { reducedMotion } from "@/lib/onboarding";
import { api } from "@/state/store";
import type { SceneProps } from "./types";

const SETUP_MS = 6600;

const COMMAND = "/setup";
const JOB = " watch Discord, file bugs in Linear";
const TYPED = COMMAND + JOB;

/** Beats, in ms from play. Type → send → reply → four changes → done. */
const TYPE_AT = 400;
const MS_PER_CHAR = 34;
const SEND_AT = TYPE_AT + TYPED.length * MS_PER_CHAR + 350;
const REPLY_AT = SEND_AT + 650;
const STEP_AT = REPLY_AT + 350;
const STEP_GAP = 420;
const APPS = [
  { slug: "discord", label: "Discord", domain: "discord.com" },
  { slug: "linear", label: "Linear", domain: "linear.app" },
];

type Phase = "compose" | "sent" | "reply" | "configured";

/** Official logos from the catalog, fetched once per session. */
let catalog: Promise<Map<string, ToolkitCard>> | null = null;
function loadCatalog(): Promise<Map<string, ToolkitCard>> {
  catalog ??= api("/api/connectors/catalog")
    .then((d: { cards?: ToolkitCard[] }) => new Map((d.cards ?? []).map((card) => [card.slug, card])))
    .catch(() => new Map<string, ToolkitCard>());
  return catalog;
}

/** The typed text, with the command drawn as a command once it is whole. */
function Typed({ text, caret, sent = false }: { text: string; caret: boolean; sent?: boolean }) {
  const command = text.slice(0, COMMAND.length);
  const whole = command === COMMAND;
  return (
    <span className={cn("text-[12.5px] leading-snug", sent ? "text-[var(--color-bubble-user-ink)]" : "text-ink")}>
      <span
        className={cn(
          "-mx-1 rounded-md px-1 py-px font-mono transition-[background-color,color] duration-200 ease-out",
          sent ? "bg-[color-mix(in_oklab,var(--color-bubble-user-ink)_14%,transparent)]" : whole ? "bg-accent/15 text-accent" : "text-ink",
        )}
      >
        {command}
      </span>
      {text.slice(COMMAND.length)}
      {caret && <span className="animate-caret ml-px inline-block h-[13px] w-[2px] translate-y-[2px] bg-ink" />}
    </span>
  );
}

/** A value that blurs in over its placeholder bar when the change lands. */
function Reveal({ shown, children, bar = "w-20" }: { shown: boolean; children: React.ReactNode; bar?: string }) {
  return (
    <span className="relative inline-flex min-h-[16px] items-center">
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 h-2 rounded-full bg-ink/10 transition-opacity duration-200 ease-out",
          bar,
          shown && "opacity-0",
        )}
      />
      <span
        className={cn(
          "inline-flex items-center gap-1.5 transition-[opacity,filter,transform] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
          shown ? "opacity-100 blur-0" : "translate-y-0.5 opacity-0 blur-[3px]",
        )}
      >
        {children}
      </span>
    </span>
  );
}

function Row({ icon: Icon, label, done, children, bar }: { icon: typeof Folder; label: string; done: boolean; children: React.ReactNode; bar?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <Icon size={14} className={cn("shrink-0 transition-colors duration-300", done ? "text-ink" : "text-ink-secondary/60")} />
      <span className="w-11 shrink-0 text-[11px] text-ink-secondary">{label}</span>
      <span className="min-w-0 flex-1 whitespace-nowrap pr-2 text-[12px] font-medium text-ink">
        <Reveal shown={done} bar={bar}>
          {children}
        </Reveal>
      </span>
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-white transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
          done ? "scale-100 opacity-100" : "scale-75 opacity-0",
        )}
      >
        <Check size={10} strokeWidth={3} />
      </span>
    </div>
  );
}

export function Setup({ playing, onCue, onEnded, label }: SceneProps) {
  const still = reducedMotion() || !playing;
  const [typed, setTyped] = useState(still ? TYPED.length : 0);
  const [phase, setPhase] = useState<Phase>(still ? "configured" : "compose");
  /** How many profile changes have landed: name, schedule, apps, folder. */
  const [steps, setSteps] = useState(still ? 4 : 0);
  const [pressed, setPressed] = useState(false);
  const [logos, setLogos] = useState<Map<string, ToolkitCard>>(new Map());

  useEffect(() => {
    let alive = true;
    void loadCatalog().then((cards) => alive && setLogos(cards));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (still) return;
    setTyped(0);
    setPhase("compose");
    setSteps(0);
    onCue?.("listening");
    const timers = [
      ...Array.from(TYPED, (_, i) => setTimeout(() => setTyped(i + 1), TYPE_AT + i * MS_PER_CHAR)),
      setTimeout(() => setPressed(true), SEND_AT - 120),
      setTimeout(() => {
        setPressed(false);
        setPhase("sent");
        onCue?.("working");
      }, SEND_AT),
      setTimeout(() => setPhase("reply"), REPLY_AT),
      ...[0, 1, 2, 3].map((i) => setTimeout(() => setSteps(i + 1), STEP_AT + i * STEP_GAP)),
      setTimeout(() => {
        setPhase("configured");
        onCue?.("proud");
      }, STEP_AT + 3 * STEP_GAP + 300),
      setTimeout(() => onEnded?.(), SETUP_MS),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, still]);

  const sent = phase !== "compose";
  const replied = phase === "reply" || phase === "configured";
  const configured = phase === "configured";
  const card = (app: (typeof APPS)[number]) => {
    const known = logos.get(app.slug);
    return { label: app.label, logo: known?.logo ?? null, domain: known?.domain ?? app.domain };
  };

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-inset px-6" role="img" aria-label={label}>
      <div className="flex w-full max-w-[608px] items-stretch gap-4">
        {/* the chat: the ask lands above the composer, the bot answers under it */}
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-2.5">
          {sent && (
            <div className="animate-msg-in self-end rounded-2xl rounded-br-md bg-bubble-user px-3 py-2 shadow-md shadow-black/15">
              <Typed text={TYPED} caret={false} sent />
            </div>
          )}
          {sent && (
            <div className="flex items-center gap-2">
              <div className="shrink-0 drop-shadow-[0_6px_14px_rgba(0,0,0,0.35)]">
                <MausAvatar
                  color="green"
                  state={configured ? "proud" : replied ? "writing" : "working"}
                  size={26}
                  animated={!still}
                  trackPointer={false}
                />
              </div>
              {replied ? (
                <div className="animate-spot-in origin-left rounded-2xl rounded-tl-md bg-card px-3 py-2 text-[12.5px] text-ink">
                  Got it. Setting myself up.
                </div>
              ) : (
                <div className="animate-spot-in inline-flex origin-left items-center gap-1 rounded-2xl rounded-tl-md bg-card px-3 py-2.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 rounded-full bg-ink-secondary"
                      style={{ animation: `dot-bob 0.9s ease-in-out ${i * 0.15}s infinite` }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-1 flex items-end gap-2 rounded-2xl border border-hairline/50 bg-card px-3 py-2.5 shadow-lg shadow-black/20">
            <div className="min-h-[34px] min-w-0 flex-1">
              {sent ? (
                <span className="text-[12.5px] text-ink-secondary">Message</span>
              ) : (
                <Typed text={TYPED.slice(0, typed)} caret />
              )}
            </div>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 ease-out",
                !sent && typed > 0 ? "bg-accent text-white" : "bg-raised text-ink-secondary",
                pressed && "scale-90",
              )}
            >
              <ArrowUp size={13} strokeWidth={2.5} />
            </span>
          </div>
        </div>

        {/* the bot's profile, filling itself in as each change lands */}
        <div
          className={cn(
            "w-[264px] shrink-0 rounded-2xl border bg-card px-3.5 py-3 shadow-lg shadow-black/20 transition-[border-color,box-shadow] duration-500 ease-out",
            configured ? "border-success/40 shadow-success/10" : "border-hairline/40",
          )}
        >
          <div className="flex items-center gap-2.5 border-b border-hairline/40 pb-3">
            <MausAvatar color="green" state={configured ? "proud" : sent ? "working" : "idle"} size={34} animated={!still} trackPointer={false} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink">
                <Reveal shown={steps >= 1} bar="w-24">
                  Bug triager
                </Reveal>
              </div>
              <div className="mt-1 text-[10.5px] text-ink-secondary">
                {configured ? "Ready" : sent ? "Setting up…" : "New bot"}
              </div>
            </div>
          </div>
          <Row icon={CalendarClock} label="When" done={steps >= 2}>
            Every 15 min
          </Row>
          <Row icon={Plug} label="Apps" done={steps >= 3} bar="w-14">
            <span className="inline-flex items-center gap-3">
              {APPS.map((app) => (
                <span key={app.slug} className="inline-flex items-center gap-1">
                  <ServiceIcon card={card(app)} className="size-3.5 rounded" />
                  {app.label}
                </span>
              ))}
            </span>
          </Row>
          <Row icon={Folder} label="Folder" done={steps >= 4} bar="w-16">
            <code className="font-mono text-[11.5px]">~/bug-triage</code>
          </Row>
        </div>
      </div>
    </div>
  );
}
