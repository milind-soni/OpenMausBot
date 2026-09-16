// Live preview of the dictation pill's new effects, using the EXACT
// BorderBeam/ThinkingOrb props DictationPill.tsx renders — one section per
// pill state. This file exists so the effects can be eyeballed in a browser
// without the Electron bridge (the real pill requires window.ogb), and is
// throwaway: it ships nothing.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Mic } from "lucide-react";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";

// Same convention as the other previews: the app's Tailwind entry, so the
// utility classes below actually render.
import "../styles.css";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <BorderBeam
        size="line"
        colorVariant={label.startsWith("hold") ? "colorful" : "mono"}
        strength={label.startsWith("hold") ? 0.9 : 0.45}
        active={label !== "idle (armed)"}
        className="pill"
      >
        {children}
      </BorderBeam>
    </div>
  );
}

createRoot(document.getElementById("root") ?? document.body.appendChild(document.createElement("div"))).render(
  <StrictMode>
    <Section label="hold (recording)">
      <span className="flex items-center gap-2">
        <Mic size={13} className="text-sky-400" /> Recording… release to copy
      </span>
    </Section>
    <Section label="wake + partial">
      <span className="flex max-w-[420px] items-center gap-2 truncate">
        <ThinkingOrb state="listening" size={20} /> Play something calm
      </span>
    </Section>
    <Section label="wake detected">
      <span className="flex items-center gap-2 text-neutral-400">
        <ThinkingOrb state="listening" size={20} /> “Astra” — listening…
      </span>
    </Section>
    <Section label="idle (armed)">
      <span className="flex items-center gap-2 text-neutral-400">
        <Mic size={13} className="text-neutral-400" /> “Astra”
      </span>
    </Section>
  </StrictMode>,
);
