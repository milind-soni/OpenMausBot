import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotAvatar, MausAvatar } from "../components/Avatar";
import { MASCOT_BODIES, MASCOT_BODY_IDS, type MascotBodyId } from "../../shared/mascot-bodies";
import { MAUS_COLORS, MAUS_COLOR_NAMES, PICKABLE_STATES, stateForBot, type MascotBotProfile, type MausColor, type MausMotion, type MausState } from "../lib/mascot";
import "../styles.css";

const PHASES: { title: string; description: string; duration?: number; patch: Partial<MascotBotProfile> }[] = [
  { title: "At rest", description: "Scout wears its chosen resting expression.", patch: {} },
  { title: "Thinking", description: "A new task starts with reasoning.", patch: { busy: true, activity: "working", messages: [{ kind: "text" }] } },
  { title: "Using a tool", description: "The tool remains active for six seconds in this simulation.", duration: 6200, patch: { busy: true, activity: "working", messages: [{ kind: "activity", tool: {} }] } },
  { title: "Reviewing the result", description: "The tool finished; the bot continues reasoning.", patch: { busy: true, activity: "working", messages: [{ kind: "activity", tool: { ok: true } }] } },
  { title: "Waiting for you", description: "The task needs your input before it can continue.", patch: { busy: true, activity: "waiting-on-you", messages: [{ kind: "activity", tool: {} }] } },
  { title: "Back to work", description: "Input received. The next tool is running.", patch: { busy: true, activity: "working", messages: [{ kind: "activity", tool: {} }] } },
  { title: "New result", description: "The completed task has an unread update.", patch: { unread: true, messages: [{ kind: "text" }] } },
  { title: "Restored identity", description: "The update is read and the chosen resting face returns.", patch: {} },
  { title: "Tool error", description: "A failed tool needs attention.", patch: { messages: [{ kind: "activity", tool: { ok: false } }] } },
  { title: "Canceled", description: "Canceling returns the bot to rest.", patch: {} },
  { title: "Retrying", description: "A retry begins a fresh reasoning phase.", patch: { busy: true, activity: "working", messages: [{ kind: "text" }] } },
  { title: "Signal lost", description: "The running task has stopped reporting its status.", patch: { busy: true, activity: "no-signal" } },
  { title: "Process stopped", description: "The process ended and is no longer working.", patch: { activity: "dead" } },
  { title: "A new turn", description: "New work takes priority over the previous outcome.", patch: { busy: true, activity: "working", messages: [{ kind: "text" }] } },
];
const REACTIONS: { title: string; motion: MausMotion }[] = [
  { title: "Celebrate", motion: "celebrate" }, { title: "Success", motion: "success" },
  { title: "Customize", motion: "customize" }, { title: "Surprise", motion: "surprise" },
  { title: "Failure", motion: "failure" }, { title: "Clear reaction", motion: "none" },
];

