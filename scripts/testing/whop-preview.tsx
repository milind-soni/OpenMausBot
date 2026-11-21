import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../../src/components/PluginsPanel";
import { StoreProvider } from "../../src/state/store";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><PluginsPanel /></StoreProvider>);
