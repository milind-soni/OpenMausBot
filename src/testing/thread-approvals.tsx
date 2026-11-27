// The real chat/composer against the disposable approval smoke server.
import { createRoot } from "react-dom/client";
import { ChatView, ErrorRow } from "../components/ChatView";
import { DesktopCapabilitiesProvider } from "../components/DesktopCapabilities";
import { StoreProvider, useStore, type Bot } from "../state/store";
import { PermissionsSection } from "../components/bot-settings/PermissionsSection";
import { useBotSettingsDerived } from "../components/bot-settings/useBotSettingsDerived";
import { applySkin } from "../lib/skins";
import { setAnalyticsEnabled } from "../lib/analytics";
import "../styles.css";

function Permissions({ bot }: { bot: Bot }) {
  const derived = useBotSettingsDerived(bot);
  return <div className="mx-auto max-w-xl p-4"><PermissionsSection bot={bot} derived={derived} /></div>;
}
function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find(candidate => candidate.id === new URLSearchParams(location.search).get("bot"));
  if (new URLSearchParams(location.search).has("permissions")) return <>
    {state.error && <p role="alert">{state.error}</p>}
    {bot && <Permissions bot={bot} />}
  </>;
  return <div className="flex h-screen flex-col bg-app text-ink">
    {state.error && <p role="alert">{state.error}</p>}
    {!new URLSearchParams(location.search).has("model-switch") && <div className="p-4"><ErrorRow message="This task was blocked by our safety systems." onRetry={() => { throw new Error("Safety errors must not expose Retry"); }} /></div>}
    {bot && <div className="min-h-0 flex-1"><ChatView bot={bot} /></div>}
  </div>;
}
setAnalyticsEnabled(false);
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Fixture /></StoreProvider></DesktopCapabilitiesProvider>);
