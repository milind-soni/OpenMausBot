import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WelcomeFlow } from "../../src/components/onboarding/WelcomeFlow";
import { SettingsModal } from "../../src/components/SettingsModal";
import { ModelPicker } from "../../src/components/ModelPicker";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { StoreProvider, useStore, type Bot } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Preview() {
  const { state, dispatch, refreshInstances } = useStore();
  const [onboarding, setOnboarding] = useState(false);
  const [picker, setPicker] = useState(false);
  const bot: Bot = { id: "preview", threadId: "preview", name: "Preview", title: "", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "codex", model: "fixture" }, messages: [] };
  useEffect(() => { dispatch({ type: "toggleAppSettings", open: true, section: "engines" }); }, [dispatch]);
  return <>
    <main className="p-8 text-ink-secondary">Isolated preview · sample engines, no real accounts</main>
    {picker && !onboarding && !state.appSettingsOpen && <div className="mx-auto mt-8 w-[380px] max-w-[calc(100vw-2rem)] text-ink"><ModelPicker bot={bot} contained /></div>}
    {onboarding ? <WelcomeFlow bot={null} initialBeat="engines" replay onDone={() => setOnboarding(false)} /> : state.appSettingsOpen && <SettingsModal />}
    <nav aria-label="Preview controls" className="fixed bottom-1 left-1/2 z-[100] flex max-w-full -translate-x-1/2 gap-1 overflow-x-auto rounded-lg border border-hairline bg-panel p-1 text-[11px] text-ink shadow-sm [&_button]:whitespace-nowrap [&_button]:rounded [&_button]:px-2 [&_button]:py-1 [&_button:hover]:bg-control">
      <button onClick={() => { setOnboarding(false); dispatch({ type: "toggleAppSettings", open: true, section: "engines" }); }}>Settings preview</button>
      <button onClick={() => { dispatch({ type: "toggleAppSettings", open: false }); setOnboarding(true); }}>Onboarding preview</button>
      <button onClick={() => applySkin("midnight")}>Dark</button>
      <button onClick={() => applySkin("atelier")}>Light</button>
      <button onClick={async () => { await fetch("/__fixture/connect", { method: "POST" }); await refreshInstances(); }}>Toggle sample connection</button>
      <button onClick={async () => { await fetch("/__fixture/clean", { method: "POST" }); await refreshInstances(); dispatch({ type: "toggleAppSettings", open: false }); setOnboarding(true); }}>Clean machine preview</button>
      <button onClick={async () => { await fetch("/__fixture/picker", { method: "POST" }); await refreshInstances(); dispatch({ type: "toggleAppSettings", open: false }); setOnboarding(false); setPicker(true); }}>Model picker preview</button>
    </nav>
  </>;
}
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
