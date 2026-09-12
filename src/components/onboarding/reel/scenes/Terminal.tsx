// The "run it from the terminal too" scene. One authored moment: the
// browser window rising out of the terminal, because that is the whole
// promise: same app, text wizard first. The wizard's lines are the real
// ones from server/cli-setup.ts, typed at a human pace, with the picker
// drawn the way Clack draws it.
import { useEffect, useState } from "react";
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { reducedMotion } from "@/lib/onboarding";
import type { SceneProps } from "./OrbitingApps";

const TERMINAL_MS = 6400;

type Line =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string; tone?: "ink" | "dim" | "accent" | "success" }
  | { kind: "pick"; label: string; options: string[]; chosen: number }
  | { kind: "done"; label: string; value: string };

const SCRIPT: Array<{ at: number; line: Line }> = [
  { at: 300, line: { kind: "cmd", text: "npx openmausbot" } },
  { at: 1150, line: { kind: "out", text: "Welcome to OpenMausBot", tone: "ink" } },
  { at: 1350, line: { kind: "out", text: "Let's connect your AI. Choose a provider, then a model.", tone: "dim" } },
  { at: 1800, line: { kind: "pick", label: "Choose your AI connection", options: ["Claude Code", "ChatGPT / Codex", "API key"], chosen: 0 } },
  { at: 2900, line: { kind: "done", label: "Choose your AI connection", value: "Claude Code" } },
  { at: 3150, line: { kind: "done", label: "Choose your model", value: "claude-sonnet" } },
  { at: 3700, line: { kind: "out", text: "Workspace ready → http://127.0.0.1:8799", tone: "success" } },
];

const RISE_AT = 4200;

