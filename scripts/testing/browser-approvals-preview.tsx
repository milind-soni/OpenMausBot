import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { PermissionsSection } from "../../src/components/bot-settings/PermissionsSection";
import { useBotSettingsDerived } from "../../src/components/bot-settings/useBotSettingsDerived";
import { StoreProvider, useStore, type Bot } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Permissions({ bot }: { bot: Bot }) {
  const derived = useBotSettingsDerived(bot);
  return <div className="overflow-auto p-6"><PermissionsSection bot={bot} derived={derived} /></div>;
}
function Preview() {
  const { state } = useStore();
  const [permissions, setPermissions] = useState(false);
  const bot = state.bots[0];
  return <main className="flex h-screen flex-col bg-panel text-ink">
    <nav><button onClick={() => setPermissions(value => !value)}>{permissions ? "Show conversation" : "Show bot permissions"}</button></nav>
    {bot && (permissions ? <Permissions bot={bot} /> : <ChatView bot={bot} />)}
  </main>;
}
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