function Demo() {
  const [body, setBody] = useState<MascotBodyId>("hexagon");
  const [color, setColor] = useState<MausColor>("green");
  const [expression, setExpression] = useState<MausState>("sleeping");
  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [animated, setAnimated] = useState(true);
  const [light, setLight] = useState(false);
  const [reaction, setReaction] = useState<{ motion: MausMotion; key: number }>({ motion: "none", key: 0 });
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (phase === PHASES.length - 1) setPlaying(false);
      else setPhase(phase + 1);
    }, PHASES[phase].duration ?? 2400);
    return () => clearTimeout(timer);
  }, [playing, phase]);
  const fire = (motion: MausMotion) => setReaction(previous => ({ motion, key: previous.key + 1 }));
  const selectPhase = (index: number) => { setPlaying(false); setPhase(index); fire("none"); };
  const bot = { name: "Scout", color, mascotBody: body, mascotExpression: expression,
    busy: false, unread: false, activity: "idle" as const, messages: [], ...PHASES[phase].patch };
  const activeState = stateForBot(bot);
  const button = "rounded-lg border border-hairline px-3 py-2 text-sm hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const selected = "bg-raised ring-1 ring-accent-border";
  return <main data-skin={light ? "daylight" : "midnight"} className="h-screen overflow-y-auto bg-app text-ink">
    <div className="mx-auto max-w-6xl px-5 py-5 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-4">
        <a className="flex items-center gap-2 font-semibold" href="https://github.com/milind-soni/OpenMausBot"><MausAvatar color="green" bodyId="hexagon" size={28} animated={false} />OpenMausBot</a>
        <div className="flex items-center gap-4 text-sm"><span className="text-ink-secondary">Independent contribution preview</span><button className={button} onClick={() => setLight(!light)}>{light ? "Dark theme" : "Light theme"}</button></div>
      </header>
      <div className="py-4"><p className="mb-3 text-xs font-medium uppercase tracking-widest text-ink-secondary">Interactive avatar demo</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">One bot. Every state.</h1>
        <p className="mt-3 max-w-2xl text-ink-secondary">Explore expressions, changing silhouettes and movement through a complete task. This standalone preview uses the real avatar components with synthetic data.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
        <section className="rounded-2xl border border-hairline bg-panel p-5" aria-label="Live avatar">
          <div className="flex justify-between text-sm"><strong>Scout</strong><span className="text-ink-secondary">{MASCOT_BODIES[body].name} · {color}</span></div>
          <div className="flex h-36 items-center justify-center" data-testid="demo-avatar"><BotAvatar bot={bot} state={activeState} size={160} animated={animated} motion={reaction.motion} motionKey={reaction.key} /></div>
          <div className="text-center" aria-live="polite"><p className="text-lg font-medium">{PHASES[phase].title}</p><p className="mt-1 text-sm text-ink-secondary">{PHASES[phase].description}</p></div>
          <div className="mt-6 flex items-end justify-around border-t border-hairline pt-5">{[32, 56, 112].map(size => <div key={size} className="text-center"><MausAvatar color={color} bodyId={body} state={activeState} busy={bot.busy} activity={bot.activity} size={size} animated={animated} motion={reaction.motion} motionKey={reaction.key} /><p className="mt-2 text-xs text-ink-secondary">{size}px</p></div>)}</div>
          <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={animated} onChange={event => setAnimated(event.target.checked)} />Animate avatars</label>
          {reduced && <p className="mt-2 text-xs text-ink-secondary">Your browser requests reduced motion. Avatars show their resting poses.</p>}
        </section>
        <section className="space-y-4 rounded-2xl border border-hairline bg-panel p-5" aria-label="Appearance controls">
          <div><h2 className="mb-2 font-medium">Shape <span className="text-sm font-normal text-ink-secondary">/ {MASCOT_BODY_IDS.length} silhouettes</span></h2><div className="grid grid-cols-4 gap-2 sm:grid-cols-5">{MASCOT_BODY_IDS.map(id => <button key={id} className={`${button} ${body === id ? selected : ""}`} aria-pressed={body === id} onClick={() => setBody(id)}><MausAvatar color={color} bodyId={id} size={30} animated={false} /><span className="mt-1 block text-xs">{MASCOT_BODIES[id].name}</span></button>)}</div></div>
          <div><h2 className="mb-2 font-medium">Color</h2><div className="flex flex-wrap gap-2">{MAUS_COLOR_NAMES.map(candidate => <button key={candidate} className={`rounded-full border-2 p-1 ${candidate === color ? "border-ink" : "border-transparent"}`} aria-label={`Use ${candidate}`} aria-pressed={candidate === color} onClick={() => setColor(candidate)}><span className="block h-6 w-6 rounded-full" style={{ background: MAUS_COLORS[candidate] }} /></button>)}</div></div>
          <div><h2 className="mb-2 font-medium">Resting expression</h2><div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{PICKABLE_STATES.map(candidate => <button key={candidate} className={`${button} ${expression === candidate ? selected : ""}`} aria-pressed={expression === candidate} onClick={() => setExpression(candidate)}><MausAvatar color={color} bodyId={body} state={candidate} size={32} animated={false} /><span className="mt-1 block text-xs capitalize">{candidate}</span></button>)}</div><p className="mt-3 text-xs text-ink-secondary">Appearance changes preserve the current task and playback. Your chosen expression appears at rest; reactions have separate controls below.</p></div>
        </section>
      </div>
      <section className="mt-6 rounded-2xl border border-hairline bg-panel p-6" aria-label="Task simulation">
        <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="font-semibold">Follow a task</h2><p className="mt-1 text-sm text-ink-secondary">Step {phase + 1} of {PHASES.length} · Pick any phase or play the sequence.</p></div>
          <div className="flex gap-2"><button className={`${button} bg-raised`} onClick={() => { if (!playing && phase === PHASES.length - 1) setPhase(0); fire("none"); setPlaying(!playing); }}>{playing ? "Pause sequence" : "Play sequence"}</button><button className={button} onClick={() => selectPhase(0)}>Restart</button></div>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{PHASES.map((step, index) => <button key={step.title} data-testid={`demo-phase-${index}`} className={`${button} flex items-center gap-3 text-left ${phase === index ? selected : ""}`} aria-current={phase === index ? "step" : undefined} onClick={() => selectPhase(index)}><span className="text-xs tabular-nums text-ink-secondary">{String(index + 1).padStart(2, "0")}</span><span>{step.title}</span></button>)}</div>
        <details className="mt-5 text-xs text-ink-secondary"><summary className="cursor-pointer">Inspect synthetic state</summary><pre className="mt-3 overflow-auto">{JSON.stringify({ phase: phase + 1, selectedState: activeState, bot }, null, 2)}</pre></details>
      </section>
      <section className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-hairline bg-panel p-5" aria-label="Reactions"><h2 className="mr-2 font-medium">Try a reaction</h2>{REACTIONS.map(beat => <button key={beat.motion} className={button} onClick={() => fire(beat.motion)}>{beat.title}</button>)}</section>
      <footer className="flex flex-wrap justify-between gap-3 py-7 text-xs text-ink-secondary"><p>Independent contribution demo · Synthetic data · No account or server connection</p><a className="underline underline-offset-4" href="https://github.com/milind-soni/OpenMausBot">View the upstream project</a></footer>
    </div>
  </main>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<Demo />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
