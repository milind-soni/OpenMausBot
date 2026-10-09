import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectorCard } from "../../src/components/ConnectorCard";
import { PluginsPanel } from "../../src/components/PluginsPanel";
import { StoreProvider, useStore, type Message } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// Only the disposable OAuth recipe serves this entry; production components
// stay mounted, while these controls simulate a server card update/deletion.
function Preview() {
  const { state, dispatch } = useStore();
  const [target, setTarget] = useState(1);
  const [status, setStatus] = useState<"required" | "authorizing" | "failed">("required");
  const [showCard, setShowCard] = useState(true);
  const message: Message = {
    id: `connector-${target}`, role: "bot", kind: "connector", at: 1,
    connector: { slug: "gmail", label: "Gmail", description: "Synthetic mail account", status, resumeKey: "fixture" },
  };
  return <main className="mx-auto max-w-4xl space-y-6 p-8">
    <nav className="flex flex-wrap gap-4">
      <button onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })}>Settings Apps</button>
      <button onClick={() => setStatus("authorizing")}>Card authorizing</button>
      <button onClick={() => setStatus("failed")}>Card failed</button>
      <button onClick={() => { setTarget((current) => current + 1); setStatus("required"); setShowCard(true); }}>Replace card target</button>
      <button onClick={() => setShowCard(false)}>Remove card</button>
    </nav>
    {showCard && <ConnectorCard botId="fixture-bot" threadId={`thread-${target}`} message={message} />}
    {state.pluginsOpen && <PluginsPanel />}
  </main>;
}

setAnalyticsEnabled(false);
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Preview /></StoreProvider>);
