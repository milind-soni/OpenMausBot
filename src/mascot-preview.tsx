// Buddy gallery (mascot-preview.html): every state, color, size and motion,
// for design review and visual QA of the avatar outside the app.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MausAvatar, type MausAvatarHandle } from "@/components/Avatar";
import {
  MAUS_COLOR_NAMES,
  MAUS_COLORS,
  MAUS_MOTIONS,
  STATE_GROUPS,
  type MausColor,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import "./styles.css";
import "./mascot-preview.css";

const SIZES = [16, 24, 28, 40, 64, 112, 184];

function Gallery() {
  const [color, setColor] = useState<MausColor>("mint");
  const [state, setState] = useState<MausState>("idle");
  const [animated, setAnimated] = useState(true);
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  const hero = useRef<MausAvatarHandle>(null);

  return (
    <main className="gallery">
      <h1>Buddies</h1>
      <p>Each state at every size. Live states are what Studio shows while a Buddy works; expressions are resting looks.</p>
      <div className="toolbar">
        {MAUS_COLOR_NAMES.map((c) => (
          <button
            key={c}
            className="swatch"
            title={c}
            aria-label={c}
            aria-pressed={c === color}
            style={{ ["--c" as string]: MAUS_COLORS[c] }}
            onClick={() => setColor(c)}
          />
        ))}
        <label>
          <input type="checkbox" checked={animated} onChange={(e) => setAnimated(e.target.checked)} /> Animated
        </label>
        <button onClick={() => hero.current?.blink()}>Blink</button>
        <button onClick={() => hero.current?.spin(900)}>Spin</button>
      </div>

      <h2>{state} · sizes</h2>
      <div className="sizes">
        {SIZES.map((size) => (
          <figure key={size}>
            <MausAvatar
              ref={size === 184 ? hero : undefined}
              color={color}
              state={state}
              size={size}
              animated={animated}
              motion={motion.kind}
              motionKey={motion.key}
              label={`${state} Buddy`}
            />
            <figcaption>{size}px</figcaption>
          </figure>
        ))}
      </div>

      <h2>Motions</h2>
      <div className="toolbar">
        {MAUS_MOTIONS.map((kind) => (
          <button key={kind} onClick={() => setMotion((m) => ({ kind, key: m.key + 1 }))}>
            {kind}
          </button>
        ))}
      </div>

      {Object.entries(STATE_GROUPS).map(([group, states]) => (
        <section key={group}>
          <h2>{group}</h2>
          <div className="grid">
            {states.map((s) => (
              <button key={s} className="card" aria-pressed={s === state} onClick={() => setState(s)}>
                <MausAvatar color={color} state={s} size={72} animated={animated} />
                <span>{s}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