export function Terminal({ playing, onCue, onEnded, label }: SceneProps) {
  const still = reducedMotion() || !playing;
  const [now, setNow] = useState(still ? TERMINAL_MS : 0);

  useEffect(() => {
    if (still) return;
    setNow(0);
    onCue?.("loading");
    const start = performance.now();
    let frame = 0;
    const tick = () => {
      const t = performance.now() - start;
      setNow(t);
      if (t < TERMINAL_MS) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const cue1 = setTimeout(() => onCue?.("working"), 1800);
    const cue2 = setTimeout(() => onCue?.("happy"), RISE_AT);
    const end = setTimeout(() => onEnded?.(), TERMINAL_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(cue1);
      clearTimeout(cue2);
      clearTimeout(end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, still]);

  // a command types at ~14 chars/s; everything else prints whole
  const typedCmd = (text: string, at: number) => (still ? text : text.slice(0, Math.max(0, Math.floor((now - at) / 70))));
  // the picker's cursor sits on the first option, so it needs no travel
  const lines = SCRIPT.filter((s) => now >= s.at).filter((s) => !(s.line.kind === "pick" && now >= 2900));
  const rising = now >= RISE_AT;

  return (
    <div className="relative h-full w-full overflow-hidden bg-inset" role="img" aria-label={label}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,transparent_55%,rgba(0,0,0,0.28)_100%)]" aria-hidden="true" />

      {/* the terminal */}
      <div
        className={cn(
          "animate-rise absolute inset-x-6 top-4 overflow-hidden rounded-xl border border-hairline/40 bg-[#0b0d10] font-mono text-[11px] leading-[1.6] text-[#d5dbe1] shadow-[0_18px_44px_-20px_rgba(0,0,0,0.7)]",
          "transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]",
          rising && "-translate-y-14 scale-[0.97] opacity-50",
        )}
        style={{ height: 232 }}
      >
        <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3 py-2">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-[10px] text-white/40">zsh</span>
        </div>
        <div className="px-3.5 py-2.5">
          {lines.map(({ at, line }, i) => {
            if (line.kind === "cmd") {
              const text = typedCmd(line.text, at);
              return (
                <div key={i}>
                  <span className="text-[#7fe0b0]">$</span> {text}
                  {text.length < line.text.length && <span className="animate-caret ml-0.5 inline-block h-[11px] w-[6px] translate-y-[2px] bg-[#d5dbe1]" />}
                </div>
              );
            }
            if (line.kind === "out") {
              return (
                <div key={i} className={cn("animate-rise", line.tone === "dim" && "text-white/45", line.tone === "success" && "text-[#7fe0b0]", line.tone === "ink" && "font-semibold text-white")}>
                  {line.text}
                </div>
              );
            }
            if (line.kind === "done") {
              return (
                <div key={i} className="animate-rise">
                  <span className="text-[#7fe0b0]">◇</span> <span className="text-white/60">{line.label}</span> <span className="text-white/30">·</span> {line.value}
                </div>
              );
            }
            return (
              <div key={i} className="animate-rise">
                <div>
                  <span className="text-[#7fc0ff]">◆</span> {line.label}
                </div>
                {line.options.map((option, j) => (
                  <div key={option} className={cn("pl-2", j === line.chosen ? "text-white" : "text-white/40")}>
                    <span className={j === line.chosen ? "text-[#7fc0ff]" : ""}>{j === line.chosen ? "●" : "○"}</span> {option}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* the browser window rising out of it: the same app, first run, as a
          small honest replica of the real shell — sidebar, header, the card */}
      <div
        className={cn(
          "absolute inset-x-10 top-[62px] flex flex-col overflow-hidden rounded-[10px] border border-white/10 bg-[#202124]",
          "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_30px_70px_-20px_rgba(0,0,0,0.8),0_10px_24px_-12px_rgba(0,0,0,0.6)]",
          "transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]",
          rising ? "translate-y-0 scale-100 opacity-100" : "translate-y-[240px] scale-[0.96] opacity-0",
        )}
        style={{ height: 224 }}
        aria-hidden="true"
      >
        {/* browser chrome: a tab strip, then the toolbar with an omnibox */}
        <div className="bg-[#202124]">
          <div className="flex items-end gap-2 px-2.5 pt-1.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
            </div>
            <div className="ml-2 flex h-6 max-w-[150px] items-center gap-1.5 rounded-t-lg bg-[#35363a] px-2.5 text-[9.5px] text-[#e8eaed]">
              <MausAvatar color="green" state="idle" size={10} animated={false} trackPointer={false} />
              <span className="truncate">OpenMausBot</span>
              <span className="ml-1 text-[#9aa0a6]">×</span>
            </div>
            <span className="mb-1 text-[12px] leading-none text-[#9aa0a6]">+</span>
          </div>
          <div className="flex items-center gap-2 bg-[#35363a] px-2.5 py-1.5">
            <div className="flex items-center gap-2 text-[11px] leading-none text-[#9aa0a6]">
              <span>‹</span>
              <span>›</span>
              <span>↻</span>
            </div>
            <div className="flex flex-1 items-center gap-1.5 rounded-full bg-[#202124] px-2.5 py-1 text-[9.5px] tabular-nums text-[#e8eaed]">
              <span className="text-[8px] text-[#9aa0a6]">🔒</span>
              <span className="text-[#9aa0a6]">127.0.0.1</span>
              <span className="text-[#9aa0a6]">:8799</span>
            </div>
            <span className="text-[11px] leading-none tracking-[0.15em] text-[#9aa0a6]">⋮</span>
          </div>
        </div>
        {/* the shell behind the card */}
        <div className="relative flex min-h-0 flex-1 bg-app">
          <div className="flex w-[104px] shrink-0 flex-col border-r border-hairline/40 bg-panel/70 p-2">
            <div className="h-5 rounded-md bg-inset" />
            <div className="mt-2 text-[7.5px] font-semibold uppercase tracking-[0.12em] text-ink-secondary/70">Bots</div>
            <div className="mt-1 flex items-center gap-1.5 rounded-md bg-raised/70 px-1.5 py-1">
              <MausAvatar color="green" state="happy" size={14} animated={false} trackPointer={false} />
              <div className="min-w-0">
                <div className="h-1.5 w-9 rounded bg-ink/70" />
                <div className="mt-1 h-1 w-12 rounded bg-ink-secondary/40" />
              </div>
            </div>
            <div className="mt-auto flex items-center gap-1.5 rounded-md px-1.5 py-1">
              <span className="size-3.5 rounded-full bg-raised" />
              <div className="h-1 w-6 rounded bg-ink-secondary/40" />
            </div>
          </div>
          <div className="relative flex-1">
            <div className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2">
              <MausAvatar color="green" state="happy" size={14} animated={false} trackPointer={false} />
              <div className="h-1.5 w-10 rounded bg-ink/70" />
            </div>
            {/* dimmed shell under the welcome card, as the real first run looks */}
            <div className="absolute inset-0 top-[29px] bg-app/80" />
            <div className="absolute left-1/2 top-[6px] w-[196px] -translate-x-1/2 rounded-xl border border-hairline/50 bg-panel px-4 py-2.5 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.7)]">
              <div className="flex flex-col items-center">
                <MausAvatar color="green" state="happy" size={24} animated={!still} trackPointer={false} />
                <div className="mt-1 text-[10px] font-semibold text-ink">Welcome to OpenMausBot</div>
                <div className="mt-0.5 h-1 w-24 rounded bg-ink-secondary/40" />
                <div className="mt-2 flex h-[18px] w-full items-center rounded-md border border-hairline/40 bg-inset px-2 text-[8px] text-ink-secondary">Your name</div>
                <div className="mt-1 flex h-[18px] w-full items-center rounded-md border border-hairline/40 bg-inset px-2 text-[8px] text-ink-secondary">you@example.com</div>
                <div className="mt-1 flex h-[18px] w-full items-center justify-center rounded-md bg-accent text-[8.5px] font-medium text-white">Continue</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* the guide: loading while the wizard runs, happy when the app opens */}
      <div className="absolute bottom-3 right-5 z-20">
        <div className="drop-shadow-[0_8px_18px_rgba(0,0,0,0.45)]">
          <MausAvatar color="green" state={rising ? "happy" : now > 1800 ? "working" : "loading"} size={36} animated={!still} trackPointer={false} />
        </div>
      </div>
    </div>
  );
}
