// Dev-only gallery of the welcome flow's beats, served at /onboarding-preview.html; not in the packaged app.
import { StrictMode, useEffect, useState } from "react";
import type { CloudOffer } from "../electron/cloud-home.mjs";
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { WelcomeFlow } from "@/components/onboarding/WelcomeFlow";
import { Select } from "@/components/Select";
import type { MausMotion } from "@/lib/mascot";
import { type BeatId, beatsFor } from "@/lib/onboarding";
import type { SetupImportClient } from "@/lib/setup-import";
import { SKINS, type SkinId } from "@/lib/skins";
import { StoreProvider } from "@/state/store";
import type { SetupDetection, SetupImportResult } from "../shared/setup-import";
import "./styles.css";

const BEATS = beatsFor({ dictation: true, setupImport: true, cloud: true });

/** The Cloud beat's stand-in for the Admin's offer (the app reads its own). */
const PREVIEW_CLOUD_OFFER: CloudOffer = { recommended: "pro", creditUsd: 5, reminderDays: 1, refundDays: 14, plans: [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 3 }, { tier: "pro", label: "Pro", amount: 4900, trialDays: 3 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 3 }] };

// A fixture: the preview never looks at this computer's own skills or MCP servers.
const PREVIEW_DETECTION: SetupDetection = {
  skills: Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i + 1}`, source: "claudeCode" as const })),
  tools: [
    { name: "github", source: "claudeCode" },
    { name: "linear", source: "claudeCode" },
    { name: "notion", source: "cursor" },
    { name: "figma", source: "cursor" },
  ],
};

/** ?import=notes answers with something left out; ?import=fail fails. */
function previewImport(mode: string | null): SetupImportClient {
  return {
    detect: async () => PREVIEW_DETECTION,
    apply: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (mode === "fail") throw new Error("fixture failure");
      const notes = mode === "notes";
      const result: SetupImportResult = {
        ...(request.skills ? { skills: { added: PREVIEW_DETECTION.skills.slice(notes ? 1 : 0).map((skill) => skill.name), present: [], skipped: notes ? [{ name: "skill-1", reason: "conflict" as const }] : [], filesLeftOut: notes ? 2 : 0, review: notes ? ["skill-2"] : [] } } : {}),
        ...(request.tools ? { tools: { added: ["github", "linear", "notion", "figma"], present: [], skipped: [] } } : {}),
      };
      return result;
    },
  };
}

/** ?beat=engines&skin=linen&reduced=1&all=1 opens any state directly; ?w=390&h=760 sizes the stage like a narrow window. */
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
    importMode: params.get("import"),
    size: { width: Number(params.get("w")) || 1100, height: Number(params.get("h")) || 720 },
  };
}

function Stage({ skin, beat, run, scale = 1, entrance, importMode = null }: { skin: SkinId; beat: BeatId; run: number; scale?: number; entrance: Exclude<MausMotion, "none">; importMode?: string | null }) {
  const { width, height } = fromUrl().size;
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
          cloudOffer={PREVIEW_CLOUD_OFFER}
          onDone={() => {}}
          setupImport={{ client: previewImport(importMode), detection: PREVIEW_DETECTION }}
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

  // ?debug=1 logs what the guide's face was drawn as, for headless runs.
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

  return (
    <div data-skin="midnight" className="min-h-screen bg-app p-6 text-ink">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-2 text-[18px] font-semibold">Welcome flow</h1>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          Beat
          <Select size="sm" value={beat} onChange={(e) => setBeat(e.target.value as BeatId)}>
            {BEATS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          Skin
          <Select size="sm" value={skin} onChange={(e) => setSkin(e.target.value as SkinId)} disabled={all}>
            {SKINS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
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
              <Stage skin={s.id} beat={beat} run={run} scale={0.42} entrance={initial.entrance} importMode={initial.importMode} />
            </div>
          ))}
        </div>
      ) : (
        <Stage skin={skin} beat={beat} run={run} entrance={initial.entrance} importMode={initial.importMode} />
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
