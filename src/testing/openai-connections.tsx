import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../state/store";
import { OpenAIConnections } from "../components/OpenAIConnections";
import { ModelPicker } from "../components/ModelPicker";
import { setLocale } from "../lib/i18n";
import { applySkin } from "../lib/skins";
import "../styles.css";

function Fixture() {
  const { state } = useStore();
  return <main className="min-h-screen bg-panel p-4 text-ink sm:p-6">
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-lg font-semibold">AI connections · isolated verification</h1>
      <p className="text-xs text-ink-secondary">Disposable workspace and local fake provider. No real credentials or paid calls.</p>
      <OpenAIConnections />
      {state.bots[0] && <ModelPicker bot={state.bots[0]} contained label={<span className="text-sm">Fixture bot model</span>} />}
    </div>
  </main>;
}
setLocale("en");
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><Fixture /></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
