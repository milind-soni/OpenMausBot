// The real chat/composer against the disposable approval smoke server.
import { createRoot } from "react-dom/client";
import { ChatView, ErrorRow } from "../components/ChatView";
import { DesktopCapabilitiesProvider } from "../components/DesktopCapabilities";
import { StoreProvider, useStore } from "../state/store";
import { applySkin } from "../lib/skins";
import { setAnalyticsEnabled } from "../lib/analytics";
import "../styles.css";

function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find(candidate => candidate.id === new URLSearchParams(location.search).get("bot"));
  return <div className="flex h-screen flex-col bg-app text-ink">
    {state.error && <p role="alert">{state.error}</p>}
    <div className="p-4"><ErrorRow message="This task was blocked by our safety systems." onRetry={() => { throw new Error("Safety errors must not expose Retry"); }} /></div>
    {bot && <div className="min-h-0 flex-1"><ChatView bot={bot} /></div>}
  </div>;
}
setAnalyticsEnabled(false);
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Fixture /></StoreProvider></DesktopCapabilitiesProvider>);
