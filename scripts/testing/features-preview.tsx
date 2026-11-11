import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../src/components/SettingsModal";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { StoreProvider, useStore } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import { setAdvancedMode } from "../../src/lib/interface-mode";
import "../../src/styles.css";

function Preview() {
  const { state, dispatch } = useStore();
  useEffect(() => { dispatch({ type: "toggleAppSettings", open: true, section: "skills" }); }, [dispatch]);
  return state.appSettingsOpen ? <SettingsModal /> : null;
}

setAdvancedMode(new URLSearchParams(location.search).has("advanced"));
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
