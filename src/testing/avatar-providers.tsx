import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../state/store";
import { BotProfileAvatarCard } from "../components/BotProfileAvatarCard";
import { applySkin } from "../lib/skins";
import "../styles.css";

function Fixture() {
  const { state, dispatch } = useStore();
  const bot = state.bots[0];
  return <main className="min-h-screen bg-panel p-6 text-ink">
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 text-lg font-semibold">Avatar provider verification</h1>
      <p className="mb-4 break-all text-xs text-ink-secondary">Disposable data. Local test API: {new URLSearchParams(location.search).get("base")}</p>
      {bot ? <BotProfileAvatarCard bot={bot} activeState="idle" mascotMotion={null}
        onPatch={(patch) => dispatch({ type: "updateBot", botId: bot.id, patch })} /> : <p>Loading…</p>}
    </div>
  </main>;
}
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><Fixture /></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
