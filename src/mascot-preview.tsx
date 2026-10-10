import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EYE_SCALE,
  MausAvatar,
  MOUTH_WEIGHT,
  type MausAvatarHandle,
} from "@/components/Avatar";
import {
  MAUS_COLOR_NAMES,
  MAUS_COLORS,
  MAUS_MOTIONS,
  PICKABLE_STATES,
  STATE_GROUPS,
  type MausColor,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import { EXPRESSION_COUNT } from "@/components/CursorAvatar";
import "./styles.css";
import "./mascot-preview.css";

interface ScenarioLabels extends Partial<Record<MausState, string>> {}

const SCENARIOS: ScenarioLabels = {
  idle: "General / admin",
  happy: "Support / guide",
  curious: "Awaiting input",
  drowsy: "Overnight / async",
  working: "Code / build",
  thinking: "Research / strategy",
  listening: "Dictation / voice",
  sleeping: "Paused / stopped",
  suspicious: "Review / audit",
  proud: "Task completed",
};

const MOTION_SCENARIOS = {
  arrive: "New bot created",
  switch: "Active bot changed",
  customize: "Appearance updated",
  alert: "Needs attention",
  thinking: "Waiting for input",
  working: "Task in progress",
  launch: "Computer starting",
  success: "Step completed",
  celebrate: "Turn finished",
  blink: "New reply",
  surprise: "Unread update",
  failure: "Action failed",
} satisfies Record<Exclude<MausMotion, "none">, string>;

const MOTION_COLORS: MausColor[] = [
  "green", "blue", "purple", "red", "cyan", "orange",
  "teal", "green", "pink", "yellow", "coral", "red",
];

type Tuning = {
  eyeScale: number;
  mouthStroke: number;
  spring: number;
  turn: number;
  gazeX: number;
  gazeY: number;
};

const DEFAULTS: Tuning = {
  eyeScale: EYE_SCALE,
  mouthStroke: MOUTH_WEIGHT,
  spring: 7,
  turn: 0,
  gazeX: 0,
  gazeY: 0,
};

const SLIDERS: { key: keyof Tuning; min: number; max: number; step: number; hint: string }[] = [
  { key: "eyeScale", min: 0.4, max: 2, step: 0.01, hint: "eye size" },
  { key: "mouthStroke", min: 2, max: 26, step: 0.5, hint: "mouth thickness" },
  { key: "spring", min: 2, max: 20, step: 0.5, hint: "morph stiffness" },
  { key: "turn", min: -180, max: 180, step: 1, hint: "head turn — body stays still" },
  { key: "gazeX", min: -1, max: 1, step: 0.01, hint: "gaze across" },
  { key: "gazeY", min: -1, max: 1, step: 0.01, hint: "gaze up/down" },
];

function Tuner({
  tuning,
  setTuning,
  state,
  setState,
  expression,
  setExpression,
  color,
  setColor,
  forward,
  setForward,
}: {
  tuning: Tuning;
  setTuning: (t: Tuning) => void;
  state: MausState;
  setState: (s: MausState) => void;
  expression: number | undefined;
  setExpression: (e: number | undefined) => void;
  color: MausColor;
  setColor: (c: MausColor) => void;
  forward: boolean;
  setForward: (v: boolean) => void;
}) {
  const handle = useRef<MausAvatarHandle>(null);
  const changed = (Object.keys(DEFAULTS) as (keyof Tuning)[]).filter(
    (k) => tuning[k] !== DEFAULTS[k],
  );

  return (
    <section className="tuner">
      <div className="tuner-stage">
        <MausAvatar
          ref={handle}
          color={color}
          state={state}
          expression={expression}
          size={300}
          label={`${state} maus`}
          eyeScale={tuning.eyeScale}
          mouthStroke={tuning.mouthStroke}
          spring={tuning.spring}
          turn={tuning.turn}
          forward={forward}
          gaze={{ x: tuning.gazeX, y: tuning.gazeY }}
        />
        <div className="tuner-readout">
          <strong>{state}</strong>
          <span>{expression === undefined ? "drifting" : `pinned ${expression}`}</span>
        </div>
        <div className="tuner-buttons">
          <button type="button" onClick={() => handle.current?.blink()}>Blink</button>
          <button type="button" onClick={() => handle.current?.spin(900)}>Spin</button>
          <button
            type="button"
            className={forward ? "on" : ""}
            onClick={() => setForward(!forward)}
          >
            Forward
          </button>
          <button type="button" onClick={() => setTuning(DEFAULTS)}>Reset</button>
        </div>
      </div>

      <div className="tuner-controls">
        <div className="tuner-block">
          <h3>Geometry</h3>
          {SLIDERS.map(({ key, min, max, step, hint }) => (
            <label className="tuner-slider" key={key}>
              <span className="tuner-slider-name">
                {key}
                <em>{hint}</em>
              </span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={tuning[key]}
                onChange={(e) => setTuning({ ...tuning, [key]: Number(e.target.value) })}
              />
              <output>{tuning[key]}</output>
            </label>
          ))}
        </div>

        <div className="tuner-block">
          <h3>Values to keep</h3>
          <pre className="tuner-code">
            {changed.length === 0
              ? "// defaults — nothing to change"
              : changed.map((k) => `${k}: ${tuning[k]},`).join("\n")}
          </pre>

          <h3>Colour</h3>
          <div className="chips">
            {MAUS_COLOR_NAMES.map((c) => (
              <button
                key={c}
                type="button"
                className={c === color ? "on" : ""}
                onClick={() => setColor(c)}
              >
                <span className="swatch" style={{ background: MAUS_COLORS[c] }} />
                {c}
              </button>
            ))}
          </div>

          <h3>Expression pin</h3>
          <div className="chips">
            <button
              type="button"
              className={expression === undefined ? "on" : ""}
              onClick={() => setExpression(undefined)}
            >
              auto
            </button>
            {Array.from({ length: EXPRESSION_COUNT }, (_, i) => (
              <button
                key={i}
                type="button"
                className={expression === i ? "on" : ""}
                onClick={() => setExpression(i)}
              >
                {String(i).padStart(2, "0")}
              </button>
            ))}
          </div>

          {Object.entries(STATE_GROUPS).map(([group, names]) => (
            <div key={group}>
              <h3>{group}</h3>
              <div className="chips">
                {names.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={state === name ? "on" : ""}
                    onClick={() => {
                      setState(name);
                      setExpression(undefined);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MotionCard({
  motion,
  index,
  replayAll,
  color,
}: {
  motion: Exclude<MausMotion, "none">;
  index: number;
  replayAll: number;
  color: MausColor;
}) {
  const [replayOne, setReplayOne] = useState(0);

  return (
    <article className="motion-card">
      <div className="motion-stage">
        <MausAvatar
          color={color ?? MOTION_COLORS[index]}
          state="idle"
          size={172}
          motion={motion}
          motionKey={replayAll * 100 + replayOne}
          label={`${motion} motion`}
        />
      </div>
      <footer className="motion-meta">
        <div>
          <span className="motion-number">{String(index + 1).padStart(2, "0")}</span>
          <h2>{motion}</h2>
          <p>{MOTION_SCENARIOS[motion]}</p>
        </div>
        <button type="button" onClick={() => setReplayOne((value) => value + 1)}>
          Replay
        </button>
      </footer>
    </article>
  );
}

function Preview() {
  const [replayAll, setReplayAll] = useState(0);
  const [tuning, setTuning] = useState<Tuning>(DEFAULTS);
  const [state, setState] = useState<MausState>("idle");
  const [expression, setExpression] = useState<number | undefined>(undefined);
  const [color, setColor] = useState<MausColor>("green");
  const [forward, setForward] = useState(true);

  useEffect(() => {
    const interval = window.setInterval(() => setReplayAll((value) => value + 1), 4600);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <main className="preview-shell">
      <header className="preview-header">
        <div>
          <p className="eyebrow">Morphing face engine · 25 expressions · 39 states</p>
          <h1>Maus motion library</h1>
          <p className="intro">
            The app&rsquo;s lit body with the face engine behind it. Expressions morph on a
            spring, blink on each state&rsquo;s own rhythm, and the eyes wrap around an implied
            sphere so a turn reads as a head turning — the silhouette itself never rotates.
          </p>
        </div>
        <button className="replay-all" type="button" onClick={() => setReplayAll((v) => v + 1)}>
          <span aria-hidden="true">↻</span>
          Replay all motions
        </button>
      </header>

      <Tuner
        tuning={tuning}
        setTuning={setTuning}
        state={state}
        setState={setState}
        expression={expression}
        setExpression={setExpression}
        color={color}
        setColor={setColor}
        forward={forward}
        setForward={setForward}
      />

      <section className="motion-grid" aria-label="Mascot motion library">
        {MAUS_MOTIONS.map((motion, index) => (
          <MotionCard
            key={motion}
            motion={motion}
            index={index}
            replayAll={replayAll}
            color={MOTION_COLORS[index]}
          />
        ))}
      </section>

      <section className="expression-library" aria-labelledby="expression-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Identity system · 100 combinations</p>
            <h2 id="expression-heading">Colors and states</h2>
          </div>
          <p>Move your pointer over any Maus to test the responsive eyes.</p>
        </div>

        <div className="matrix-wrap">
          <div className="matrix">
            <div className="corner-label">Color ↓ / state →</div>
            {PICKABLE_STATES.map((s) => (
              <div className="column-label" key={s}>
                <strong>{s}</strong>
                <span>{SCENARIOS[s]}</span>
              </div>
            ))}

            {MAUS_COLOR_NAMES.map((c) => (
              <div className="matrix-row" key={c}>
                <div className="row-label">
                  <span className="swatch" style={{ background: MAUS_COLORS[c] }} />
                  <strong>{c}</strong>
                  <code>{MAUS_COLORS[c]}</code>
                </div>
                {PICKABLE_STATES.map((s) => (
                  <div className="mascot-cell" key={`${c}-${s}`}>
                    <MausAvatar color={c} state={s} size={86} label={`${c} ${s} maus`} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
