// Dev gallery for the welcome flow, like mascot-preview.html for the mascot:
// every beat, in every skin, with reduced motion on or off, without touching
// the workspace's real onboarding record. Served by Vite in dev at
// /onboarding-preview.html; not part of the packaged app.
//
// The flow talks to whatever harness the dev proxy points at, so the engines
// and phone beats show real data when `pnpm dev:server` is running and their
// empty or error states when it is not. Saving the preview bot fails on
// purpose (there is no such bot), which exercises the exit beat's error path.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { WelcomeFlow } from "@/components/onboarding/WelcomeFlow";
import type { MausMotion } from "@/lib/mascot";
import { type BeatId, beatsFor } from "@/lib/onboarding";
import { SKINS, type SkinId } from "@/lib/skins";
import { StoreProvider, type Bot } from "@/state/store";
import "./styles.css";

const PREVIEW_BOT = {
  id: "preview-bot",
  name: "Maus",
  color: "green",
  soul: "",
} as unknown as Bot;

const BEATS = beatsFor({ dictation: true, reel: true });

/** ?beat=engines&skin=linen&reduced=1&all=1 — so a screenshot script can
 * open any state directly. Unknown values fall back to the defaults. */
function fromUrl() {
  const params = new URLSearchParams(location.search);
  const beat = params.get("beat") as BeatId | null;
  const skin = params.get("skin") as SkinId | null;
  return {
    beat: beat && BEATS.includes(beat) ? beat : ("hello" as BeatId),
    skin: skin && SKINS.some((s) => s.id === skin) ? skin : ("midnight" as SkinId),
    reduced: params.get("reduced") === "1",
    all: params.get("all") === "1",
    entrance: (params.get("entrance") ?? "arrive") as Exclude<MausMotion, "none">,
  };
}

/** One window-sized stage in one skin. The flow fills it via `embedded`. */
function Stage({ skin, beat, run, scale = 1, entrance }: { skin: SkinId; beat: BeatId; run: number; scale?: number; entrance: Exclude<MausMotion, "none"> }) {
  const width = 1100;
  const height = 720;
  return (
    <div
      data-skin={skin}
      className="relative overflow-hidden rounded-xl border border-hairline/40 bg-app"
      style={{ width: width * scale, height: height * scale }}
    >
      <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <WelcomeFlow
          key={`${skin}-${beat}-${run}`}
          embedded
          dictation
          entrance={entrance}
          initialBeat={beat}
          bot={PREVIEW_BOT}
          onDone={() => {}}
        />
      </div>
    </div>
  );
}

function Preview() {
  const initial = fromUrl();
  const [skin, setSkin] = useState<SkinId>(initial.skin);
  const [beat, setBeat] = useState<BeatId>(initial.beat);
  const [reduced, setReduced] = useState(initial.reduced);
  const [all, setAll] = useState(initial.all);
  const [run, setRun] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = reduced ? "true" : "false";
  }, [reduced]);

  // ?debug=1 — after a few seconds, log what the guide's face was drawn as.
  // Lets a headless run inspect the animation loop's output without DevTools.
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("debug")) return;
    const timer = setTimeout(() => {
      const paths = document.querySelectorAll<SVGPathElement>(".welcome-maus svg path");
      paths.forEach((el, i) => {
        console.log(`[maus-debug] path ${i} d=${(el.getAttribute("d") ?? "").slice(0, 60)} transform=${el.getAttribute("transform") ?? ""} opacity=${el.style.opacity}`);
      });
      const groups = document.querySelectorAll<SVGGElement>(".welcome-maus svg g[transform]");
      groups.forEach((el, i) => console.log(`[maus-debug] g ${i} transform=${el.getAttribute("transform")}`));
    }, 3500);
    return () => clearTimeout(timer);
  }, []);

  const control =
    "rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[13px] text-ink focus:border-hairline focus:outline-none";

  return (
    <div data-skin="midnight" className="min-h-screen bg-app p-6 text-ink">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-2 text-[18px] font-semibold">Welcome flow</h1>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          Beat
          <select value={beat} onChange={(e) => setBeat(e.target.value as BeatId)} className={control}>
            {BEATS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          Skin
          <select value={skin} onChange={(e) => setSkin(e.target.value as SkinId)} className={control} disabled={all}>
            {SKINS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All skins
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Reduced motion
        </label>
        <button
          onClick={() => setRun((r) => r + 1)}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
        >
          Replay entrance
        </button>
        <span className="ml-auto text-[12px] text-ink-secondary">
          Use Back / Continue inside the card to walk the real transitions.
        </span>
      </header>

      {all ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
          {SKINS.map((s) => (
            <div key={s.id} className="flex flex-col gap-1.5">
              <div className="text-[12px] text-ink-secondary">{s.name}</div>
              <Stage skin={s.id} beat={beat} run={run} scale={0.42} entrance={initial.entrance} />
            </div>
          ))}
        </div>
      ) : (
        <Stage skin={skin} beat={beat} run={run} entrance={initial.entrance} />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Preview />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  </StrictMode>,
);
